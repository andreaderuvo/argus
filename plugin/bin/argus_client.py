#!/usr/bin/env python3
"""Talking to Argus from Python, in one file with nothing to install.

    from argus_client import Argus

    a = Argus()                                    # reads ~/.config/argus/config.yaml
    a.who()                                        # who is here, who is waiting for a person
    a.launch("Claude Code", "fix", where=repo, prompt=brief, worktree="fix/42")
    a.relay("reviewer", "the diff is on main — tell me what is wrong with it", run=True)
    for bell in a.bells(until=time.monotonic() + 600):
        ...

Also a command, so an agent in a session needs no token and no Python:

    python3 -m argus_client who
    python3 -m argus_client relay reviewer "look at the diff" --run
    python3 -m argus_client ring "stuck on the credentials"

## Why this exists, given that it is HTTP

Wrapping `POST /api/…` is not worth a file. What is worth a file is the handful of things that
are *not obvious*, each of which cost an afternoon:

- **A heartbeat is not a bell.** The event stream sends one every twenty-five seconds and never
  ends, so a deadline checked between events is never checked at all — an orchestrator asked to
  wait one minute waited three. `bells(until=…)` checks the clock on every line, inside the
  reader.
- **A flat socket timeout overshoots.** Forty seconds of patience when ten remain is thirty
  seconds late. The timeout tracks what is left.
- **429 is not an error, it is a brake.** Twelve launches a minute and thirty relays; hitting
  one raises `TooFast`, which names the config key that raises it, so a fan-out of twenty tells
  you what to change instead of half-starting.
- **The token is a decision.** An agent key can do a short list of things and a master key can do
  everything; this prefers the narrow one, and reads both out of the config rather than being
  handed a secret it could look up anyway.

## Why it is not on PyPI

Because the README says config keys and API shapes can change between commits, and that is
true. Publishing `argus-client 0.1` promises a surface this project cannot hold still yet, and
the first thing a broken promise breaks is somebody else's script. When the API settles, this
same file becomes a package with twenty lines of `pyproject.toml` — nothing here changes.

Standard library only, and deliberately copyable: take it, do not depend on it.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

__all__ = ["Argus", "ArgusError", "TooFast", "config_path", "credentials", "own_session"]


class ArgusError(RuntimeError):
    """Something Argus refused, with its own words. `status` is the HTTP code."""

    def __init__(self, status: int, said: str, where: str = "") -> None:
        super().__init__(f"argus said {status} for {where}: {said}" if where else said)
        self.status = status
        self.said = said


class TooFast(ArgusError):
    """A brake, not a failure: too many launches or relays in a minute.

    Its own class because the answer is different — a caller doing a deliberate fan-out wants to
    wait or to raise the cap, not to give up the way it would on a 400.
    """


def _loopback_tls(base: str):
    """No certificate check for an https Argus on this machine: its certificate names the public
    host, not 127.0.0.1, and nothing leaves the machine. Anything else is checked as usual."""
    if not base.startswith("https://"):
        return None
    host = base.split("://", 1)[1].split("/", 1)[0].rsplit(":", 1)[0].strip("[]")
    if host in ("127.0.0.1", "localhost", "::1"):
        import ssl
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        return ctx
    return None


def own_session() -> str:
    """The tmux session this program runs in: `$ARGUS_SESSION`, else asked of tmux for this pane.
    Outside tmux, "" — and a call that needs it says so. (`display-message` only: it reads the
    pane's name, never its text.)"""
    if os.environ.get("ARGUS_SESSION"):
        return os.environ["ARGUS_SESSION"]
    pane = os.environ.get("TMUX_PANE")
    if not pane:
        return ""
    import subprocess
    try:
        done = subprocess.run(["tmux", "display-message", "-p", "-t", pane, "#S"], capture_output=True, text=True, timeout=3)
        return done.stdout.strip() if done.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError):
        return ""


def config_path() -> Path:
    """Where the configuration is looked for.

    `$ARGUS_CONFIG` wins, which is how a script is pointed at a second Argus on the same
    machine — a demo instance on its own socket, say, without touching the real one.
    """
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path(os.environ.get("HOME") or "/") / ".config"
    return Path(os.environ.get("ARGUS_CONFIG") or root / "argus" / "config.yaml")


def credentials() -> tuple[str, str]:
    """Where Argus is and a key for it, read out of the config with three regexes.

    Not a YAML parser: this file's whole promise is that it runs wherever Argus does with
    nothing installed, and `listen` plus two `token`s do not justify a dependency.

    The agent key wins when there is one. It can read what is happening, ring, relay a sentence
    and start something from the launcher list — and cannot touch a file, kill a session, expose
    a port, mint a token or stop the server. A script that only needs those things should
    hold the key that only does them.
    """
    text = config_path().read_text(encoding="utf-8")
    listen, master, agent, section, cert = "127.0.0.1:8080", None, None, None, ""
    for line in text.splitlines():
        bare = line.strip()
        if not bare or bare.startswith("#"):
            continue
        if not line.startswith((" ", "\t", "-")):
            section = bare.split(":")[0]
        if section == "listen" and bare.startswith("listen:"):
            listen = bare.split(":", 1)[1].strip().strip("\"'")
        elif section == "token" and bare.startswith("token:"):
            master = bare.split(":", 1)[1].strip().strip("\"'")
        elif section == "agents" and "token:" in bare and not agent:
            agent = bare.split("token:", 1)[1].strip().strip("\"'")
        elif section == "tls_cert" and bare.startswith("tls_cert:"):
            cert = bare.split(":", 1)[1].strip().strip("\"'")
    # What it *listens* on is not always an address to call: 0.0.0.0 is not somewhere you
    # connect to, and loopback always reaches a server on this machine.
    where = listen.replace("0.0.0.0", "127.0.0.1").replace("[::]", "127.0.0.1")
    # With a certificate it answers https only — on loopback too.
    scheme = "https" if cert and cert not in ("null", "~") else "http"
    key = os.environ.get("ARGUS_TOKEN") or agent or master
    if not key:
        raise ArgusError(0, f"no token in {config_path()} — is this the machine Argus runs on?")
    return f"{scheme}://{where}", key


class Argus:
    """One machine's Argus. Everything below is one HTTP call unless it says otherwise."""

    def __init__(self, base: str | None = None, token: str | None = None) -> None:
        if base and token:
            self.base, self.token = base.rstrip("/"), token
        else:
            found, key = credentials()
            self.base, self.token = (base or found).rstrip("/"), token or key

    # ---------------------------------------------------------------- the wire

    def me(self, session: str = "") -> str:
        """The tmux session this program runs in: `session` if given, else `own_session()` (the
        environment, tmux), else asked of Argus by pid — for a program started with a bare
        environment, as Codex starts its MCP servers, which cannot ask tmux. Remembered."""
        if session:
            return session
        if getattr(self, "_me", None) is None:
            mine = own_session()
            if not mine:
                try:
                    mine = self.call("GET", f"/api/tmux/whoami?pid={os.getpid()}", timeout=5).get("session") or ""
                except ArgusError:
                    mine = ""
            self._me = mine
        return self._me

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        """Any route at all, with the token attached and the error unwrapped.

        The escape hatch, and the reason it is fair to say nothing is hidden behind the methods
        below: they are conveniences over this, and a route none of them covers is one call
        away. A refusal comes back as `ArgusError` carrying Argus's own sentence rather than
        as an HTML error page, and a 429 as `TooFast`, because a brake is not a failure.
        """
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "authorization": f"Bearer {self.token}",
            **({"content-type": "application/json"} if data else {}),
        })
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=_loopback_tls(self.base)) as answer:
                raw = answer.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            said = e.read().decode(errors="replace")
            try:
                said = json.loads(said).get("error", said)
            except ValueError:
                pass
            if e.code == 429:
                raise TooFast(e.code, said, f"{method} {path}") from None
            raise ArgusError(e.code, said, f"{method} {path}") from None
        except OSError as e:
            raise ArgusError(0, f"could not reach {self.base}: {e}") from None

    # --------------------------------------------------------------- the verbs

    def who(self) -> dict:
        """Sessions, who is in each, in which folder, and which are waiting for a person."""
        return self.call("GET", "/api/who")

    def sessions(self) -> list[dict]:
        """Just the sessions, when `who()` is more than you need — no folders, no agents, no
        working out who is waiting."""
        return self.call("GET", "/api/tmux/sessions")

    def launchers(self, versions: bool = False) -> list[dict]:
        """What this machine can start, and whether each is really here."""
        return self.call("GET", f"/api/launchers{'?versions=1' if versions else ''}")["launchers"]

    def launch(self, launcher: str, name: str, where: str | Path = ".", prompt: str = "",
               run: bool = False, worktree: str | None = None, wait: bool = True,
               wait_seconds: float | None = None, desk: bool | str = False, options: dict | None = None) -> dict:
        """Start something, optionally in a fresh git worktree, with its first instruction.

        `run=False` types the prompt in and leaves the return to a person, which is the right
        default: the answer says whether the launcher had settled, and a prompt typed into
        something still drawing its banner is the failure this is designed around.

        `desk=True` also puts a window on the desk of whoever has the app open, the moment it
        starts, rather than leaving you to go and find it in the session list. It reaches only
        pages that are open right now; nothing is queued for later. `desk="pippo"` puts it in
        the desk of that name instead, made if there is none (see `desk()`).

        `options` are the agent's options by name, as the New session box offers them —
        `{"permissions": "edits", "model": "sonnet", "effort": "high"}` — and become the flags
        this agent's own version takes. What a launcher offers is in `launchers()`. An agent's
        key cannot choose "everything, no questions": that one is the person's.
        """
        where = str(where)
        if worktree:
            where = self.worktree(where, worktree)["path"]
        body = {"launcher": launcher, "name": name, "path": where,
                "prompt": prompt, "run": run, "wait": wait, "desk": desk}
        if wait_seconds is not None:
            body["wait_seconds"] = wait_seconds
        if options:
            body["options"] = options
        # Long, because the call holds while the launcher settles.
        return self.call("POST", "/api/tmux/launch", body, timeout=120)

    def relay(self, to: str, text: str, run: bool = False) -> dict:
        """Type a sentence into a session that is already running — what dragging a prompt onto
        a terminal does, offered to a program."""
        return self.call("POST", "/api/relay", {"to": to, "text": text, "run": run})

    def ring(self, text: str = "", why: str = "asking", session: str = "") -> dict:
        """Call the person. `asking` waits for one; `done` and `failed` only report."""
        return self.call("POST", "/api/bell",
                         {"why": why, "text": text, "session": session or os.environ.get("ARGUS_SESSION", "")})

    def ask(self, text: str, options: list[str] | None = None, wait: float = 300,
            session: str = "", patience: float = 6 * 3600) -> str | None:
        """Ask the person a question and wait for the answer. Returns what they said, or None.

        The one thing you cannot do for yourself, and the reason it is worth stopping for: the
        alternative is guessing, or printing the question into a pane and hoping somebody is
        looking at that pane.

            if argus.ask("4 isolates are missing too many loci. Drop them?",
                         ["drop", "keep", "stop"]) == "drop":

        `options` makes answering a tap, which is most of the point — on a phone, "shall I
        overwrite it" should not cost a keyboard. Without them the person gets a box.

        One HTTP call cannot be held open for hours, so this asks and then keeps coming back
        for the same question until `patience` runs out. None means nobody answered: decide
        for yourself, or stop and say why — a job that hangs for ever is worse than one that
        stopped with a reason.
        """
        asked = self.call("POST", "/api/ask", {
            "text": text, "options": options or [], "wait": min(wait, 300),
            "session": session or os.environ.get("ARGUS_SESSION", ""),
        }, timeout=min(wait, 300) + 30)
        if asked.get("answered"):
            return asked.get("answer")

        ident = asked["id"]
        until = time.time() + patience
        while time.time() < until:
            left = min(300.0, until - time.time())
            said = self.call("GET", f"/api/ask/{ident}?wait={left:.0f}", timeout=left + 30)
            if said.get("answered"):
                return said.get("answer")
        return None

    def worktree(self, repo: str | Path, branch: str, to: str | Path | None = None) -> dict:
        """A second checkout of `repo`, on its own branch: how two agents work on one
        repository without editing each other's files.

        Refuses a path that already exists rather than joining whatever is there, and there is
        no counterpart that removes one — deleting a checkout deletes work, and this is not the
        thing that should be able to.
        """
        body = {"path": str(repo), "branch": branch}
        if to:
            body["to"] = str(to)
        return self.call("POST", "/api/git/worktree", body)

    def worktrees(self, path: str | Path) -> dict:
        """The repository that path belongs to, and every checkout of it — including the ones
        an orchestration left behind, which is usually why you are asking."""
        from urllib.parse import quote
        return self.call("GET", f"/api/git/worktrees?path={quote(str(path))}")

    def desk(self, name: str, folder: str | Path | None = None, show: bool = True, rename: str | None = None,
             session: str | None = None) -> dict:
        """The desk called `name` — made empty if there is none — and, with `show`, switched to in
        every open page. `folder` is where its browsers and new sessions start. `rename="Desk 11"`
        instead gives that desk the name `name`, on every open page too. Returns
        `{id, name, made, folder}`. Nothing here removes a desk or what is in it. `session` also puts
        a window on that (existing) session in the desk."""
        body = {"name": name, "show": show}
        if session:
            body["session"] = session
        if rename:
            body["rename"] = rename
        if folder:
            body["folder"] = str(folder)
        return self.call("POST", "/api/desks", body)

    def close_gone(self, desk: str = "") -> dict:
        """Close the windows whose session has ended — on every desk, or the one named. Only
        windows: the sessions are already gone. `{closed: {desk: [names]}}`."""
        return self.call("POST", "/api/desks/gone", {"desk": desk} if desk else {})

    def actions(self) -> list[dict]:
        """What this key cannot do but may *request*: `{action, what, asks}` each — `asks` false when
        the person lets that one be done without asking (`agents_without_asking`)."""
        return self.call("GET", "/api/agent/actions")["actions"]

    def request(self, action: str, args: dict | None = None, why: str = "", wait: float = 300,
                session: str = "") -> dict:
        """Ask the person to have something done that this key cannot do — start a team in a desk,
        end a session, start an agent with no questions… (`actions()`). They get Do it / No; on Do
        it Argus does it. Waits up to `wait` seconds and returns `{id, state, text, result?, error?}`
        with state done, refused, failed — or still asked/doing, to come back for with
        `request_status(id)`. ArgusError (400) when it cannot be done as asked."""
        said = self.call("POST", "/api/agent/request", {"action": action, "args": args or {}, "why": why,
                                                        "session": self.me(session), "wait": min(wait, 300)},
                         timeout=min(wait, 300) + 30)
        until = time.time() + wait
        while said["state"] in ("asked", "doing") and time.time() < until:
            left = min(300.0, until - time.time())
            said = self.request_status(said["id"], left)
        return said

    def request_status(self, ident: str, wait: float = 0) -> dict:
        """Where a request stands: asked, doing, done, refused, failed or unanswered."""
        return self.call("GET", f"/api/agent/request/{ident}?wait={wait:.0f}", timeout=wait + 30)

    def team_task(self, session: str = "") -> dict:
        """This agent's task in its team — goal, role, duty, round, whether it is its turn, what the
        steps before it said last, the last check — for the session it runs in (found from tmux)."""
        from urllib.parse import quote
        return self.call("GET", f"/api/teams/task?session={quote(self.me(session))}")

    def team_done(self, summary: str, status: str = "", details: str = "", session: str = "") -> dict:
        """Report this agent's turn: a few lines of what it did, and — for a judge — OK, REDO, DONE or
        BLOCKED. Argus checks it and writes it into the team's log; refused (ArgusError) when it is
        not this agent's turn, it has already reported, or a judge left the status out."""
        return self.call("POST", "/api/teams/done", {"session": self.me(session), "summary": summary,
                                                     "status": status, "details": details})

    def team_check(self, text: str) -> dict:
        """Check a team written as text — a Mermaid flowchart or YAML — before proposing it.
        `{ok: True, format, name, summary, warnings, graph}`, or `{ok: False, error}` naming the line;
        `warnings` are arrows that can never fire, keys Argus does not read, a team nothing ends. Starts
        nothing; the syntax is in the `argus-team-author` skill and on the wiki's Teams page."""
        return self.call("POST", "/api/teams/check", {"text": text})

    def team_propose(self, text: str, folder: str | Path, session: str = "") -> dict:
        """Propose a team to the person: checked, written as `<folder>/team.yaml`, and a bell —
        tapped, it opens Team on that folder with the team chosen. Starting it is theirs.
        ArgusError (400) when it is not a team, (409) when the folder has a team.yaml of theirs."""
        return self.call("POST", "/api/teams/propose", {"text": text, "folder": str(folder),
                                                        "session": self.me(session)})

    def todos(self) -> list[dict]:
        """The to-do list kept in Argus: `{n, note, status, by, ...}` each, newest first. `n` is the
        number shown beside it ("#3"), given once and never reused."""
        return self.call("GET", "/api/todo").get("items") or []

    def todo(self, note: str | None = None, ident: str | int | None = None, status: str | None = None,
             by: str = "") -> dict:
        """Add a to-do (`note` alone), or change one: `ident` is its number (3, "#3") or id,
        `status` one of open, doing, done. `by` signs the change with your session, which the
        list shows ("done by pippo-claude"). There is no removing one from here."""
        if ident is None:
            return self.call("POST", "/api/todo", {"note": note or ""})
        body: dict = {"by": by or os.environ.get("ARGUS_SESSION", "")}
        if note is not None:
            body["note"] = note
        if status is not None:
            body["status"] = status
        from urllib.parse import quote
        return self.call("PATCH", f"/api/todo/{quote(str(ident))}", body)

    def teams(self) -> list[dict]:
        """The teams on this machine: goal, round, status, and each step's state and outcome.
        Read only — starting, pausing and stopping one is the person's."""
        return self.call("GET", "/api/teams").get("teams") or []

    def prefs(self) -> dict:
        """What the browser remembers, as the machine has it: the desks, the windows, and — the
        reason a script wants this — the prompt library and the placeholder sets."""
        return self.call("GET", "/api/prefs")

    def prompts(self) -> list[dict]:
        """The prompt library, straight out of the preferences, or [] if nothing has synced."""
        return self.prefs().get("prefs", {}).get("templates") or []

    # -------------------------------------------------------------- the stream

    def bells(self, until: float, since: int = 0):
        """Bells as they ring, over one open connection, until `until` (a monotonic time).

        The deadline is checked here, on every line, and that is the whole reason this takes
        one: the stream sends a heartbeat every twenty-five seconds and never ends, so a caller
        that checks the clock between yields never gets the chance and spins inside this
        generator instead. It can still overshoot by up to one heartbeat, which for "how long to
        wait for an agent" is noise.
        """
        request = urllib.request.Request(f"{self.base}/api/bells/stream?since={since}",
                                         headers={"authorization": f"Bearer {self.token}"})
        left = max(2.0, min(40.0, until - time.monotonic()))
        try:
            with urllib.request.urlopen(request, timeout=left, context=_loopback_tls(self.base)) as stream:
                for raw in stream:
                    if time.monotonic() >= until:
                        return
                    line = raw.decode(errors="replace").strip()
                    if line.startswith("data:"):
                        said = line[5:].strip()
                        if said:
                            yield json.loads(said)
        except (TimeoutError, urllib.error.URLError, OSError):
            return          # the stream ended or went quiet; the caller decides what next

    def wait_for(self, paths, until: float, on_bell=None) -> tuple[list[Path], list[Path]]:
        """Wait for files to appear, woken by bells. Returns (arrived, missing).

        The bell is the signal and the file is the fact: an agent that writes its result and
        forgets to ring is not a failure, and one that rings without writing has not finished.
        Every serious pattern here ends up needing exactly this, which is why it is in the
        library rather than in each example.
        """
        waiting = [Path(p) for p in paths]
        got: list[Path] = []

        def collect() -> None:
            for one in list(waiting):
                if one.exists() and one.stat().st_size:
                    waiting.remove(one)
                    got.append(one)

        collect()
        since = 0
        while waiting and time.monotonic() < until:
            for bell in self.bells(until=until, since=since):
                since = max(since, int(bell.get("seq", 0)))
                if on_bell:
                    on_bell(bell)
                collect()
                if not waiting:
                    break
            collect()
        return got, waiting


# ------------------------------------------------------------------------ cli

def main(argv: list[str] | None = None) -> int:
    """The command line: `who`, `relay`, `ring`, `start`, `teams`, `task`, `turn`, `team-check`,
    `team-propose`, `request`, `close-gone`.

    Eleven verbs and no more, because this is what an *agent* reaches for from inside a session:
    the other agents, its team, and what it may only request. Anything larger is a script, and a
    script should import the class.
    """
    import argparse

    ap = argparse.ArgumentParser(prog="argus_client", description=__doc__.split("##")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = ap.add_subparsers(dest="what", required=True)

    w = subs.add_parser("who", help="who else is on this machine, and who is waiting")
    w.add_argument("--json", action="store_true", help="the whole answer, unformatted")

    r = subs.add_parser("relay", help="hand a sentence to another session")
    r.add_argument("to")
    r.add_argument("text", nargs="?", default="")
    r.add_argument("--file", help="read what to say from a file instead")
    r.add_argument("--run", action="store_true", help="press return for them too")

    b = subs.add_parser("ring", help="call the person")
    b.add_argument("text", nargs="?", default="")
    b.add_argument("--why", default="asking", choices=["asking", "done", "failed"])
    b.add_argument("--session", default="")

    s = subs.add_parser("start", help="start something from the launcher list")
    s.add_argument("launcher")
    s.add_argument("--name", required=True)
    s.add_argument("--in", dest="where", default=os.getcwd())
    s.add_argument("--prompt", default="")
    s.add_argument("--run", action="store_true")
    s.add_argument("--worktree", metavar="BRANCH")
    s.add_argument("--option", action="append", default=[], metavar="NAME=VALUE",
                   help="an agent option by name, as `launchers` lists them: permissions=edits, "
                        "model=sonnet, effort=high, continue=true; repeat for more")
    s.add_argument("--desk", action="store_true",
                   help="also put a window for it on the desk, in whatever browser has Argus "
                        "open right now")

    subs.add_parser("teams", help="the teams Argus is directing here, and whose turn it is")
    subs.add_parser("task", help="your task in your team: goal, duty, whose turn, what came before")
    tu = subs.add_parser("turn", help="report your turn in your team")
    tu.add_argument("summary", nargs="?", default="")
    tu.add_argument("--status", default="", help="for a judge: OK, REDO, DONE or BLOCKED")
    tu.add_argument("--file", help="the details, read from a file")
    cg = subs.add_parser("close-gone", help="close the windows whose session has ended (every desk, or --desk NAME)")
    cg.add_argument("--desk", default="")
    rq = subs.add_parser("request", help="ask the person to have something done this key cannot do (they tap Do it / No)")
    rq.add_argument("action", help="start_team, team_go, team_pause, team_stop, kill_session, rename_session, "
                                   "start_agent, remove_worktree, todo_delete")
    rq.add_argument("args", nargs="*", metavar="KEY=VALUE", help="e.g. team=\"Kraken paper\" desk=Trading")
    rq.add_argument("--why", default="")
    rq.add_argument("--wait", type=float, default=300)
    tc = subs.add_parser("team-check", help="check a team you wrote (Mermaid or YAML), from a file or stdin")
    tc.add_argument("file", nargs="?", default="-")
    tp = subs.add_parser("team-propose", help="propose a team to the person: written as team.yaml in a folder, for them to start")
    tp.add_argument("file", nargs="?", default="-")
    tp.add_argument("--in", dest="folder", default=os.getcwd(), help="the folder the team is for (default: here)")

    args = ap.parse_args(argv)
    try:
        argus = Argus()
        if args.what == "who":
            said = argus.who()
            if args.json:
                print(json.dumps(said, indent=1))
                return 0
            print(said.get("machine", "?"))
            for one in said.get("sessions", []):
                marks = [one["state"]] if one.get("state") else []
                if one.get("wants_you"):
                    marks.append("WAITING FOR A PERSON")
                if one.get("attached"):
                    marks.append("attached")
                who = " · ".join(x for x in (one.get("agent"), one.get("model")) if x)
                print(f"  {one['name']:20} {who or 'no agent declared':34} {one.get('folder') or ''}"
                      + (f"   [{', '.join(marks)}]" if marks else ""))
            if said.get("launchers"):
                print("  can start: " + ", ".join(said["launchers"]))
        elif args.what == "relay":
            text = Path(args.file).read_text(encoding="utf-8") if args.file else args.text
            if not text:
                return int(bool(sys.stderr.write("nothing to say: give some text, or --file\n")))
            said = argus.relay(args.to, text, args.run)
            print(f"{said['characters']} characters to {said['to']}"
                  + (" and the return pressed" if said.get("sent") else " — waiting for their return"))
        elif args.what == "teams":
            for team in argus.teams():
                print(f"{team['name']}: {team.get('status')}, round {team.get('round')} of {team.get('max_rounds')} — {team.get('goal', '')}")
                for n in team.get("nodes", []):
                    if n.get("kind") in ("agent", "check"):
                        print(f"  {n['id']:14} {n.get('state', ''):8} {n.get('outcome') or ''}")
        elif args.what == "task":
            said = argus.team_task()
            if said.get("none"):
                print(said.get("why", "no team here"))
                return 1
            print(json.dumps(said, indent=1, ensure_ascii=False))
        elif args.what == "turn":
            details = Path(args.file).read_text(encoding="utf-8") if args.file else ""
            said = argus.team_done(args.summary, args.status, details)
            print(f"recorded: {said['you']} in {said['team']}, round {said['round']}" + (f", {said['status']}" if said.get("status") else ""))
        elif args.what == "close-gone":
            said = argus.close_gone(args.desk).get("closed") or {}
            print("; ".join(f"{d}: {', '.join(n)}" for d, n in said.items()) or "no window of an ended session")
        elif args.what == "request":
            pairs = {}
            for pair in args.args:
                key, _, value = pair.partition("=")
                pairs[key.strip()] = True if value.strip().lower() in ("true", "yes") else value.strip()
            said = argus.request(args.action, pairs, args.why, args.wait)
            print(f"{said['state']}: {said['text']}" + (f" — {said['error']}" if said.get("error") else ""))
            return 0 if said["state"] == "done" else 1
        elif args.what in ("team-check", "team-propose"):
            text = sys.stdin.read() if args.file == "-" else Path(args.file).read_text(encoding="utf-8")
            if args.what == "team-check":
                said = argus.team_check(text)
                if not said["ok"]:
                    print(said["error"])
                    return 1
                print(f"ok: {said['name']} — {said['summary']}")
                for w in said.get("warnings") or []:
                    print(f"  warning: {w}")
            else:
                said = argus.team_propose(text, args.folder)
                print(f"proposed: {said['name']} in {said['file']} — the person starts it from Team")
        elif args.what == "ring":
            argus.ring(args.text, args.why, args.session)
            print("rung")
        elif args.what == "start":
            options = {}
            for pair in args.option:
                key, _, value = pair.partition("=")
                options[key.strip()] = True if value.strip().lower() in ("true", "yes", "on") else value.strip()
            said = argus.launch(args.launcher, args.name, args.where, args.prompt,
                                run=args.run, worktree=args.worktree, desk=args.desk, options=options or None)
            print(f"{said['name']} started"
                  + (", and the prompt is on its way" if said.get("sent")
                     else " — the prompt is typed in, waiting for a return" if said.get("seeded") else ""))
    except ArgusError as e:
        sys.stderr.write(f"{e}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

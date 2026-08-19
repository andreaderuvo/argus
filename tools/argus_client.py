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
- **The token is a decision.** An agent key can do five things and a master key can do
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

__all__ = ["Argus", "ArgusError", "TooFast", "config_path", "credentials"]


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


def config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path(os.environ.get("HOME") or "/") / ".config"
    return Path(os.environ.get("ARGUS_CONFIG") or root / "argus" / "config.yaml")


def credentials() -> tuple[str, str]:
    """Where Argus is and a key for it, read out of the config with three regexes.

    Not a YAML parser: this file's whole promise is that it runs wherever Argus does with
    nothing installed, and `listen` plus two `token`s do not justify a dependency.

    The agent key wins when there is one. It can read what is happening, ring, relay a sentence
    and start something from the launcher list — and cannot touch a file, kill a session, expose
    a port, mint a token or stop the server. A script that only needs those five things should
    hold the key that only does them.
    """
    text = config_path().read_text(encoding="utf-8")
    listen, master, agent, section = "127.0.0.1:8090", None, None, None
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
    # What it *listens* on is not always an address to call: 0.0.0.0 is not somewhere you
    # connect to, and loopback always reaches a server on this machine.
    where = listen.replace("0.0.0.0", "127.0.0.1")
    key = os.environ.get("ARGUS_TOKEN") or agent or master
    if not key:
        raise ArgusError(0, f"no token in {config_path()} — is this the machine Argus runs on?")
    return f"http://{where}", key


class Argus:
    """One machine's Argus. Everything below is one HTTP call unless it says otherwise."""

    def __init__(self, base: str | None = None, token: str | None = None) -> None:
        if base and token:
            self.base, self.token = base.rstrip("/"), token
        else:
            found, key = credentials()
            self.base, self.token = (base or found).rstrip("/"), token or key

    # ---------------------------------------------------------------- the wire

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "authorization": f"Bearer {self.token}",
            **({"content-type": "application/json"} if data else {}),
        })
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
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
        return self.call("GET", "/api/tmux/sessions")

    def launchers(self, versions: bool = False) -> list[dict]:
        """What this machine can start, and whether each is really here."""
        return self.call("GET", f"/api/launchers{'?versions=1' if versions else ''}")["launchers"]

    def launch(self, launcher: str, name: str, where: str | Path = ".", prompt: str = "",
               run: bool = False, worktree: str | None = None, wait: bool = True,
               wait_seconds: float | None = None) -> dict:
        """Start something, optionally in a fresh git worktree, with its first instruction.

        `run=False` types the prompt in and leaves the return to a person, which is the right
        default: the answer says whether the launcher had settled, and a prompt typed into
        something still drawing its banner is the failure this is designed around.
        """
        where = str(where)
        if worktree:
            where = self.worktree(where, worktree)["path"]
        body = {"launcher": launcher, "name": name, "path": where,
                "prompt": prompt, "run": run, "wait": wait}
        if wait_seconds is not None:
            body["wait_seconds"] = wait_seconds
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

    def worktree(self, repo: str | Path, branch: str, to: str | Path | None = None) -> dict:
        body = {"path": str(repo), "branch": branch}
        if to:
            body["to"] = str(to)
        return self.call("POST", "/api/git/worktree", body)

    def worktrees(self, path: str | Path) -> dict:
        from urllib.parse import quote
        return self.call("GET", f"/api/git/worktrees?path={quote(str(path))}")

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
            with urllib.request.urlopen(request, timeout=left) as stream:
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
                marks = ["WAITING FOR A PERSON"] if one.get("wants_you") else []
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
        elif args.what == "ring":
            argus.ring(args.text, args.why, args.session)
            print("rung")
        elif args.what == "start":
            said = argus.launch(args.launcher, args.name, args.where, args.prompt,
                                run=args.run, worktree=args.worktree)
            print(f"{said['name']} started"
                  + (", and the prompt is on its way" if said.get("sent")
                     else " — the prompt is typed in, waiting for a return" if said.get("seeded") else ""))
    except ArgusError as e:
        sys.stderr.write(f"{e}\n")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

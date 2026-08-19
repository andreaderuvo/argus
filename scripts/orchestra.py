#!/usr/bin/env python3
"""Three agents try three things, and a fourth says which won.

This is a worked example, not a feature. Argus does not ship an orchestrator and is not going
to: what it ships is the substrate one is made of — start a thing, see who is there, hand a
sentence over, ring a person — and this file is two hundred lines showing that the substrate is
enough. Copy it and change the middle.

    python3 scripts/orchestra.py --repo ~/work/api \\
        --try "a cache in front of the query" \\
        --try "an index on the join column" \\
        --try "rewriting it as one query"

What happens:

  1. a git worktree per idea, each on its own branch, so three agents never edit one checkout
  2. an agent in each, with the idea as its first instruction and a contract in the prompt:
     *write RESULT.md, then ring* — because the one thing this cannot do is read their answers
  3. the orchestrator waits on the bell stream, which is an open connection rather than polling
  4. a judge, started in the repository itself, given the three paths to compare

Three constraints shaped every line of it, and they are worth reading before you write your own.

**You cannot read what an agent said.** Argus can type into a session; it cannot read one back.
Reading a pane means `capture-pane`, which is both scraping a text user interface and — on at
least one machine this was tested against — a way to take the whole tmux server down. So
coordination goes through the filesystem: the agents write files, the orchestrator reads files.
Every serious pattern here ends up in the same place, which is why Argus's two-agent recipes
have always used a bridge file.

**There is no implicit "finished".** An agent is done when it says so. That has to be in the
prompt — *when you have finished, write X and ring* — and the contract is the orchestrator's
half of the work. `--why done` rings without asking for a person; `--why asking` is for when it
needs you, and this script tells you about those rather than swallowing them.

**Nothing here retries, supervises or recovers.** If an agent wanders off, the timeout fires and
you are told which one. A real supervisor is yours to write, and it would be another hundred
lines of the same kind.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

RESULT = "RESULT.md"


# --------------------------------------------------------------- talking to argus

def config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else Path(os.environ.get("HOME") or "/") / ".config"
    return Path(os.environ.get("ARGUS_CONFIG") or root / "argus" / "config.yaml")


def credentials() -> tuple[str, str]:
    """Where Argus is, and a key for it — the agent one if there is one.

    The same three regexes `tools/argus-say` uses, and for the same reason: a YAML parser would
    be a dependency for reading two lines out of a file that this machine already has.
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
    where = listen.replace("0.0.0.0", "127.0.0.1")
    key = os.environ.get("ARGUS_TOKEN") or agent or master
    if not key:
        sys.exit(f"no token in {config_path()}")
    return f"http://{where}", key


class Argus:
    def __init__(self) -> None:
        self.base, self.token = credentials()

    def call(self, method: str, path: str, body: dict | None = None, timeout: float = 60) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "authorization": f"Bearer {self.token}",
            **({"content-type": "application/json"} if data else {}),
        })
        try:
            with urllib.request.urlopen(request, timeout=timeout) as answer:
                return json.loads(answer.read() or "{}")
        except urllib.error.HTTPError as e:
            sys.exit(f"argus said {e.code} for {method} {path}: {e.read().decode(errors='replace')[:300]}")

    def bells(self, since: int, until: float):
        """Bells as they ring, over one open connection, until `until` (a monotonic time).

        Polling would work and would be worse: a stream is how you find out in the second it
        happens rather than in the next sweep, and the whole point of an orchestrator is that
        nobody is watching.

        The deadline is checked **here**, on every line, and that is the whole reason this
        function takes one. The stream sends a heartbeat every twenty-five seconds and a
        heartbeat is not a bell — so a caller that checks the clock between yields never gets
        the chance, and the loop it thought it was driving spins inside this generator instead.
        Measured: an orchestrator asked to wait one minute was still waiting after three, with
        nothing wrong anywhere else.

        It can still overshoot by up to one heartbeat, because the check happens when a line
        arrives and the quietest the stream ever goes is twenty-five seconds. For "how long to
        wait for an agent" that is noise; the alternative is a reader thread and a queue, which
        is more machinery than an example should carry.
        """
        request = urllib.request.Request(f"{self.base}/api/bells/stream?since={since}",
                                         headers={"authorization": f"Bearer {self.token}"})
        # A socket timeout as well, for the case where even the heartbeat stops: a stream that
        # has silently died must not hold the whole thing open until the process is killed.
        # The socket timeout tracks the deadline rather than being a flat number: a read that
        # blocks for forty seconds when the caller has ten left overshoots by thirty, which is
        # what the first run of this did.
        with urllib.request.urlopen(request, timeout=max(2.0, min(40.0, until - time.monotonic()))) as stream:
            for raw in stream:
                if time.monotonic() >= until:
                    return
                line = raw.decode(errors="replace").strip()
                if line.startswith("data:"):
                    with_it = line[5:].strip()
                    if with_it:
                        yield json.loads(with_it)


# --------------------------------------------------------------------- the shape

def slug(text: str, n: int = 24) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n] or "idea"


def fan_out(argus: Argus, repo: Path, launcher: str, ideas: list[str], run: bool) -> list[dict]:
    """One worktree and one agent per idea."""
    started = []
    for idea in ideas:
        branch = f"try/{slug(idea)}"
        made = argus.call("POST", "/api/git/worktree", {"path": str(repo), "branch": branch})
        where = Path(made["path"])
        # The contract, in the prompt, because there is no other way to be told it is done.
        prompt = (
            f"You are trying one approach among several, in this checkout: {idea}.\n"
            f"Work only in {where}. When you have something that runs, write {RESULT}\n"
            "with: what you changed, whether the tests pass, and one line beginning\n"
            "'VERDICT:' saying whether you would ship it.\n"
            f"Then run: argus-say ring --why done --session {slug(idea)}"
        )
        said = argus.call("POST", "/api/tmux/launch", {
            "launcher": launcher, "name": slug(idea), "path": str(where),
            "prompt": prompt, "run": run,
        })
        started.append({"idea": idea, "session": said["name"], "path": where, "branch": branch})
        print(f"  {said['name']:24} {branch:28} {where}")
    return started


def wait_for(argus: Argus, started: list[dict], minutes: float) -> tuple[list[dict], list[dict]]:
    """Until each has rung, or the clock runs out.

    Two ways of knowing, and both are used: the bell is the *signal*, the file is the *fact*. An
    agent that writes its result and forgets to ring is not a failure, so the file is checked
    whenever a bell arrives and once more at the end.
    """
    done, waiting = [], list(started)
    deadline = time.monotonic() + minutes * 60

    def collect() -> None:
        for one in list(waiting):
            if (one["path"] / RESULT).exists():
                waiting.remove(one)
                done.append(one)
                print(f"  {one['session']} has written {RESULT}")

    collect()
    since = 0
    while waiting and time.monotonic() < deadline:
        try:
            for bell in argus.bells(since, until=deadline):
                # The deadline, checked *inside* the stream. The bell stream sends a
                # heartbeat every 25 seconds and never ends on its own, so a `while` around
                # the generator is a `while` that is never reached: measured, an orchestrator
                # asked to wait ninety seconds waited five minutes and was killed.
                if time.monotonic() > deadline:
                    break
                since = max(since, int(bell.get("seq", 0)))
                who, why = bell.get("session"), bell.get("why")
                if why == "asking":
                    # Not swallowed: this is the case a person is wanted for, and an
                    # orchestrator that hides it is the reason people stop trusting one.
                    print(f"  ** {who or 'somebody'} is asking for a person: {bell.get('text', '')}")
                collect()
                if not waiting:
                    break
        except (TimeoutError, urllib.error.URLError, OSError):
            collect()          # the stream ended or timed out; look at the facts and go again
    collect()
    return done, waiting


def judge(argus: Argus, repo: Path, launcher: str, done: list[dict], run: bool) -> str:
    listing = "\n".join(f"- {one['idea']}: {one['path'] / RESULT}" for one in done)
    prompt = (
        "Three attempts at the same problem have finished. Read each RESULT.md below,\n"
        "compare them on correctness first and speed second, and say which one to keep\n"
        "and why in three sentences. Do not edit anything.\n\n" + listing
    )
    said = argus.call("POST", "/api/tmux/launch", {
        "launcher": launcher, "name": "judge", "path": str(repo), "prompt": prompt, "run": run,
    })
    return said["name"]


# ------------------------------------------------------------------------- main

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path, help="a git repository to work in")
    ap.add_argument("--try", dest="ideas", action="append", required=True, metavar="IDEA",
                    help="an approach to try; repeat it for as many as you want")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--minutes", type=float, default=30, help="how long to wait for them")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--no-judge", action="store_true", help="stop after the attempts")
    args = ap.parse_args()

    argus = Argus()
    run = not args.no_run
    here = argus.call("GET", "/api/who")
    if args.launcher not in here.get("launchers", []):
        sys.exit(f"{args.launcher!r} is not one of this machine's launchers: {here.get('launchers')}")

    print(f"{here['machine']} · {len(here['sessions'])} sessions already here")
    print(f"\nstarting {len(args.ideas)} attempts:")
    started = fan_out(argus, args.repo.expanduser(), args.launcher, args.ideas, run)

    print(f"\nwaiting up to {args.minutes:g} minutes for {RESULT} in each:")
    done, lost = wait_for(argus, started, args.minutes)
    for one in lost:
        print(f"  {one['session']} never finished — its worktree is at {one['path']}")
    if not done:
        sys.exit("\nnothing finished; nothing to judge")

    if args.no_judge:
        print("\nfinished:")
        for one in done:
            print(f"  {one['idea']}: {one['path'] / RESULT}")
        return

    print(f"\n{len(done)} finished. Starting the judge:")
    name = judge(argus, args.repo.expanduser(), args.launcher, done, run)
    print(f"  {name} is reading them, in {args.repo}")
    print("\nThe worktrees are left where they are: this script does not delete work.")
    print("  git -C %s worktree list" % args.repo)


if __name__ == "__main__":
    main()

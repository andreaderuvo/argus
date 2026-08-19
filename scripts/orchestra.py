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
import re
import sys
import time
from pathlib import Path

RESULT = "RESULT.md"


# --------------------------------------------------------------- talking to argus
#
# The client is `tools/argus_client.py`: one stdlib file, importable and copyable. It was thirty
# lines at the top of this script until the other two examples started importing them from here,
# which is the moment a shared thing wants to stop being a script.

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_client import Argus, ArgusError, TooFast     # noqa: E402

RESULT = "RESULT.md"


def slug(text: str, n: int = 24) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:n] or "idea"


# --------------------------------------------------------------------- the shape


def fan_out(argus: Argus, repo: Path, launcher: str, ideas: list[str], run: bool) -> list[dict]:
    """One worktree and one agent per idea."""
    started = []
    for idea in ideas:
        branch = f"try/{slug(idea)}"
        made = argus.worktree(repo, branch)
        where = Path(made["path"])
        # The contract, in the prompt, because there is no other way to be told it is done.
        prompt = (
            f"You are trying one approach among several, in this checkout: {idea}.\n"
            f"Work only in {where}. When you have something that runs, write {RESULT}\n"
            "with: what you changed, whether the tests pass, and one line beginning\n"
            "'VERDICT:' saying whether you would ship it.\n"
            f"Then run: argus-say ring --why done --session {slug(idea)}"
        )
        said = argus.launch(launcher, slug(idea), where, prompt, run=run)
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
            for bell in argus.bells(since=since, until=deadline):
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
        # `OSError` and not the three names it used to list: `TimeoutError` and
        # `urllib.error.URLError` are both subclasses of it, and one of the three was a name
        # this file never imported — an `except` clause that would have raised `NameError` at
        # the exact moment it was meant to recover.
        except OSError:
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
    said = argus.launch(launcher, "judge", repo, prompt, run=run)
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
    here = argus.who()
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

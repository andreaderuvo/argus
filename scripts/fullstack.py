#!/usr/bin/env python3
"""Backend, frontend and a tester on one repository, in the order the work actually has.

The third shape, and the one that looks least like a fan-out. `orchestra.py` starts several
agents on *different* attempts; `referee.py` puts several pairs of eyes on the *same* artefact.
This has three agents doing *different jobs on one codebase*, where the order matters: nobody
can consume an API that has not been described, and nothing is worth testing until both sides
exist.

    python3 scripts/fullstack.py --repo ~/work/shop --task "add a saved-baskets endpoint and \\
        a page that lists them"
    python3 scripts/fullstack.py --repo ~/work/shop --task "…" --rounds 3

What is different here, mechanically:

  1. **The agents stay.** They are started once and then *told things*, through `/api/relay`,
     which is what dropping a prompt onto a terminal does. Neither other example uses it: they
     start an agent per piece of work and let it end. Here the backend is still sitting there
     when the tester finds a bug in it, which is the whole reason it is worth keeping.

  2. **One checkout, deliberately.** No worktrees. A backend and a frontend on one task touch
     different directories, and the tester has to see both — three checkouts would mean three
     halves of the change that never meet. `orchestra.py` uses worktrees precisely because its
     agents are trying to do *the same thing* and must not see each other.

  3. **A loop with a cap.** The tester writes FAILURES.md; whatever is in it goes back to the
     side that owns it, and round two begins. Three rounds by default, and then it stops and
     tells you — an agent loop with no cap is a way to spend a night's tokens on two robots
     agreeing with each other.

The contract is the same as everywhere: they write files, this reads files, and each prompt says
what to write and when to ring. Nothing here can read what an agent replied.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_client import Argus         # noqa: E402  — one file, stdlib only

CONTRACT = "When it is written, run:  argus-say ring --why done --session {session}"

ROLES = {
    "backend": (
        "You are the backend. Work only in the server code and its tests.\n"
        "First, before writing any handler, write {notes}/API.md: every endpoint this task\n"
        "needs, with its method, path, request and response shapes, and the errors. That file\n"
        "is what the frontend builds against, so it is a promise — if you change it later, say\n"
        "so at the top.\n"
        "Then implement it. Do not touch anything under the frontend."
    ),
    "frontend": (
        "You are the frontend. Work only in the client code.\n"
        "The backend has written the contract in {notes}/API.md — build against that, not\n"
        "against what the server happens to do today. If the contract is missing something you\n"
        "need, do not invent it: write the question in {notes}/QUESTIONS.md and carry on with\n"
        "the rest."
    ),
    "tests": (
        "You are the tester, and you did not write any of this.\n"
        "Run the suite and exercise the new path end to end. Write {notes}/FAILURES.md: one\n"
        "numbered entry per failure, each saying which side owns it — 'backend:' or\n"
        "'frontend:' — what you did, what happened and what should have happened.\n"
        "If everything passes, write exactly 'ALL GREEN' in that file and nothing else.\n"
        "Never fix anything yourself: your value is that you are not the author."
    ),
}


def start(argus: Argus, repo: Path, notes: Path, launcher: str, task: str, run: bool) -> dict:
    """The three of them, in one checkout, each with its job and the task."""
    made = {}
    for role, brief in ROLES.items():
        prompt = (
            f"Three agents are working on one repository at {repo}: a backend, a frontend and a\n"
            f"tester. You are the {role}.\n\n"
            f"THE TASK: {task}\n\n"
            + brief.format(notes=notes) + "\n\n"
            f"Shared notes go in {notes}. Read the other files there when you need them.\n"
            + CONTRACT.format(session=role)
        )
        said = argus.launch(launcher, role, repo, prompt, run=run)
        made[role] = said["name"]
        print(f"  {said['name']:10} started in {repo}")
    return made


def wait_for(argus: Argus, files: list[Path], minutes: float, why: str) -> list[Path]:
    """Until these files exist, or the clock runs out. The bell wakes it; the file decides."""
    waiting, got = list(files), []
    deadline = time.monotonic() + minutes * 60

    def collect():
        for f in list(waiting):
            if f.exists() and f.stat().st_size > 3:
                waiting.remove(f)
                got.append(f)
                print(f"  {f.name} is there")

    collect()
    since = 0
    print(f"  waiting for {why} (up to {minutes:g} minutes)")
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
                if bell.get("why") == "asking":
                    print(f"  ** {bell.get('session') or 'somebody'} wants a person: {bell.get('text','')}")
                collect()
                if not waiting:
                    break
        except Exception:
            collect()
    collect()
    return got


def tell(argus: Argus, session: str, text: str, run: bool) -> None:
    """A sentence into a session that is already running — the thing a person does by dragging."""
    argus.relay(session, text, run)
    print(f"  → {session}: {text.splitlines()[0][:70]}")


def split_failures(text: str) -> dict[str, list[str]]:
    """Whose problem each numbered failure is, by the prefix the tester was asked to use."""
    mine: dict[str, list[str]] = {"backend": [], "frontend": [], "unassigned": []}
    for line in text.splitlines():
        bare = line.strip()
        if not bare:
            continue
        low = bare.lower()
        if "backend:" in low:
            mine["backend"].append(bare)
        elif "frontend:" in low:
            mine["frontend"].append(bare)
        elif bare[:2].rstrip(".").isdigit():
            mine["unassigned"].append(bare)
    return mine


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path, help="the repository all three work in")
    ap.add_argument("--task", required=True, help="what is being built, in one sentence")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--rounds", type=int, default=3, help="how many times the tester may send it back")
    ap.add_argument("--minutes", type=float, default=30, help="how long to wait in each round")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--notes", type=Path, help="where the shared files go (default: <repo>/.handover)")
    args = ap.parse_args()

    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        sys.exit(f"{repo} is not a folder")
    notes = (args.notes or repo / ".handover").expanduser()
    notes.mkdir(parents=True, exist_ok=True)
    run = not args.no_run

    argus = Argus()
    here = argus.who()
    if args.launcher not in here.get("launchers", []):
        sys.exit(f"{args.launcher!r} is not one of this machine's launchers: {here.get('launchers')}")
    print(f"{here['machine']} · {repo.name} · notes in {notes}\n")

    print("starting three:")
    start(argus, repo, notes, args.launcher, args.task, run)

    # The one hard dependency: nobody builds against a contract that does not exist yet. The
    # frontend was started with the same task and will be sitting there; it is *told* when the
    # contract lands rather than being made to poll for it.
    print("\nthe contract first:")
    if not wait_for(argus, [notes / "API.md"], args.minutes, "the backend to write API.md"):
        sys.exit("the backend never wrote API.md — nothing to build against")
    tell(argus, "frontend", f"{notes / 'API.md'} is written. Build against it now.", run)

    failures = notes / "FAILURES.md"
    for turn in range(1, args.rounds + 1):
        print(f"\nround {turn}: the tester")
        if failures.exists():
            failures.unlink()          # each round writes its own; a stale file would end it early
        tell(argus, "tests",
             f"Both sides say they have something. Run everything and write {failures} — "
             "'ALL GREEN' if it passes.", run)
        if not wait_for(argus, [failures], args.minutes, "the tester"):
            sys.exit(f"the tester never wrote {failures}")

        said = failures.read_text(encoding="utf-8")
        if "ALL GREEN" in said.upper():
            print(f"\nGreen on round {turn}.")
            break

        whose = split_failures(said)
        print(f"  backend: {len(whose['backend'])} · frontend: {len(whose['frontend'])} · "
              f"unassigned: {len(whose['unassigned'])}")
        for side in ("backend", "frontend"):
            theirs = whose[side] + (whose["unassigned"] if side == "backend" else [])
            if theirs:
                tell(argus, side, "The tester found these, and they are yours:\n"
                     + "\n".join(theirs[:20]) + f"\n\nFix them, then ring done. Round {turn}.", run)
        if turn == args.rounds:
            print(f"\nStopped after {args.rounds} rounds with failures left in {failures}.")
            print("That is a cap, not a verdict: look at it and decide whether to go again.")
    else:
        pass

    print(f"\nAll three are still open — ask them things. The handover files are in {notes}:")
    for f in sorted(notes.glob("*")):
        print(f"  {f}")


if __name__ == "__main__":
    main()

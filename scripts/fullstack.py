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

  1. **The agents stay.** They are started once and then *told things* with `o.tell`, which is
     what dropping a prompt onto a terminal does. Neither other example uses it: they start an
     agent per piece of work and let it end. Here the backend is still sitting there when the
     tester finds a bug in it, which is the whole reason it is worth keeping.

  2. **One checkout, deliberately.** No worktrees. A backend and a frontend on one task touch
     different directories, and the tester has to see both — three checkouts would mean three
     halves of the change that never meet. `orchestra.py` uses worktrees precisely because its
     agents are trying to do *the same thing* and must not see each other.

  3. **A loop with a cap**, written as an ordinary `for` over `o.rounds(n)`. This is why the
     framework is blocking rather than a graph you declare and run: a real orchestration ends
     up needing a conditional loop, and in a graph that is a feature while here it is Python.

Everything underneath — the waiting, the contract each prompt ends with, the naming, the
report — is in [`tools/argus_orchestra.py`](../tools/argus_orchestra.py).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_orchestra import Orchestra          # noqa: E402

ROLES = {
    "backend": "You are the backend. Work only in the server code and its tests.\n"
               "First, before writing any handler, write {notes}/API.md: every endpoint this\n"
               "task needs, with its method, path, request and response shapes, and the\n"
               "errors. That file is what the frontend builds against, so it is a promise — if\n"
               "you change it later, say so at the top.\n"
               "Then implement it. Do not touch anything under the frontend.",
    "frontend": "You are the frontend. Work only in the client code.\n"
                "The backend has written the contract in {notes}/API.md — build against that,\n"
                "not against what the server happens to do today. If the contract is missing\n"
                "something you need, do not invent it: write the question in\n"
                "{notes}/QUESTIONS.md and carry on with the rest.",
    "tests": "You are the tester, and you did not write any of this.\n"
             "Run the suite and exercise the new path end to end. Write {notes}/FAILURES.md:\n"
             "one numbered entry per failure, each saying which side owns it — 'backend:' or\n"
             "'frontend:' — what you did, what happened and what should have happened.\n"
             "If everything passes, write exactly 'ALL GREEN' in that file and nothing else.\n"
             "Never fix anything yourself: your value is that you are not the author.",
}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path, help="the repository all three work in")
    ap.add_argument("--task", required=True, help="what is being built, in one sentence")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--rounds", type=int, default=3, help="how many times the tester may send it back")
    ap.add_argument("--minutes", type=float, default=30, help="how long to wait in each round")
    ap.add_argument("--prefix", default="", help="in front of every session name, so a machine "
                                                 "that already has a `backend` open is not a "
                                                 "reason this cannot run")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--watch", action="store_true", help="put each role on the desk")
    ap.add_argument("--notes", type=Path, help="where the shared files go (default: <repo>/.handover)")
    args = ap.parse_args()

    repo = args.repo.expanduser().resolve()
    if not repo.is_dir():
        sys.exit(f"{repo} is not a folder")
    notes = (args.notes or repo / ".handover").expanduser()
    notes.mkdir(parents=True, exist_ok=True)

    o = Orchestra(repo, launcher=args.launcher, prefix=args.prefix, minutes=args.minutes,
                  run=not args.no_run, watch=args.watch)
    o.say(f"notes in {notes}")

    def brief(role: str) -> str:
        return (f"Three agents are working on one repository at {repo}: a backend, a frontend\n"
                f"and a tester. You are the {role}.\n\nTHE TASK: {args.task}\n\n"
                + ROLES[role].format(notes=notes)
                + f"\n\nShared notes go in {notes}. Read the other files there when you need them.")

    o.say("\nstarting three:")
    # Started, not stepped: only the backend is waited for, because the other two have nothing
    # to do until the contract exists and are sitting there ready when it does.
    back = o.start("backend", say=brief("backend"), until=notes / "API.md")
    front = o.start("frontend", say=brief("frontend"))
    tests = o.start("tests", say=brief("tests"))

    o.say("\nthe contract first — nobody builds against an API that has not been described:")
    o.wait(back)
    if not back.done:
        sys.exit("the backend never wrote API.md — nothing to build against")
    o.tell(front, f"{notes / 'API.md'} is written. Build against it now.")

    failures = notes / "FAILURES.md"
    for turn in o.rounds(args.rounds):
        o.tell(tests, "Both sides say they have something. Run everything and write "
                      f"{failures} — 'ALL GREEN' if it passes.")
        # `fresh`, because the tester rewrites the same file every round and last round's copy
        # would end the loop early with the wrong answer.
        said = o.wait_for(failures, fresh=turn > 1)
        if not said:
            sys.exit(f"the tester never wrote {failures}")
        if said.says("ALL GREEN"):
            o.say(f"\nGreen on round {turn}.")
            break

        whose = said.split_by("backend:", "frontend:")
        o.say(f"  backend: {len(whose['backend:'])} · frontend: {len(whose['frontend:'])} · "
              f"unassigned: {len(whose[''])}")
        for side, who in (("backend:", back), ("frontend:", front)):
            # Anything the tester did not attribute goes to the backend: it is where a shared
            # failure usually lives, and an unowned bug that goes to nobody is a bug that stays.
            theirs = whose[side] + (whose[""] if side == "backend:" else [])
            if theirs:
                o.tell(who, "The tester found these, and they are yours:\n"
                            + "\n".join(theirs[:20])
                            + f"\n\nFix them, then ring done. Round {turn}.")

    o.say(f"\nAll three are still open — ask them things. The handover files are in {notes}:")
    for f in sorted(notes.glob("*")):
        o.say(f"  {f}")
    o.report()


if __name__ == "__main__":
    main()

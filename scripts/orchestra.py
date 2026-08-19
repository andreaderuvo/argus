#!/usr/bin/env python3
"""N agents try N things, and one more says which won.

    python3 scripts/orchestra.py --repo ~/work/api \\
        --try "a cache in front of the query" \\
        --try "an index on the join column" \\
        --try "rewriting it as one query"

A git worktree per idea so nobody edits somebody else's checkout, an agent in each, and a
judge reading the results. Twenty lines, because the plumbing is in
[`tools/argus_orchestra.py`](../tools/argus_orchestra.py) — the waiting, the contract that
tells an agent how to say it has finished, the naming, the worktrees, the report.

This file used to be two hundred lines and most of them were that plumbing. What is left is
the shape, which is the part worth copying: change the middle and you have your own.

`--no-run` types every prompt in and leaves the return to you. Do that first.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_orchestra import Orchestra          # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--repo", required=True, type=Path, help="a git repository to work in")
    ap.add_argument("--try", dest="ideas", action="append", required=True, metavar="IDEA",
                    help="an approach to try; repeat it for as many as you want")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--minutes", type=float, default=30, help="how long to wait for them")
    ap.add_argument("--prefix", default="", help="in front of every session name, so a second "
                                                 "run does not collide with the first")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--no-judge", action="store_true", help="stop after the attempts")
    ap.add_argument("--watch", action="store_true",
                    help="put each session on the desk as it starts")
    args = ap.parse_args()

    o = Orchestra(args.repo, launcher=args.launcher, prefix=args.prefix,
                  minutes=args.minutes, run=not args.no_run, watch=args.watch)

    tries = o.fan_out(
        args.ideas,
        say="You are trying one approach among several: {each}.\n"
            "When you have something that runs, write what you changed, whether the tests\n"
            "pass, and one line beginning 'VERDICT:' saying whether you would ship it.",
        worktree="try/{each}",
        until="RESULT.md",
    )

    if tries.done and not args.no_judge:
        o.step(
            name="judge",
            say="Several attempts at the same problem have finished. Read each RESULT.md\n"
                "below, compare them on correctness first and speed second, and say which\n"
                f"one to keep and why in three sentences. Do not edit anything.\n\n{tries.files}",
            until="DECISION.md",
        )

    o.report()


if __name__ == "__main__":
    main()

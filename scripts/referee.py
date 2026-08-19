#!/usr/bin/env python3
"""Four referees, an editor, and a rebuttal — the other shape an orchestrator has.

`orchestra.py` is a fan-out: several agents try *different things* and one picks a winner. This
is the opposite and just as common: several agents read the *same thing* with different eyes,
and one has to reconcile them.

    python3 scripts/referee.py --paper ~/work/cgdist-paper
    python3 scripts/referee.py --paper ~/work/paper --rebuttal
    python3 scripts/referee.py --paper ~/work/paper \\
        --lens "stats: is the statistical treatment sound and is the sample enough" \\
        --lens "figures: does every figure earn its place and can it be read in print"

Why the lenses matter more than the number: four agents given "review this paper" write four
copies of the same review — the same easy observations, the same missed hole. Told *what to look
with*, they disagree, and the disagreement is the product. That is the whole reason this is worth
running rather than asking one agent four times.

The rounds are three `fan_out`/`step` calls below, and everything they rest on — the waiting,
the contract, the naming, the report — is in
[`tools/argus_orchestra.py`](../tools/argus_orchestra.py).

Nothing here reads what an agent *said*: they write files, this reads files. See the note at
the top of the framework for why that is a property of the substrate and not a shortcut.
"""

from __future__ import annotations

import argparse
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
from argus_orchestra import Orchestra, slug          # noqa: E402

# Four lenses that disagree with each other on purpose. Change them: they are the argument.
LENSES = {
    "methods": "the methods and the statistics: is what they did capable of supporting what "
               "they claim, are the comparisons fair, is the sample enough, and is anything "
               "measured in a way that would not survive a hostile reader",
    "novelty": "novelty and the related work: what exactly is new here that was not in the "
               "cited work, is anything important uncited, and would this change what somebody "
               "in the field does on Monday",
    "repro": "reproducibility: could a competent stranger rerun this from what is written — "
             "the data, the code, the versions, the seeds, the parameters — and say plainly "
             "what is missing rather than assuming it is somewhere",
    "clarity": "clarity and the figures: does the abstract match the results, does every figure "
               "earn its place and read in greyscale, and where does the argument actually lose "
               "a reader",
}

REVIEW = """You are one of {n} referees reading the same paper, and you are the one reading it
for {value}.

The paper is in {paper}. Read it, then judge only through that lens — the other referees have
the other lenses and will cover them.

Write your review in this shape and nothing else:

    SCORE: 1-5 (1 reject, 5 accept as is)
    CONFIDENCE: low | medium | high
    MAJOR: numbered, each one a thing that must change and why it matters
    MINOR: numbered, each one a small thing
    QUESTIONS: what you would ask the authors

Quote the paper by section or line when you object to something: "it is unclear" is not a
review. Do not edit the paper. Do not read the other referees' files even if they appear."""

EDITOR = """You are the editor. {n} referees have read the paper in {paper}, each through one
lens, and written their reviews:

{files}

Read all of them and write:

    DECISION: accept | minor revision | major revision | reject
    WHY: three sentences, no more
    MUST FIX: the union of the major points, deduplicated, in the order you would fix them,
        each attributed to the referee who raised it
    DISAGREEMENT: where the referees contradict each other, and which side you take. This
        section is the reason there is more than one of them — if it is empty, say so
        explicitly rather than leaving it out.
    NOT WORTH DOING: anything a referee asked for that you would not require

Do not edit the paper and do not rewrite the reviews."""

REBUTTAL = """You are the author. The editor's decision on the paper in {paper} is in
{decision}, and the referees' reviews are beside it.

Write:

    ACCEPTED: the points you will act on, and what you will change for each
    DISPUTED: the points you will argue with — quote the paper or the data that answers them,
        and concede immediately where you cannot
    IMPOSSIBLE: anything asked for that cannot be done with the data at hand, said plainly
        rather than avoided

Be short and be honest: a rebuttal that argues with everything is read as arguing with
nothing. Do not edit the paper yet."""


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--paper", required=True, type=Path, help="the folder the paper lives in")
    ap.add_argument("--lens", action="append", metavar="NAME: WHAT TO LOOK FOR",
                    help="replace the four defaults; repeat for as many as you want")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--minutes", type=float, default=45, help="how long to wait for each round")
    ap.add_argument("--rebuttal", action="store_true", help="a third round: the author answers")
    ap.add_argument("--prefix", default="", help="in front of every session name, so two papers "
                                                 "can be refereed at once")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--watch", action="store_true", help="put each referee on the desk")
    ap.add_argument("--out", type=Path, help="where the reviews go (default: <paper>/reviews/<today>)")
    args = ap.parse_args()

    paper = args.paper.expanduser().resolve()
    if not paper.is_dir():
        sys.exit(f"{paper} is not a folder — point this at the paper's directory")
    out = (args.out or paper / "reviews" / date.today().isoformat()).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    lenses = LENSES
    if args.lens:
        lenses = {}
        for one in args.lens:
            name, _, what = one.partition(":")
            if not what.strip():
                sys.exit(f"--lens wants 'name: what to look for', not {one!r}")
            lenses[slug(name, 12)] = what.strip()

    o = Orchestra(paper, launcher=args.launcher, prefix=args.prefix, minutes=args.minutes,
                  run=not args.no_run, watch=args.watch)
    o.say(f"reviews into {out}")

    reviews = o.fan_out(
        lenses,
        say=REVIEW.format(n=len(lenses), value="{value}", paper=paper),
        until=out / "REVIEW-{each}.md",
    )
    if not reviews.done:
        sys.exit("\nno reviews; nothing to edit")

    decision = out / "DECISION.md"
    o.step(name="editor", until=decision,
           say=EDITOR.format(n=len(reviews.done), paper=paper, files=reviews.files))
    if decision.exists():
        o.say("\n" + "\n".join("    " + line
                               for line in decision.read_text(encoding="utf-8").splitlines()[:12]))

    if args.rebuttal:
        o.step(name="rebuttal", until=out / "REBUTTAL.md",
               say=REBUTTAL.format(paper=paper, decision=decision))

    o.say(f"\nEverything is in {out}.")
    o.report()


if __name__ == "__main__":
    main()

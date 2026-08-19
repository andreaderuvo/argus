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

The rounds:

  1. **Referees.** One per lens, all reading the same folder, none of them editing it. Each
     writes `reviews/REVIEW-<lens>.md` with a score and a list of problems, then rings.
  2. **The editor.** Reads every review, writes `reviews/DECISION.md`: one verdict, the issues
     merged and deduplicated, and — the part a single agent never does — where the referees
     *disagree*, which is where you should look first.
  3. **The rebuttal**, if asked for. An author agent reads the decision and writes
     `reviews/REBUTTAL.md`: what it would change, what it would argue with, and why. That is the
     third round, and the point at which this stops being a fan-out and starts being a
     conversation with a shape.

Nothing here reads what an agent *said*: they write files, this reads files. See the long note
at the top of `orchestra.py` for why that is a property of the substrate and not a shortcut.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from argus_client import Argus             # noqa: E402  — one file, stdlib only
from orchestra import slug                 # noqa: E402

# Four lenses that disagree with each other on purpose. Change them: they are the argument.
LENSES = [
    ("methods", "the methods and the statistics: is what they did capable of supporting what "
                "they claim, are the comparisons fair, is the sample enough, and is anything "
                "measured in a way that would not survive a hostile reader"),
    ("novelty", "novelty and the related work: what exactly is new here that was not in the "
                "cited work, is anything important uncited, and would this change what somebody "
                "in the field does on Monday"),
    ("repro", "reproducibility: could a competent stranger rerun this from what is written — "
              "the data, the code, the versions, the seeds, the parameters — and say plainly "
              "what is missing rather than assuming it is somewhere"),
    ("clarity", "clarity and the figures: does the abstract match the results, does every figure "
                "earn its place and read in greyscale, and where does the argument actually lose "
                "a reader"),
]

CONTRACT = """
Write your review to {out}, in this shape and nothing else:

    SCORE: 1-5 (1 reject, 5 accept as is)
    CONFIDENCE: low | medium | high
    MAJOR: numbered, each one a thing that must change and why it matters
    MINOR: numbered, each one a small thing
    QUESTIONS: what you would ask the authors

Quote the paper by section or line when you object to something: "it is unclear" is not a
review. Do not edit the paper. Do not read the other referees' files even if they appear.
When the file is written, run:  argus-say ring --why done --session {session}
"""


def start_referees(argus: Argus, paper: Path, out: Path, lenses, launcher: str, run: bool):
    started = []
    for name, lens in lenses:
        session = f"ref-{slug(name, 12)}"
        target = out / f"REVIEW-{name}.md"
        prompt = (
            f"You are one of {len(lenses)} referees reading the same paper, and you are the one "
            f"reading it for {lens}.\n\n"
            f"The paper is in {paper}. Read it, then judge only through that lens — the other "
            f"referees have the other lenses and will cover them.\n"
            + CONTRACT.format(out=target, session=session)
        )
        said = argus.launch(launcher, session, paper, prompt, run=run)
        started.append({"lens": name, "session": said["name"], "file": target})
        print(f"  {said['name']:18} {name:9} -> {target.name}")
    return started


def wait_for_files(argus: Argus, started, minutes: float):
    """The bell is the signal, the file is the fact — same as orchestra.py."""
    done, waiting = [], list(started)
    deadline = time.monotonic() + minutes * 60

    def collect():
        for one in list(waiting):
            if one["file"].exists() and one["file"].stat().st_size > 40:
                waiting.remove(one)
                done.append(one)
                print(f"  {one['session']} has written {one['file'].name}")

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
                if bell.get("why") == "asking":
                    print(f"  ** {bell.get('session') or 'somebody'} wants a person: {bell.get('text','')}")
                collect()
                if not waiting:
                    break
        except Exception:
            collect()
    collect()
    return done, waiting


def start_editor(argus: Argus, paper: Path, out: Path, done, launcher: str, run: bool) -> str:
    listing = "\n".join(f"- {one['lens']}: {one['file']}" for one in done)
    prompt = (
        f"You are the editor. {len(done)} referees have read the paper in {paper}, each through "
        "one lens, and written their reviews:\n\n" + listing + "\n\n"
        f"Read all of them and write {out / 'DECISION.md'}:\n\n"
        "    DECISION: accept | minor revision | major revision | reject\n"
        "    WHY: three sentences, no more\n"
        "    MUST FIX: the union of the major points, deduplicated, in the order you would fix\n"
        "        them, each attributed to the referee who raised it\n"
        "    DISAGREEMENT: where the referees contradict each other, and which side you take.\n"
        "        This section is the reason there is more than one of them — if it is empty,\n"
        "        say so explicitly rather than leaving it out.\n"
        "    NOT WORTH DOING: anything a referee asked for that you would not require\n\n"
        "Do not edit the paper and do not rewrite the reviews.\n"
        "When it is written, run:  argus-say ring --why done --session editor"
    )
    said = argus.launch(launcher, "editor", paper, prompt, run=run)
    return said["name"]


def start_rebuttal(argus: Argus, paper: Path, out: Path, launcher: str, run: bool) -> str:
    prompt = (
        f"You are the author. The editor's decision on the paper in {paper} is in "
        f"{out / 'DECISION.md'}, and the referees' reviews are beside it.\n\n"
        f"Write {out / 'REBUTTAL.md'}:\n\n"
        "    ACCEPTED: the points you will act on, and what you will change for each\n"
        "    DISPUTED: the points you will argue with — quote the paper or the data that\n"
        "        answers them, and concede immediately where you cannot\n"
        "    IMPOSSIBLE: anything asked for that cannot be done with the data at hand, said\n"
        "        plainly rather than avoided\n\n"
        "Be short and be honest: a rebuttal that argues with everything is read as arguing with\n"
        "nothing. Do not edit the paper yet.\n"
        "When it is written, run:  argus-say ring --why done --session rebuttal"
    )
    said = argus.launch(launcher, "rebuttal", paper, prompt, run=run)
    return said["name"]


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--paper", required=True, type=Path, help="the folder the paper lives in")
    ap.add_argument("--lens", action="append", metavar="NAME: WHAT TO LOOK FOR",
                    help="replace the four default lenses; repeat for as many as you want")
    ap.add_argument("--launcher", default="Claude Code", help="a name from `argus-say who`")
    ap.add_argument("--minutes", type=float, default=45, help="how long to wait for each round")
    ap.add_argument("--rebuttal", action="store_true", help="a third round: the author answers")
    ap.add_argument("--no-run", action="store_true",
                    help="type each prompt in but leave the return to a person — try this first")
    ap.add_argument("--out", type=Path, help="where the reviews go (default: <paper>/reviews/<today>)")
    args = ap.parse_args()

    paper = args.paper.expanduser().resolve()
    if not paper.is_dir():
        sys.exit(f"{paper} is not a folder — point this at the paper's directory")
    out = (args.out or paper / "reviews" / date.today().isoformat()).expanduser()
    out.mkdir(parents=True, exist_ok=True)

    lenses = LENSES
    if args.lens:
        lenses = []
        for one in args.lens:
            name, _, what = one.partition(":")
            if not what.strip():
                sys.exit(f"--lens wants 'name: what to look for', not {one!r}")
            lenses.append((slug(name, 12), what.strip()))

    argus = Argus()
    run = not args.no_run
    here = argus.who()
    if args.launcher not in here.get("launchers", []):
        sys.exit(f"{args.launcher!r} is not one of this machine's launchers: {here.get('launchers')}")

    print(f"{here['machine']} · reviewing {paper.name} · reviews into {out}")
    print(f"\nround 1 — {len(lenses)} referees:")
    started = start_referees(argus, paper, out, lenses, args.launcher, run)

    print(f"\nwaiting up to {args.minutes:g} minutes:")
    done, lost = wait_for_files(argus, started, args.minutes)
    for one in lost:
        print(f"  {one['session']} never wrote {one['file'].name}")
    if not done:
        sys.exit("\nno reviews; nothing to edit")

    print(f"\nround 2 — the editor, on {len(done)} review(s):")
    start_editor(argus, paper, out, done, args.launcher, run)
    decision = out / "DECISION.md"
    got, _ = wait_for_files(argus, [{"lens": "editor", "session": "editor", "file": decision}], args.minutes)
    if not got:
        sys.exit(f"\nthe editor never wrote {decision}")
    print(f"\n{decision}:\n")
    print("    " + "\n    ".join(decision.read_text(encoding="utf-8").splitlines()[:12]))

    if args.rebuttal:
        print("\nround 3 — the author answers:")
        start_rebuttal(argus, paper, out, args.launcher, run)
        wait_for_files(argus, [{"lens": "author", "session": "rebuttal",
                                "file": out / "REBUTTAL.md"}], args.minutes)

    print(f"\nEverything is in {out}. Nothing was edited and no session was closed:")
    print("  the referees are still open if you want to ask one of them something.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Every public name the Python tools offer, and whether it is written down anywhere.

    python3 scripts/surface.py                 # list the surface
    python3 scripts/surface.py --check         # every name has a docstring
    python3 scripts/surface.py --check --wiki ../argus.wiki

Why this exists. The HTTP API cannot drift from its description, because `openapi.py --check`
runs in the test suite and fails when it does — and that is the reason a route added in the
morning is documented by lunchtime without anybody deciding to do it. The two Python files had
no such thing, and it showed the day somebody asked whether the client was fully documented:
it was not. Eight methods of fourteen. Then the same question about the framework: twelve of
twenty-one. Both gaps were found by hand, which means both would have come back.

So: the surface is enumerated from the code, never from a list somebody maintains.

`--check` on its own is the part that always runs: **every public name carries a docstring**.
It is in-repo, needs nothing, and catches the failure at its source — a method written without
a sentence saying what it is for.

`--wiki` is the stronger check and needs the wiki, which is a separate repository. Given a
checkout of it, every public name must appear on a page. CI clones it; a local run without it
skips, because a wiki you have not cloned is not a reason to fail your tests.
"""

from __future__ import annotations

import argparse
import inspect
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "tools"))

# The two files a person writes Python against. `argus-say` is three lines over the client and
# has no surface of its own.
MODULES = ("argus_client", "argus_orchestra")


def public(mod) -> dict[str, object]:
    """Name -> the thing, for everything a reader could reasonably call.

    Module-level functions and classes, and the public attributes of the classes this module
    itself defines. Not what it imported: `Path` being re-exported by an `import` is not a
    surface this project has to document.
    """
    found: dict[str, object] = {}
    for name, thing in vars(mod).items():
        if name.startswith("_"):
            continue
        ours = getattr(thing, "__module__", None) == mod.__name__
        if inspect.isfunction(thing) and ours:
            found[name] = thing
        elif inspect.isclass(thing) and ours:
            found[name] = thing
            for inner, member in vars(thing).items():
                if inner.startswith("_"):
                    continue
                found[f"{name}.{inner}"] = member
    return found


def surface() -> dict[str, dict[str, object]]:
    import importlib

    return {name: public(importlib.import_module(name)) for name in MODULES}


def undocumented(names: dict[str, object]) -> list[str]:
    """Public names with nothing said about them.

    A constant needs no docstring and cannot have one, so class attributes that are plain
    values are excused — they are checked by the wiki pass instead, which is where a number
    like `BEAT_EVERY = 60` actually needs explaining.
    """
    missing = []
    for name, thing in names.items():
        if isinstance(thing, property):
            thing = thing.fget
        if not (inspect.isfunction(thing) or inspect.isclass(thing)):
            continue                      # a constant: nowhere to put a docstring
        if not (inspect.getdoc(thing) or "").strip():
            missing.append(name)
    return missing


def unmentioned(names: dict[str, object], pages: str) -> list[str]:
    """Public names that appear nowhere in the wiki.

    The bare name, not the dotted one: the pages write `agent.state` and `o.fan_out(...)`, and
    a check that insisted on `Agent.state` exactly would be checking prose style rather than
    coverage. What it is really asking is "has anybody ever written this word down".
    """
    return sorted({n.split(".")[-1] for n in names} - set(_words(pages)))


def _words(text: str) -> set[str]:
    import re

    return set(re.findall(r"[A-Za-z_][A-Za-z0-9_]*", text))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="fail if anything is undocumented")
    ap.add_argument("--wiki", type=Path, help="a checkout of the wiki, to check names against")
    args = ap.parse_args()

    found = surface()
    total = sum(len(v) for v in found.values())

    if not args.check:
        for mod, names in found.items():
            print(f"{mod} — {len(names)} public names")
            for name in sorted(names):
                print(f"  {name}")
        return 0

    bad = []
    for mod, names in found.items():
        for name in undocumented(names):
            bad.append(f"{mod}.{name} has no docstring")

    if args.wiki:
        pages = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                          for p in sorted(args.wiki.glob("*.md")))
        for mod, names in found.items():
            for name in unmentioned(names, pages):
                bad.append(f"{mod}.{name} is named nowhere in the wiki")

    if bad:
        print(f"{len(bad)} of {total} public names are not written down:", file=sys.stderr)
        for line in bad:
            print(f"  {line}", file=sys.stderr)
        return 1
    print(f"{total} public names, all documented"
          + (" and all named in the wiki" if args.wiki else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

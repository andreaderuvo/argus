"""The Python tools cannot quietly grow a surface nobody wrote down.

The HTTP API already has this: `openapi.py --check` runs here and fails when the published
description has drifted from the code, which is why a route added in the morning is documented
by lunchtime without anybody deciding to do it. The two Python files had no such guard, and it
showed the day somebody asked whether the client was fully documented — eight methods of
fourteen. Then the same question about the framework: twelve of twenty-one. Both were found by
hand, so both would have come back.

Two checks, because they fail at different moments. The docstring one always runs and catches
the method written without a sentence saying what it is for. The wiki one is stronger and needs
the wiki, which is a separate repository: CI clones it, and a machine that has not skips —
a wiki you never cloned is not a reason for your tests to fail.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "scripts"))
import surface                                                        # noqa: E402


def test_every_public_name_says_what_it_is_for():
    bad = {f"{mod}.{name}"
           for mod, names in surface.surface().items()
           for name in surface.undocumented(names)}
    assert not bad, f"public with no docstring: {sorted(bad)}"


def test_the_surface_is_small_enough_to_document():
    """A guard on the guard, like the agent key's.

    Neither of these files is allowed to become a framework with a hundred entry points by
    accident. If this fails, either something belongs behind an underscore or somebody has
    decided to grow the surface — and this test is the place that decision gets written down.
    """
    counted = {mod: len(names) for mod, names in surface.surface().items()}
    assert counted["argus_client"] <= 22, counted
    assert counted["argus_orchestra"] <= 30, counted


def wiki() -> Path | None:
    """A checkout of the wiki, if this machine has one.

    `$ARGUS_WIKI` first, because CI clones it somewhere of its own choosing; then the two
    places a person would have put it.
    """
    said = os.environ.get("ARGUS_WIKI")
    for candidate in ([Path(said)] if said else []) + [HERE.parent / "argus.wiki",
                                                       Path("/tmp/argus.wiki")]:
        if candidate.is_dir() and any(candidate.glob("*.md")):
            return candidate
    return None


@pytest.mark.skipif(wiki() is None, reason="no wiki checkout here — CI clones one")
def test_every_public_name_is_named_in_the_wiki():
    pages = "\n".join(p.read_text(encoding="utf-8", errors="replace")
                      for p in sorted(wiki().glob("*.md")))
    bad = {f"{mod}.{name}"
           for mod, names in surface.surface().items()
           for name in surface.unmentioned(names, pages)}
    assert not bad, (f"in the code and nowhere in the wiki: {sorted(bad)} — "
                     "see Writing-an-orchestrator")

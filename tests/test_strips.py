"""A class is who owns a node, not just how it looks.

The strip under a document's title bar was given the terminals' `winfacts` class so it would
wear their look. That also handed it to their machinery: the painter that rebuilds a
terminal's facts from its `data-cwd` takes *every* `.winfacts` on the page, found the
document's, and — a document having no session — wrote `tmux ?` over the folder and the
modification time, every ten seconds. The terminal's own `i` was hiding these too. Reported
as the info bar going to hell now and then, and "now and then" is exactly what a ten-second
sweep looks like from a chair.

The look is shared in the stylesheet, where sharing a look belongs. This is here so the
shortcut cannot come back, and so the two selectors cannot drift apart in silence.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "static" / "app.js"
CSS = ROOT / "static" / "style.css"


def test_document_strip_does_not_wear_the_terminal_class() -> None:
    """The one line that builds a document's strip must not say `winfacts`."""
    built = [
        line for line in APP.read_text(encoding="utf-8").splitlines()
        if "className: 'docfacts" in line or 'className: "docfacts' in line
    ]
    assert built, "the document strip is no longer built with a `docfacts` class"
    for line in built:
        assert "winfacts" not in line, (
            "a document strip wearing `winfacts` is picked up by the terminal facts painter "
            "and overwritten with `tmux ?`; share the look in style.css instead"
        )


def test_the_terminal_painters_only_reach_terminals() -> None:
    """Nothing that rebuilds a strip's contents may select the document's class."""
    source = APP.read_text(encoding="utf-8")
    for hit in re.findall(r"querySelectorAll\((['\"`])([^'\"`]*docfacts[^'\"`]*)\1\)", source):
        selector = hit[1]
        assert "winfacts" not in selector, (
            f"{selector} reaches both kinds of strip; they have separate owners"
        )


def test_every_terminal_rule_reaches_the_document_strip() -> None:
    """Every rule the terminals' strip has, the document's strip has too.

    The look is deliberately the same — a document says where it is the way a session does —
    so a rule added for one and forgotten for the other is a bug that only shows up in a
    screenshot. Compared as selectors rather than as pixels, which is the part a test can
    honestly check.

    One direction only: the document's strip is allowed rules of its own, and has one, for
    the line under it. It sits below a title bar; a terminal's does not.
    """
    rules = [
        line.split("{", 1)[0]
        for line in CSS.read_text(encoding="utf-8").splitlines()
        if line.startswith(".winfacts")
    ]
    assert rules, "no `.winfacts` rules left to share — has the strip been renamed?"
    for head in rules:
        parts = {s.strip() for s in head.split(",")}
        for sel in (s for s in parts if s.startswith(".winfacts")):
            twin = sel.replace(".winfacts", ".docfacts", 1)
            assert twin in parts, f"`{sel}` has no `{twin}` beside it — the two strips will drift"

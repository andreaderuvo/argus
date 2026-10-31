"""The chosen button of a set is outlined on all four sides — the left one too, whatever its place.

The divider between two buttons of a set is a more specific rule than the chosen one's outline, and
it painted the chosen button's left edge grey whenever it was not first: the file browser's views,
a desk's Grid / Columns / Rows (screenshot of 2026-10-31).
"""

from __future__ import annotations

import json


def test_a_chosen_button_has_its_left_edge_too(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": [
        {"kind": "browser", "id": 3, "path": str(argus.root / "docs"), "fresh": True, "view": "list"}]}]}})
    page = make_page(route="#/wall")
    page.wait("!!document.querySelector('.win .viewset button.on')", timeout=15)
    edges = json.loads(page.eval("""JSON.stringify([...document.querySelectorAll('.btnset > button.winbtn.on')]
      .filter(b => b.getClientRects().length && b.previousElementSibling)
      .map(b => { const s = getComputedStyle(b); return [b.title, s.borderLeftColor, s.borderTopColor]; }))"""))
    assert edges, "a chosen button that is not first, to look at"
    for title, left, top in edges:
        assert left == top, f"{title}: left edge {left}, the others {top}"

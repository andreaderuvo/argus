"""A window's actions are in one place: its title bar, and so its ⋮ — never a row of buttons under it.

Documents had a strip of their own under the title (copy the path, a link, the star…) and file
browsers a row of folder actions (new folder, upload, sync…), while the window's own were in ⋮:
"sometimes on the three dots, sometimes a bar under the title — they must all be in one place"
(2026-10-31). What changes what you see — a folder's path, a PDF's pages, a view — stays with it.
"""

from __future__ import annotations

import json
import time


def test_every_window_keeps_its_actions_in_its_title_bar(make_page, argus):
    r = argus.root
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": [
        {"kind": "browser", "id": 3, "path": str(r / "docs"), "fresh": True},
        {"kind": "file", "path": str(r / "notes.txt")},
        {"kind": "file", "path": str(r / "docs" / "report.md")},
        {"kind": "file", "path": str(r / "docs" / "paper.pdf")},
    ]}]}})
    page = make_page(route="#/wall")
    page.wait("document.querySelectorAll('.win').length === 4 && !!document.querySelector('.win[data-kind=browser] .panelist .row')", timeout=15)
    time.sleep(1.5)                                   # the documents' own buttons arrive with the document
    stray = page.eval("""JSON.stringify([...document.querySelectorAll('.win .winbody button')]
      .filter(b => b.getClientRects().length && b.closest('.prevwhere, .docwherebtns, .pad.tools'))
      .map(b => [b.closest('.win').dataset.kind, b.title]))""")
    assert json.loads(stray) == [], f"action buttons left under a title bar: {stray}"

    # The browser's: the folder's actions, a rule, then the window's own.
    page.click_at(*page._center("document.querySelector('.win[data-kind=browser] .winmore')"))
    page.wait("!!document.querySelector('.popmenu')", timeout=5)
    menu = json.loads(page.eval("JSON.stringify([...document.querySelectorAll('.popmenu > *')].map(n => n.classList.contains('popmenusep') ? '—' : n.textContent.trim()))"))
    for want in ("Pin this folder", "New folder", "Upload files", "Sync this folder"):
        assert any(m.startswith(want) for m in menu), (want, menu)
    assert "—" in menu and menu.index("—") < next(i for i, m in enumerate(menu) if m.startswith("Full screen")), menu
    page.key("Escape")

    # A document's: its own, with the window's.
    page.click_at(*page._center("document.querySelector('.win[data-kind=file] .winmore')"))
    page.wait("!!document.querySelector('.popmenu')", timeout=5)
    menu = page.eval("document.querySelector('.popmenu').textContent")
    for want in ("Copy the absolute path", "Copy a link to this file", "Star it", "Download"):
        assert want in menu, (want, menu)

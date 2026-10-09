"""Favourites pinned in one tool are shown in the others too, under their own heading.

Each tool keeps its own list (pinning in the sidebar pins in the sidebar), but the folders pinned
in Files were wanted in the sidebar as well — asked for on 2026-10-09.
"""

from __future__ import annotations

import time

from .test_flows import eventually


def test_files_favourites_show_in_the_sidebar_and_can_be_unpinned_there(make_page, argus):
    folder = argus.root / "home" / "pinned-in-files"
    folder.mkdir(parents=True, exist_ok=True)
    argus.api("/api/favourites", "POST", {"path": str(folder), "group": "main"})
    argus.api("/api/prefs", "PATCH", {"changes": {"sidebar": True}})
    page = make_page(route="#/sessions")
    side = "document.querySelector('#side')"
    page.wait(f"!!{side}.querySelector('.favfrom')", timeout=10, what="the Files favourites, in the sidebar")
    assert "Files" in page.eval(f"{side}.querySelector('.favfrom').textContent")
    row = f"[...{side}.querySelectorAll('.row.fav')].find(r => r.textContent.includes('pinned-in-files'))"
    page.wait(f"!!{row}", timeout=5)
    page.click_at(*page._center(row))
    page.wait(f"[...{side}.querySelectorAll('*')].some(n => n.textContent === '{folder}' || n.title === '{folder}') || "
              f"{side}.textContent.includes('pinned-in-files')", timeout=5)
    # Unpinned from the sidebar: from the list it belongs to.
    off = f"{row}.parentElement.querySelector('.more')"
    page.wait(f"!!{row}", timeout=5)
    page.click_at(*page._center(off))
    eventually(lambda: not any(f["path"] == str(folder) for f in argus.api("/api/favourites").get("main", [])),
               timeout=5, what="unpinned from Files' own list")
    time.sleep(0.3)
    assert not page.eval(f"!!{row}")

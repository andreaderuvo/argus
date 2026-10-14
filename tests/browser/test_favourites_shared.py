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
    row = f"[...{side}.querySelectorAll('.favchip')].find(r => r.textContent.includes('pinned-in-files'))"
    page.wait(f"!!{row}", timeout=5)
    page.click_at(*page._center(row))
    page.wait(f"[...{side}.querySelectorAll('*')].some(n => n.textContent === '{folder}' || n.title === '{folder}') || "
              f"{side}.textContent.includes('pinned-in-files')", timeout=5)
    # Unpinned from the sidebar: from the list it belongs to.
    off = f"{row}.parentElement.querySelector('.favoff')"
    page.wait(f"!!{row}", timeout=5)
    x, y = page._center(row)
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})   # the × shows on hover
    page.click_at(*page._center(off))
    eventually(lambda: not any(f["path"] == str(folder) for f in argus.api("/api/favourites").get("main", [])),
               timeout=5, what="unpinned from Files' own list")
    time.sleep(0.3)
    assert not page.eval(f"!!{row}")


def test_the_favourites_are_a_section_of_the_rail_from_anywhere(make_page, argus):
    """Asked for as 'a new section in the sidebar': every list's stars, once each, a click away."""
    a = argus.root / "home" / "rail-fav-a"
    b = argus.root / "home" / "rail-fav-b"
    for d, g in ((a, "main"), (b, "sidebar")):
        d.mkdir(parents=True, exist_ok=True)
        argus.api("/api/favourites", "POST", {"path": str(d), "group": g})
    argus.api("/api/favourites", "POST", {"path": str(a), "group": "windows"})     # the same folder twice: shown once
    try:
        page = make_page(route="#/sessions")
        page.wait("!document.querySelector('#railfavs').hidden", timeout=10, what="the section")
        names = page.eval("[...document.querySelectorAll('#railfavs .railfav .railname')].map(b => b.textContent)")
        assert names.count("rail-fav-a") == 1 and "rail-fav-b" in names, names
        page.click_at(*page._center("[...document.querySelectorAll('#railfavs .railfav')].find(b => b.querySelector('.railname').textContent === 'rail-fav-b')"))
        page.wait(f"decodeURIComponent(location.hash).includes({str(b)!r})", timeout=5, what="Files, on that folder")
        # Unstarred from the rail: gone from every list it was in.
        argus.api("/api/prefs", "PATCH", {"changes": {"railWide": True}})
        page.reload()
        row = "[...document.querySelectorAll('#railfavs .railfav')].find(b => b.querySelector('.railname').textContent === 'rail-fav-a')"
        page.wait(f"!!{row}", timeout=10)
        x, y = page._center(row)
        page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
        page.click_at(*page._center(f"{row}.querySelector('.railunstar')"))
        page.wait(f"!{row}", timeout=5, what="unstarred, from the rail")
        favs = argus.api("/api/favourites")
        assert not any(f["path"] == str(a) for g in favs.values() for f in g), "from every list"
    finally:
        favs = argus.api("/api/favourites")
        for d, g in ((a, "main"), (b, "sidebar"), (a, "windows")):
            if any(f["path"] == str(d) for f in favs.get(g, [])):
                argus.api("/api/favourites", "POST", {"path": str(d), "group": g})


def test_a_long_rail_scrolls_and_says_there_is_more(make_page, argus):
    names = [f"long-rail-{i:02d}" for i in range(14)]
    for n in names:
        d = argus.root / "home" / n
        d.mkdir(parents=True, exist_ok=True)
        argus.api("/api/favourites", "POST", {"path": str(d), "group": "main"})
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"railWide": True}})
        page = make_page(route="#/sessions")
        page.send("Emulation.setDeviceMetricsOverride", {"width": 1300, "height": 620, "deviceScaleFactor": 1, "mobile": False})
        page.wait("!document.querySelector('#railfavs').hidden", timeout=10)
        nav = "document.querySelector('#nav')"
        page.wait(f"{nav}.scrollHeight > {nav}.clientHeight && !{nav}.querySelector('.railfade.bottom').hidden", timeout=5,
                  what="more below, said")
        assert page.eval(f"{nav}.querySelector('.railfade.top').hidden"), "nothing above yet"
        assert "more" in page.eval(f"{nav}.querySelector('.railmore').textContent").lower()
        page.click_at(*page._center(f"{nav}.querySelector('.railpill')"))
        page.wait(f"{nav}.scrollTop > 100 && !{nav}.querySelector('.railfade.top').hidden", timeout=5, what="scrolled, and more above now")
    finally:
        for n in names:
            argus.api("/api/favourites", "POST", {"path": str(argus.root / "home" / n), "group": "main"})

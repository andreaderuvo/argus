"""A browser window's search stays what you typed while you do something else in the window.

"When I filter it finds the folder, but as soon as I do something, like choosing an option, my
filter is reset" (2026-11-09). Every redraw of the listing — a view chosen, Refresh, a star, the
folder changing under it — drew the whole folder again, under a box still showing the words.
"""

from __future__ import annotations

import json
import time

WIN = "document.querySelector('.win[data-kind=browser]')"
BOX = f"{WIN}.querySelector('.pad.tools input[type=search]')"
NAMES = f"JSON.stringify([...{WIN}.querySelectorAll('.panelist .row .name, .panelist .tile .tilename')].map(n => n.textContent.trim()))"


def names(page):
    return json.loads(page.eval(NAMES))


def filtered(page, what):
    page.wait(f"(() => {{ const n = {NAMES}; return n !== '[]' && JSON.parse(n).every(x => x.includes('empty')); }})()",
              timeout=10, what=f"still filtered after {what}")
    assert page.eval(f"{BOX}.value") == "empty", what


def test_the_filter_survives_views_refresh_stars_and_changes(make_page, argus):
    r = argus.root
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": [
        {"kind": "browser", "id": 3, "path": str(r), "fresh": True},
    ]}]}})
    page = make_page(route="#/wall")
    page.wait(f"!!{WIN}?.querySelector('.panelist .row')", timeout=15)
    assert len(names(page)) > 3

    page.click_at(*page._center(BOX))
    page.type("empty")
    filtered(page, "typing")

    # A view: icons, then the list again.
    for view in ("Icons", "A list"):
        page.click_at(*page._center(f"[...{WIN}.querySelectorAll('.viewset button')].find(b => b.title === '{view}')"))
        time.sleep(0.6)
        filtered(page, f"the view {view}")

    # Refresh.
    page.click_at(*page._center(f"[...{WIN}.querySelectorAll('.sidehead button')].find(b => b.title === 'Refresh')"))
    time.sleep(0.6)
    filtered(page, "Refresh")

    # Choosing a row, then something that refreshes every browser (a new folder made elsewhere).
    page.click_at(*page._center(f"{WIN}.querySelector('.panelist .row')"), modifiers=2)
    time.sleep(0.3)
    argus.api("/api/fs/mkdir", "POST", {"path": str(r), "name": "another"})
    page.eval("import('/js/screens.js').then(m => m.refreshAllBrowsers())")
    time.sleep(0.8)
    filtered(page, "a refresh of every browser")

    # The folder changing under it: the 5 s watcher.
    (r / "empty-too").mkdir()
    page.wait(f"{NAMES}.includes('empty-too')", timeout=12, what="the watcher's redraw, still searching")
    filtered(page, "the watcher")

    # Emptying the box gives the folder back.
    page.eval(f"(() => {{ const b = {BOX}; b.value = ''; b.dispatchEvent(new Event('input')); }})()")
    page.wait(f"JSON.parse({NAMES}).length > 3", timeout=10, what="the whole folder again")


def test_the_sidebar_keeps_its_search_when_it_is_built_again(make_page, argus):
    """The sidebar is thrown away and built again on every refresh of the browsers."""
    argus.api("/api/prefs", "PATCH", {"changes": {"sidebar": True}})
    page = make_page(route="#/sessions")
    box = "document.querySelector('#side .pad.tools input[type=search]')"
    rows = "JSON.stringify([...document.querySelectorAll('#side .panelist .row .name')].map(n => n.textContent.trim()))"
    only = f"(() => {{ const n = JSON.parse({rows}); return n.length && n.every(x => x.includes('empty')); }})()"
    page.wait(f"!!{box} && document.querySelectorAll('#side .panelist .row').length > 3", timeout=15)
    page.click_at(*page._center(box))
    page.type("empty")
    page.wait(only, timeout=10, what="filtered")
    page.eval("import('/js/screens.js').then(m => m.refreshAllBrowsers())")
    time.sleep(1)
    page.wait(only, timeout=10, what="still filtered after the sidebar was built again")
    assert page.eval(f"{box}.value") == "empty"

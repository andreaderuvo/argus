"""On a phone the drawer is the sidebar: it scrolls, and every destination is in it.

"On mobile the sidebar does not scroll" (2026-11-15): the destinations, the favourite folders and the desks put
away were taller than the screen, and the drawer had no scroll of its own — what was past the bottom could not
be reached. And What agents can do, added since, was not in it at all."""

from __future__ import annotations

import time

from .cdp import PHONE


def test_a_long_drawer_scrolls_to_its_last_desk_and_has_every_destination(make_page, argus):
    desks = [{"id": 1, "name": "work", "desktop": []}]
    desks += [{"id": i + 2, "name": f"put away {i + 1}", "desktop": [], "hidden": True} for i in range(14)]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 20, "workspaces": desks}})
    page = make_page(viewport={**PHONE, "height": 640}, route="#/files")
    page.click_at(*page._center("document.getElementById('hamburger')"))
    page.wait("document.body.classList.contains('drawered')", what="the drawer")
    time.sleep(0.4)                                   # it slides in
    page.wait("document.querySelectorAll('#drawerdesks .raildesk').length === 14", what="the desks put away")
    tabs = page.eval("[...document.querySelectorAll('#drawer > a')].map(a => a.getAttribute('href'))")
    assert "#/agents" in tabs and "#/needs" in tabs and "#/journal" in tabs, tabs
    drawer = "document.getElementById('drawer')"
    assert page.eval(f"{drawer}.scrollHeight > {drawer}.clientHeight + 50"), "taller than the phone, for the test to mean anything"
    assert page.eval(f"getComputedStyle({drawer}).overflowY") in ("auto", "scroll")
    # A finger's swipe up, as a phone sends it, moves the drawer and not the page under it.
    x, y = page._center(f"{drawer}.querySelector('a')")
    page.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": 560}]})
    for step in range(1, 11):
        page.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": [{"x": x, "y": 560 - step * 45}]})
        time.sleep(0.02)
    page.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    page.wait(f"{drawer}.scrollTop > 100", what="the drawer scrolled by a swipe")
    last = "[...document.querySelectorAll('#drawerdesks .raildesk')].pop()"
    page.eval(f"{last}.scrollIntoView({{block: 'end'}}); 1")
    bottom = page.eval(f"{last}.getBoundingClientRect().bottom")
    assert bottom <= 641, f"the last desk reachable on screen ({bottom})"

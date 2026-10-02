"""Desks put away, on a phone: in the drawer, not in the bottom bar.

Reported from a Pixel: with the bottom bar on and four desks put away, the desks sat in the
footer as a stack of grey, unstyled buttons — the rail's list, drawn where the rail does not
exist. On a phone they belong to the drawer, and bringing one back from there must work.
"""

from __future__ import annotations

import time

from .cdp import PHONE
from .test_flows import eventually

PARKED = ["PhD Thesis GSSI", "genpat_paper", "genpat_efsa", "cims_training_report"]


def seed(argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"bottomBar": True, "ws": 1, "wsSeq": 5, "workspaces": [
        {"id": 1, "name": "argus", "desktop": []},
        *({"id": i + 2, "name": n, "desktop": [], "hidden": True} for i, n in enumerate(PARKED)),
    ]}})


def visible(page, selector):
    return page.eval(f"[...document.querySelectorAll({selector!r})].filter(e => e.getClientRects().length).map(e => e.textContent.trim())")


def test_parked_desks_are_not_in_the_bottom_bar_but_in_the_drawer(make_page, argus):
    seed(argus)
    page = make_page(viewport={**PHONE, "width": 412, "height": 915}, route="#/sessions")
    page.wait("document.querySelectorAll('#raildesks .raildesk').length === 4", timeout=10, what="the parked desks drawn")
    assert visible(page, "#raildesks .raildesk") == [], "nothing in the bottom bar"
    page.click_at(*page._center("document.querySelector('#more')"))
    page.wait("document.body.classList.contains('drawered')", timeout=5, what="the drawer")
    time.sleep(0.5)                                       # it slides in: a tap mid-slide lands elsewhere
    assert visible(page, "#drawerdesks .railname") == PARKED
    page.click_at(*page._center("[...document.querySelectorAll('#drawerdesks .raildesk')].find(b => b.textContent.includes('genpat_efsa'))"))
    page.wait("document.body.classList.contains('wall')", timeout=10, what="the desk it brought back")
    eventually(lambda: not next(w for w in argus.api("/api/prefs")["prefs"]["workspaces"] if w["name"] == "genpat_efsa").get("hidden"),
               timeout=10, what="the desk to be back")


def test_on_a_desktop_they_stay_in_the_rail(make_page, argus):
    seed(argus)
    page = make_page(route="#/sessions")
    page.wait("document.querySelectorAll('#raildesks .raildesk').length === 4", timeout=10, what="the parked desks drawn")
    assert len(visible(page, "#raildesks .raildesk")) == 4

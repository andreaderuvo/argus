"""`#/show?s=<session>`: the address that brings a session's window forward.

argus-bridge opens it when a notification is clicked on the computer, so that the click lands on the
agent that rang — on its desk, raised — rather than on whatever Argus had open ("when I click a
notification on the Mac it opens argus-bridge; it should take me to where it came from", 2026-11-23).
"""

from __future__ import annotations

from .test_flows import eventually


def _desks(argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Near", "desktop": [{"kind": "term", "name": "near"}]},
        {"id": 2, "name": "Far", "desktop": [{"kind": "term", "name": "far"}]}]}})


def _sessions(argus, *names):
    for name in names:
        argus.tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "20", "sleep 600")


def _end(argus, *names):
    for name in names:
        argus.tmux("kill-session", "-t", name, check=False)


ON_SCREEN = "[...document.querySelectorAll('.deck.on .win[data-kind=\"term\"] .wintitle')].map(t => t.textContent).join(',')"


def test_a_session_on_another_desk_is_brought_forward_from_the_address(make_page, argus):
    _sessions(argus, "near", "far")
    _desks(argus)
    try:
        page = make_page(route="#/wall")
        page.wait(f"{ON_SCREEN} === 'near'", timeout=15, what="the first desk on screen")
        page.eval("location.hash = '#/show?s=far'")
        page.wait(f"{ON_SCREEN} === 'far'", timeout=10, what="the desk holding the session made the one on screen")
        assert page.eval("location.hash").startswith("#/wall"), "the address is the desk's again"
    finally:
        _end(argus, "near", "far")


def test_opening_argus_on_the_address_lands_on_the_session(make_page, argus):
    _sessions(argus, "near", "far")
    _desks(argus)
    try:
        page = make_page(route=None)
        # The address set without a hashchange, then loaded: what a window opened on it does.
        page.eval("history.replaceState(null, '', location.pathname + '#/show?s=far'); location.reload()")
        page.wait(f"{ON_SCREEN} === 'far'", timeout=15, what="Argus opened on the session's desk")
        assert page.eval("location.hash").startswith("#/wall")
    finally:
        _end(argus, "near", "far")


def test_a_session_on_no_desk_is_shown_full_screen(make_page, argus):
    _sessions(argus, "near", "alone")
    _desks(argus)
    try:
        page = make_page(route="#/wall")
        page.wait(f"{ON_SCREEN} === 'near'", timeout=15)
        page.eval("location.hash = '#/show?s=alone'")
        eventually(lambda: page.eval("location.hash") == "#/term?s=alone", timeout=10, what="the session full screen")
    finally:
        _end(argus, "near", "alone")

"""Moving between screens is not a navigation.

argus-bridge's window on a Mac reloaded under clicks: WebKit (macOS 26) answered `location.hash = …` with a
process swap "due to EnhancedSecurity change" and loaded the window's first address again, losing what had
just been opened (2026-11-25/26, read in the Mac's log). `go()` and links to a screen now use pushState and send
the `hashchange` themselves; these check that every way of moving still lands, Back included.
"""

from __future__ import annotations

from .test_flows import eventually

ON_WALL = "!!document.querySelector('.deck.on')"


def test_go_links_and_back_still_move_between_screens(make_page, argus):
    page = make_page(route="#/wall")
    page.wait(ON_WALL, timeout=15, what="the wall")
    page.eval("window.__same = 1; window.__navs = performance.getEntriesByType('navigation').length")

    page.eval("import('/js/router.js').then(m => m.go('#/notes'))")
    eventually(lambda: page.eval("location.hash") == "#/notes", timeout=5, what="go() changed the address")
    # Drawn before moving on: a screen still loading its module when the next one is asked for is another
    # matter (the notes screen lands late and covers the wall).
    page.wait("!!document.querySelector('#view .notesscreen')", timeout=10, what="the notes screen")

    # A link to a screen, clicked.
    page.eval("""(() => { const a = document.createElement('a'); a.href = '#/wall'; a.id = 'golink';
                          a.textContent = 'x'; document.body.append(a); a.click(); })()""")
    eventually(lambda: page.eval("location.hash") == "#/wall", timeout=5, what="the link followed")
    page.wait(ON_WALL, timeout=10, what="the wall again")

    page.eval("history.back()")
    eventually(lambda: page.eval("location.hash") == "#/notes", timeout=5, what="Back")
    page.eval("history.forward()")
    eventually(lambda: page.eval("location.hash") == "#/wall", timeout=5, what="Forward")
    page.wait(ON_WALL, timeout=10, what="the wall after Forward")

    assert page.eval("window.__same") == 1, "the page was loaded again"
    assert page.eval("window.argusGo === undefined") is False, "argus-bridge's way in is there"

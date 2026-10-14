"""A drag that is taken away (pointercancel, a lost capture) ends like a release: the window was
left `dragging` — pointer-events: none — and ignored every click after, its ✕ included."""

from __future__ import annotations

from .test_close_window import CROSS, MENU

BAR = "document.querySelector('.win[data-session=\"frozen\"] .wintitle')"


def test_a_cancelled_drag_leaves_the_window_clickable(make_page, argus):
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "frozen", "-x", "80", "-y", "24")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "frozen"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait(f"!!{CROSS % 'frozen'}", timeout=15)
    page.wait(f"!!{BAR}", timeout=5)
    r = page.eval(f"(b => {{ const r = b.getBoundingClientRect(); return [r.x + 40, r.y + r.height / 2]; }})({BAR})")
    page.send("Input.dispatchMouseEvent", {"type": "mousePressed", "x": r[0], "y": r[1], "button": "left", "clickCount": 1})
    page.wait("!!document.querySelector('.win.dragging')", timeout=5, what="a drag begun")
    page.eval(f"{BAR}.dispatchEvent(new PointerEvent('pointercancel', {{ pointerId: 1, bubbles: true }}))")
    assert not page.eval("!!document.querySelector('.win.dragging')"), "taken away: the drag is over"
    page.send("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": r[0], "y": r[1], "button": "left", "clickCount": 1})
    # And a window left see-through by anything else gets its clicks back at the next press.
    page.eval("document.querySelector('.win').classList.add('dragging')")
    page.click_at(*page._center(CROSS % "frozen"))          # this press goes through it, and ends that
    page.wait("!document.querySelector('.win.dragging')", timeout=5)
    page.click_at(*page._center(CROSS % "frozen"))
    page.wait(f"{MENU}.length === 2", timeout=5, what="the ✕ answers")
    argus.kill_sessions()

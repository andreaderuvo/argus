"""The dock: a window put away along the bottom of the desk, as on a Mac, and brought back.

"A dock like the Mac's at the bottom: reduce a window and it goes there, so that a layout is made
of the visible ones; a window I will not need for a while" (2026-11-03). A docked terminal keeps
running — still attached, and tmux never told it shrank to nothing.
"""

from __future__ import annotations

import json
import time

from .test_flows import eventually


def test_a_window_goes_to_the_dock_out_of_the_layout_and_comes_back(make_page, argus):
    r = argus.root
    argus.tmux("new-session", "-d", "-s", "docked", "-x", "100", "-y", "30")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": [
        {"kind": "term", "name": "docked"},
        {"kind": "file", "path": str(r / "notes.txt")},
        {"kind": "browser", "id": 3, "path": str(r / "docs"), "fresh": True}]}]}})
    try:
        page = make_page(route="#/wall")
        term = "document.querySelector('.win[data-session=\"docked\"]')"
        page.wait(f"!!{term}?.querySelector('.xterm-screen')", timeout=20)
        time.sleep(1.2)
        width_before = int(argus.tmux("display", "-p", "-t", "docked", "#{window_width}").stdout.strip())

        page.click_at(*page._center(f"{term}.querySelector('.dockbtn')"))
        page.wait(f"{term}.hidden && !document.querySelector('.windock').hidden", timeout=5, what="docked")
        chips = json.loads(page.eval("JSON.stringify([...document.querySelectorAll('.windock .dockchip')].map(c => c.textContent))"))
        assert chips == ["docked"], chips
        eventually(lambda: any(w.get("docked") for w in argus.api("/api/prefs")["prefs"]["workspaces"][0]["desktop"]
                               if w.get("name") == "docked"), timeout=5, what="kept with the desk")

        # A layout is made of what is on the desk: the two others share the room, above the dock.
        page.eval("import('/js/wall.js').then(m => m.arrangeDesk('cols'))")
        time.sleep(0.8)
        boxes = json.loads(page.eval("""JSON.stringify([...document.querySelectorAll('.win')].filter(w => !w.hidden)
          .map(w => { const b = w.getBoundingClientRect(); return [b.left, b.width, b.bottom]; }))"""))
        dock_top = page.eval("document.querySelector('.windock').getBoundingClientRect().top")
        assert len(boxes) == 2 and all(b[2] <= dock_top + 1 for b in boxes), (boxes, dock_top)
        assert abs(boxes[0][1] - boxes[1][1]) < 4, "the two halves, nothing kept for the docked one"

        # Still running, and tmux was never told it is tiny.
        assert "docked" in argus.sessions()
        assert int(argus.tmux("display", "-p", "-t", "docked", "#{window_width}").stdout.strip()) >= min(width_before, 40)

        # A reload keeps it docked; a press brings it back.
        page.reload()
        page.wait("!!document.querySelector('.windock .dockchip')", timeout=20, what="still in the dock after a reload")
        page.click_at(*page._center("document.querySelector('.windock .dockchip')"))
        page.wait(f"!{term}.hidden && document.querySelector('.windock').hidden", timeout=5, what="back on the desk")
        eventually(lambda: not any(w.get("docked") for w in argus.api("/api/prefs")["prefs"]["workspaces"][0]["desktop"]),
                   timeout=5, what="and saved so")
    finally:
        argus.tmux("kill-session", "-t", "docked", check=False)

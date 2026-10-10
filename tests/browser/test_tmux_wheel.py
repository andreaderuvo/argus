"""The wheel moves tmux's history as far as the fingers moved (static/js/tmuxwheel.js).

xterm.js 6.0.0 sends one mouse report per wheel event, whatever the distance: a fast flick was
worth the same five lines as a nudge, and the phone's drag — which asks for several turns in one
event — got one. Reported as "scrolling in tmux feels slow" (2026-10-10). Counted here as the
mouse reports a program holding the mouse receives through tmux.
"""

from __future__ import annotations

import time

RECORDER = r'''#!/usr/bin/env python3
import os, sys, tty
tty.setraw(0)
os.write(1, b"\x1b[?1000h\x1b[?1006h")          # the mouse, as an agent asks for it
out = open(sys.argv[1], "ab", buffering=0)
while True:
    b = os.read(0, 1024)
    if not b: break
    out.write(b)
'''


def setup(make_page, argus, tmp_path):
    rec = tmp_path / "rec.py"
    rec.write_text(RECORDER)
    rec.chmod(0o755)
    log = tmp_path / "bytes.bin"
    argus.tmux("new-session", "-d", "-s", "rec", "-x", "80", "-y", "20", f"{rec} {log}")
    argus.tmux("set", "-g", "mouse", "on")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "W", "desktop": [{"kind": "term", "name": "rec"}]}]}})
    page = make_page(route="#/wall")
    scr = "document.querySelector('.win[data-session=\"rec\"] .xterm-screen')"
    page.wait(f"!!{scr} && document.querySelector('.win[data-session=\"rec\"] .xterm')?.classList.contains('enable-mouse-events')",
              timeout=15, what="the program holding the mouse")
    x, y = page.eval(f"(r => [r.left + r.width / 2, r.top + r.height / 2])({scr}.getBoundingClientRect())")
    time.sleep(0.8)                                       # fitted, and tmux told the size
    rows = int(argus.tmux("display", "-p", "-t", "rec", "#{pane_height}").stdout.strip() or 20)
    cell = page.eval(f"{scr}.getBoundingClientRect().height") / rows

    def ups():
        data = log.read_bytes() if log.exists() else b""
        return data.count(b"\x1b[<64;"), data.count(b"\x1b[<65;")

    def wheel(dy, n=1):
        for _ in range(n):
            page.send("Input.dispatchMouseEvent", {"type": "mouseWheel", "x": x, "y": y, "deltaX": 0, "deltaY": dy})
            time.sleep(0.02)
        time.sleep(0.5)
    return page, ups, wheel, cell


def test_a_flick_is_worth_its_distance_not_one_report(make_page, argus, tmp_path):
    page, ups, wheel, cell = setup(make_page, argus, tmp_path)
    try:
        before = ups()[0]
        wheel(-cell * 25)                      # one fast flick: 25 lines of movement
        got = ups()[0] - before
        assert 4 <= got <= 7, f"{got} reports: 25 lines at 5 a report, plus the one entering copy mode"
        before = ups()[1]
        wheel(cell * 1, n=10)                  # a slow drag down, a line at a time
        assert ups()[1] - before == 2, "carried: ten lines of movement are two reports"
    finally:
        argus.tmux("kill-session", "-t", "rec", check=False)


def test_the_phone_drag_gets_every_turn_it_asks_for(make_page, argus, tmp_path):
    page, ups, wheel, cell = setup(make_page, argus, tmp_path)
    try:
        before = ups()[0]
        page.eval("document.querySelector('.win[data-session=\"rec\"] .xterm-screen').dispatchEvent("
                  "new WheelEvent('wheel', { deltaY: -3, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true }))")
        time.sleep(0.5)
        assert ups()[0] - before == 4, "three turns asked by the drag, plus the one entering copy mode"
    finally:
        argus.tmux("kill-session", "-t", "rec", check=False)

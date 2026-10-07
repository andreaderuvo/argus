"""Text selected in one terminal of a desk is offered to the others, and typed in — not sent.

Checked by effect, as every terminal test here is: the selected line is a command that makes a
file, it is handed to the other session, and only the Enter the test presses runs it.
"""

from __future__ import annotations

import time

from .test_flows import eventually


def test_a_selection_is_typed_into_the_other_session_of_the_desk(make_page, argus):
    marker = argus.root / "home" / "handed-over"
    if marker.exists():
        marker.unlink()
    # Short enough for one row: a selection of one row is what is handed over.
    argus.tmux("new-session", "-d", "-s", "worker", "-x", "80", "-y", "12",
               "sh -c 'echo touch handed-over; sleep 600'")
    argus.tmux("new-session", "-d", "-s", "reviewer", "-x", "80", "-y", "12", "-c", str(marker.parent))
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Pair", "desktop": [{"kind": "term", "name": "worker"}, {"kind": "term", "name": "reviewer"}]},
    ]}})
    page = make_page(route="#/wall")
    screen = "document.querySelector('.win[data-session=\"worker\"] .xterm-screen')"
    page.wait(f"!!{screen} && {screen}.getBoundingClientRect().width > 100", timeout=15, what="the worker's terminal")
    page.wait("!!document.querySelector('.win[data-session=\"reviewer\"] .xterm-screen')", timeout=15, what="the reviewer's")
    time.sleep(1.5)                                        # the echo has been drawn

    # A drag along the first row, the way a person selects a line.
    box = page.eval(f"JSON.stringify((r => [r.left, r.top, r.width, r.height])({screen}.getBoundingClientRect()))")
    import json
    left, top, width, height = json.loads(box)
    row = top + 5                                         # the first row: the terminal is fitted to its window, so rows are not 12
    # `buttons` as well as `button`: a move without it is a move with nothing held, not a drag.
    mouse = lambda kind, x, button="left": page.send("Input.dispatchMouseEvent", {
        "type": kind, "x": x, "y": row, "button": button, "clickCount": 1,
        "buttons": 1 if button == "left" and kind != "mouseReleased" else 0})
    mouse("mouseMoved", left + 2, "none")
    mouse("mousePressed", left + 2)
    for step in range(1, 9):
        mouse("mouseMoved", left + 2 + (width - 8) * step / 8, "left")
    mouse("mouseReleased", left + width - 6)

    page.wait("!!document.querySelector('.selofferpill')", timeout=5, what="the offer where the mouse let go")
    assert "reviewer" in page.eval("document.querySelector('.selofferpill').textContent"), "one other session: named on the button"
    page.click_at(*page._center("document.querySelector('.selofferpill')"))
    page.wait("!document.querySelector('.seloffer')", timeout=5, what="the offer to go once used")

    time.sleep(0.8)
    assert not marker.exists(), "typed, not sent: the Enter is the person's"
    argus.tmux("send-keys", "-t", "reviewer", "Enter")
    eventually(marker.exists, timeout=10, what="the handed-over command to run in the reviewer")
    for s in ("worker", "reviewer"):
        argus.tmux("kill-session", "-t", s, check=False)


def test_nothing_is_offered_in_a_desk_with_one_terminal(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "alone", "-x", "80", "-y", "12", "sh -c 'echo some words here; sleep 600'")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Solo", "desktop": [{"kind": "term", "name": "alone"}]},
    ]}})
    page = make_page(route="#/wall")
    screen = "document.querySelector('.win[data-session=\"alone\"] .xterm-screen')"
    page.wait(f"!!{screen} && {screen}.getBoundingClientRect().width > 100", timeout=15, what="the terminal")
    time.sleep(1.5)
    import json
    left, top, width, height = json.loads(page.eval(f"JSON.stringify((r => [r.left, r.top, r.width, r.height])({screen}.getBoundingClientRect()))"))
    row = top + 5                                         # the first row: the terminal is fitted to its window, so rows are not 12
    for kind, x, b in (("mouseMoved", left + 2, "none"), ("mousePressed", left + 2, "left"),
                       ("mouseMoved", left + width / 2, "left"), ("mouseReleased", left + width / 2, "left")):
        page.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": row, "button": b, "clickCount": 1,
                                                "buttons": 1 if b == "left" and kind != "mouseReleased" else 0})
    time.sleep(0.6)
    assert not page.eval("!!document.querySelector('.seloffer')")
    argus.tmux("kill-session", "-t", "alone", check=False)


def test_with_tmux_holding_the_mouse_its_own_selection_is_offered(make_page, argus):
    """The usual setup: `mouse on` and `set-clipboard on`. The browser never sees a selection —
    tmux makes it and copies it, and the copy arrives as OSC 52 just after the release."""
    marker = argus.root / "home" / "handed-over-2"
    if marker.exists():
        marker.unlink()
    argus.tmux("new-session", "-d", "-s", "worker2", "-x", "80", "-y", "12",
               "sh -c 'echo touch handed-over-2; sleep 600'")
    argus.tmux("new-session", "-d", "-s", "reviewer2", "-x", "80", "-y", "12", "-c", str(marker.parent))
    argus.tmux("set", "-g", "mouse", "on")
    argus.tmux("set", "-g", "set-clipboard", "on")
    argus.tmux("set", "-as", "terminal-features", ",xterm-256color:clipboard")
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
            {"id": 1, "name": "Pair", "desktop": [{"kind": "term", "name": "worker2"}, {"kind": "term", "name": "reviewer2"}]},
        ]}})
        page = make_page(route="#/wall")
        screen = "document.querySelector('.win[data-session=\"worker2\"] .xterm-screen')"
        page.wait(f"!!{screen} && {screen}.getBoundingClientRect().width > 100", timeout=15, what="the worker's terminal")
        page.wait("!!document.querySelector('.win[data-session=\"reviewer2\"] .xterm-screen')", timeout=15, what="the reviewer's")
        time.sleep(1.5)
        import json
        left, top, width, height = json.loads(page.eval(f"JSON.stringify((r => [r.left, r.top, r.width, r.height])({screen}.getBoundingClientRect()))"))
        row = top + 5
        for kind, x, b in [("mouseMoved", left + 2, "none"), ("mousePressed", left + 2, "left")] + \
                [("mouseMoved", left + 2 + (width - 8) * s / 8, "left") for s in range(1, 9)] + \
                [("mouseReleased", left + width - 6, "left")]:
            page.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": row, "button": b, "clickCount": 1,
                                                    "buttons": 1 if b == "left" and kind != "mouseReleased" else 0})
            time.sleep(0.03)
        page.wait("!!document.querySelector('.selofferpill')", timeout=5, what="the offer, from tmux's copy")
        page.click_at(*page._center("document.querySelector('.selofferpill')"))
        time.sleep(0.8)
        assert not marker.exists()
        argus.tmux("send-keys", "-t", "reviewer2", "Enter")
        eventually(marker.exists, timeout=10, what="the command tmux selected, run in the reviewer")
    finally:
        argus.tmux("set", "-g", "mouse", "off", check=False)
        argus.tmux("set", "-gu", "set-clipboard", check=False)
        for s in ("worker2", "reviewer2"):
            argus.tmux("kill-session", "-t", s, check=False)



KEEPS_MOUSE = r"""#!/usr/bin/env python3
import sys, time
# What Claude Code and Codex do: the alternate screen, and every mouse event reported to them.
sys.stdout.write('\x1b[?1049h\x1b[?1003h\x1b[?1006h')
sys.stdout.write('touch shift-selected\n')
sys.stdout.flush()
time.sleep(600)
"""


def test_over_an_agent_that_keeps_the_mouse_shift_selects_and_a_plain_drag_says_so(make_page, argus, tmp_path):
    """Claude Code and Codex turn on mouse reporting: a drag goes to them and selects nothing.
    Shift-drag selects in xterm anyway; a plain drag is told about Shift, once."""
    for name in ("claude",):
        (tmp_path / name).write_text(KEEPS_MOUSE)
        (tmp_path / name).chmod(0o755)
    marker = argus.root / "home" / "shift-selected"
    if marker.exists():
        marker.unlink()
    argus.tmux("new-session", "-d", "-s", "keeper", "-x", "80", "-y", "12", str(tmp_path / "claude"))
    argus.tmux("new-session", "-d", "-s", "taker", "-x", "80", "-y", "12", "-c", str(marker.parent))
    argus.tmux("set", "-g", "mouse", "on")
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
            {"id": 1, "name": "Pair", "desktop": [{"kind": "term", "name": "keeper"}, {"kind": "term", "name": "taker"}]},
        ]}})
        page = make_page(route="#/wall")
        screen = "document.querySelector('.win[data-session=\"keeper\"] .xterm-screen')"
        page.wait(f"!!{screen} && {screen}.getBoundingClientRect().width > 100", timeout=15, what="the keeper's terminal")
        page.wait("!!document.querySelector('.win[data-session=\"taker\"] .xterm-screen')", timeout=15, what="the taker's")
        time.sleep(1.5)
        import json
        left, top, width, height = json.loads(page.eval(f"JSON.stringify((r => [r.left, r.top, r.width, r.height])({screen}.getBoundingClientRect()))"))
        row = top + 5

        def drag(modifiers):
            for kind, x, b in [("mouseMoved", left + 2, "none"), ("mousePressed", left + 2, "left")] + \
                    [("mouseMoved", left + 2 + (width - 8) * s / 8, "left") for s in range(1, 9)] + \
                    [("mouseReleased", left + width - 6, "left")]:
                page.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": row, "button": b, "clickCount": 1,
                                                        "modifiers": modifiers,
                                                        "buttons": 1 if b == "left" and kind != "mouseReleased" else 0})
                time.sleep(0.02)

        page.wait("document.querySelector('.win[data-session=\"keeper\"] .xterm')?.classList.contains('enable-mouse-events')",
                  timeout=10, what="the program to have the mouse")
        drag(0)
        page.wait("[...document.querySelectorAll('.toast, .toasts *')].some(e => e.textContent.includes('hold Shift'))",
                  timeout=5, what="being told about Shift")
        assert not page.eval("!!document.querySelector('.seloffer')"), "a plain drag selected nothing"
        # The hint sits in the bottom-right corner, over the end of the next drag: closed, as a person would.
        page.eval("document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
        drag(8)                                            # 8 = Shift
        page.wait("!!document.querySelector('.selofferpill')", timeout=5, what="the offer, after a Shift-drag")
        page.click_at(*page._center("document.querySelector('.selofferpill')"))
        time.sleep(0.8)
        argus.tmux("send-keys", "-t", "taker", "Enter")
        eventually(marker.exists, timeout=10, what="the line selected with Shift, run in the taker")
    finally:
        argus.tmux("set", "-g", "mouse", "off", check=False)
        for s in ("keeper", "taker"):
            argus.tmux("kill-session", "-t", s, check=False)

"""Learning the shortcuts without learning a list (shortcuts.js, "learning them").

The key on the button's tooltip; Ctrl held alone shows every key over its button; a mouse click on
something that has a key says "next time: …" three times, then never; and the desk's Ctrl+Shift
chords work with a terminal focused — on a desk the focus is nearly always in one, and Ctrl+Shift+G
did nothing there (reported from a Mac, 2026-10-09).
"""

from __future__ import annotations

import time

from .test_agentstate import agents
from .test_flows import eventually


def hold_ctrl(page):
    page.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "key": "Control", "code": "ControlLeft",
                                         "windowsVirtualKeyCode": 17, "modifiers": 2})


def let_go(page):
    page.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Control", "code": "ControlLeft", "windowsVirtualKeyCode": 17})


def test_holding_ctrl_shows_each_key_over_its_button(make_page, argus):
    page = make_page(route="#/wall")
    page.wait("!!document.querySelector('#walltools button')", timeout=15)
    hold_ctrl(page)
    page.wait("document.querySelectorAll('.keytip').length > 3", timeout=3, what="the keys over their buttons")
    # The letter on the button, the chord by its colour, and the chords said once in the legend.
    shown = page.eval("[...document.querySelectorAll('.keytip')].map(k => k.className.split(' ').pop() + ':' + k.textContent)")
    assert "m-cs:X" in shown and "m-ca:F" in shown and "m-full:?" in shown, shown
    legend = page.text(".keytipsfoot")
    assert "Ctrl+Alt" in legend and "Ctrl+Shift" in legend and "this desk" in legend, legend
    let_go(page)
    page.wait("!document.querySelector('.keytips')", timeout=3, what="gone when Ctrl is let go")
    # A quick Ctrl (part of a combination) shows nothing.
    hold_ctrl(page)
    page.key("k", modifiers=2)
    time.sleep(0.9)
    assert not page.eval("!!document.querySelector('.keytips')")
    let_go(page)


def test_the_key_is_on_the_tooltip_and_a_click_teaches_it_three_times(make_page, argus):
    page = make_page(route="#/files")
    link = "document.querySelector('#nav a[data-tab=\"sessions\"]')"
    page.wait(f"!!{link}", timeout=10)
    x, y = page._center(link)
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    page.wait(f"{link}.title.endsWith('· Ctrl+Alt+S')", timeout=3, what="the key on the tooltip")
    for n in range(4):
        page.eval("document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
        page.click_at(*page._center(link))
        time.sleep(0.4)
        said = page.eval("[...document.querySelectorAll('#toasts .toast')].map(t => t.textContent).join('|')")
        if n < 3:
            assert "next time: Ctrl+Alt+S" in said, (n, said)
        else:
            assert "next time" not in said, "three times, then never"
        page.eval("location.hash = '#/files'")
        time.sleep(0.3)
    # A key used is a key learnt: no teaching for it at all.
    page.eval("document.querySelectorAll('#toasts .toast').forEach(t => t.remove())")
    page.key("f", code="KeyF", modifiers=2 | 1)              # Ctrl+Alt+F: Files
    page.wait("location.hash.startsWith('#/files')", timeout=3)
    eventually(lambda: (argus.api("/api/prefs")["prefs"].get("keyTaught") or {}).get("files") == 99, timeout=5, what="learnt")


def test_the_sidebar_keys_work_with_a_terminal_focused_unless_left_to_it(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "work", "-x", "80", "-y", "20")
    try:
        argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
            {"id": 1, "name": "Work", "desktop": [{"kind": "term", "name": "work"}]}]}})
        page = make_page(route="#/wall")
        area = "document.querySelector('.win[data-session=\"work\"] .xterm-helper-textarea')"
        page.wait(f"!!{area}", timeout=15, what="the terminal")
        page.eval(f"{area}.focus()")
        page.key("s", code="KeyS", modifiers=2 | 1)            # Ctrl+Alt+S: Sessions, from inside the terminal
        page.wait("location.hash.startsWith('#/sessions')", timeout=5, what="Sessions, without clicking out first")
        # Left to the terminal by choice (Emacs's C-M-…): the key goes to it, Argus stays put.
        argus.api("/api/prefs", "PATCH", {"changes": {"termCtrlAlt": False}})
        page.eval("location.hash = '#/wall'; location.reload()")
        page.wait(f"!!{area}", timeout=15, what="the terminal again")
        time.sleep(0.8)
        page.eval(f"{area}.focus()")
        page.key("s", code="KeyS", modifiers=2 | 1)
        time.sleep(0.8)
        assert page.eval("location.hash").startswith("#/wall"), "left to the terminal"
    finally:
        argus.tmux("kill-session", "-t", "work", check=False)


def test_got_it_all_by_its_key_with_a_terminal_focused(make_page, argus, tmp_path):
    argus.kill_sessions()
    agents(tmp_path, argus, spin_for=2)
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "One", "desktop": [{"kind": "term", "name": "busy"}]},
        {"id": 2, "name": "Two", "desktop": [{"kind": "term", "name": "asking"}]}]}})
    page = make_page(route="#/wall")
    button = "document.querySelector('.deskallseen')"
    page.wait(f"{button} && !{button}.hidden", timeout=25, what="something waiting")

    def settled():
        st = argus.api("/api/tmux/states")["states"]
        return all(st.get(n, {}).get("state") == "waiting" and time.time() - st[n]["since"] > 4 for n in ("busy", "asking"))
    eventually(settled, timeout=25, what="both waits to settle")
    page.eval("document.querySelector('.win[data-session=\"busy\"] .xterm-helper-textarea').focus()")
    assert page.eval("!!document.activeElement.closest('.xterm')"), "the terminal has the keyboard"
    page.key("g", code="KeyG", modifiers=2 | 8)               # Ctrl+Shift+G
    page.wait(f"{button}.hidden", timeout=5, what="Got it, all — from inside the terminal")

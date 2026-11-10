"""Alt+V, "Which Argus is running": the version, the plugin in each agent, and the sessions still on an
older plugin — the shortcut for "is everything up to date?" ("a shortcut used to show the updates",
2026-11-10). Pressed as a person presses it, with the focus in a desk and in a screen."""

from __future__ import annotations


def test_alt_v_says_which_argus_and_which_plugin(make_page):
    for route in ("#/files", "#/wall"):
        page = make_page(route=route)
        page.wait("!!document.querySelector('#view')", timeout=10)
        page.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Alt", "code": "AltLeft", "modifiers": 1})
        page.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "v", "code": "KeyV", "modifiers": 1,
                                             "windowsVirtualKeyCode": 86})
        page.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "v", "code": "KeyV", "modifiers": 1, "windowsVirtualKeyCode": 86})
        page.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Alt", "code": "AltLeft"})
        page.wait("!!document.querySelector('dialog[open]') && document.querySelector('dialog[open]').textContent.includes('plugin')",
                  timeout=10, what=f"the sheet, from {route}")
        page.key("Escape")


def test_alt_v_from_a_terminal(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "shellv", "-x", "100", "-y", "30")
    page = make_page(route="#/wall")
    page.eval("import('/js/tray.js').then(m => m.openWindow({ kind: 'term', name: 'shellv' }))")
    page.wait("!!document.querySelector('.xterm-helper-textarea')", timeout=15, what="the terminal")
    page.eval("document.querySelector('.xterm-helper-textarea').focus()")
    for kind in ("keyDown", "keyUp"):
        page.send("Input.dispatchKeyEvent", {"type": kind, "key": "v", "code": "KeyV", "modifiers": 1, "windowsVirtualKeyCode": 86})
    page.wait("!!document.querySelector('dialog[open]')", timeout=5, what="the sheet, from a terminal")

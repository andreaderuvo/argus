"""The keyboard goes to the terminal you came for: "when a session opens, put the focus in tmux —
otherwise I have to click in it every time" (2026-10-15). Arriving on a desk, opening a session on
it, switching desks, pressing a window's title bar — each left the keyboard nowhere."""

from __future__ import annotations

import time

FOCUSED = ("document.activeElement?.classList.contains('xterm-helper-textarea')"
           " ? (document.activeElement.closest('.win')?.dataset.session || 'fullscreen') : null")


def typing_in(page, expect, what):
    page.wait(f"({FOCUSED}) === {expect!r}", timeout=6, what=what)


def test_the_keyboard_follows_the_session_you_open(make_page, argus):
    argus.kill_sessions()
    for n in ("one", "two", "three"):
        argus.tmux("new-session", "-d", "-s", n, "-x", "90", "-y", "25")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "A", "desktop": [{"kind": "term", "name": "one"}]},
        {"id": 2, "name": "B", "desktop": [{"kind": "term", "name": "two"}]}]}})
    page = make_page(route="#/sessions")
    page.wait("document.querySelectorAll('.rowwrap.sess').length >= 3")
    page.click_text("three", within="a.row")
    typing_in(page, "fullscreen", "a session opened from Sessions")
    page.eval("location.hash = '#/wall?ws=1'")
    typing_in(page, "one", "arriving on a desk")
    page.eval("import('/js/tray.js').then(m => m.openWindow({ kind: 'term', name: 'three' }))")
    typing_in(page, "three", "a session opened on the desk")
    page.eval("[...document.querySelectorAll('.wstab')].find(t => t.textContent.includes('B')).click()")
    typing_in(page, "two", "switching desk")
    page.eval("[...document.querySelectorAll('.wstab')].find(t => t.textContent.includes('A')).click()")
    typing_in(page, "three", "back on a desk: the terminal used last there")
    argus.kill_sessions()


def test_a_press_on_a_title_bar_gives_its_terminal_the_keyboard_and_a_field_keeps_it(make_page, argus):
    argus.kill_sessions()
    for n in ("one", "two"):
        argus.tmux("new-session", "-d", "-s", n, "-x", "90", "-y", "25")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "A", "desktop": [{"kind": "term", "name": "one"}, {"kind": "term", "name": "two"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("!!document.querySelector('.win[data-session=\"two\"] .xterm-helper-textarea')", timeout=15)
    page.eval("[...document.querySelectorAll('button')].find(b => (b.title || '').includes('Arrange as columns'))?.click()")
    time.sleep(0.8)
    page.click_at(*page._center("document.querySelector('.win[data-session=\"two\"] .wintitle')"))
    typing_in(page, "two", "the window whose bar was pressed")
    page.click_at(*page._center("document.querySelector('.win[data-session=\"one\"] .wintitle')"))
    typing_in(page, "one", "and the other one")
    # Somebody typing in a field is never interrupted by a desk switch's focus.
    page.eval("const f = document.createElement('input'); f.id = 'typing'; document.body.append(f); f.focus();"
              "import('/js/tray.js').then(m => m.openWindow({ kind: 'term', name: 'two' }, undefined, { jump: false }))")
    time.sleep(0.6)
    assert page.eval("document.activeElement.id") == "typing"
    argus.kill_sessions()

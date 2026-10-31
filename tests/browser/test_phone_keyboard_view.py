"""On a phone, what is being typed stays above the keyboard (static/js/keyboard.js).

"On the phone the keyboard sometimes comes up over the prompt box and you cannot see what you are
typing" (2026-10-31). A headless browser shows no keyboard, so its effect is played: the visible
area shrinks, as visualViewport reports it on a phone, and the page must follow.
"""

from __future__ import annotations

import json

from .cdp import PHONE


def test_a_box_in_a_sheet_stays_above_the_keyboard(make_page, argus):
    page = make_page(viewport=PHONE, route="#/notes")
    page.wait("!!document.querySelector('.notesapp')", timeout=10)
    # A sheet with a field: the notes' filter is on the page; take a dialog with an input instead.
    page.eval("import('/js/dialogs.js').then(m => { window.__asked = m.ask('Name it', 'a long default value', 'OK'); })")
    page.wait("!!document.querySelector('dialog[open] input')", timeout=5)
    page.eval("document.querySelector('dialog[open] input').focus()")
    height = 300
    page.eval(f"import('/js/keyboard.js').then(m => m.fitToVisible({height}, 140))")
    page.wait("document.documentElement.classList.contains('keysup')", timeout=3, what="the keyboard noticed")
    got = json.loads(page.eval("""JSON.stringify({
      body: document.body.getBoundingClientRect().height,
      sheet: document.querySelector('dialog[open]').getBoundingClientRect().bottom,
      field: document.querySelector('dialog[open] input').getBoundingClientRect().bottom,
      scrolled: window.scrollY })"""))
    assert abs(got["body"] - height) < 2, got
    assert got["field"] <= height and got["sheet"] <= height + 1, f"the field is under the keyboard: {got}"
    assert got["scrolled"] == 0, "Safari's scroll taken back"

    # The keyboard goes: everything as it was.
    full = PHONE["height"]
    page.eval(f"import('/js/keyboard.js').then(m => m.fitToVisible({full}, 0))")
    page.wait("!document.documentElement.classList.contains('keysup') && document.body.style.height === ''", timeout=3)


def test_android_shrinks_the_page_itself(make_page):
    """The viewport meta asks Chrome on Android to resize the content with the keyboard."""
    page = make_page(viewport=PHONE, route="#/files")
    meta = page.eval("document.querySelector('meta[name=viewport]').content")
    assert "interactive-widget=resizes-content" in meta, meta


def test_a_sessions_last_line_stays_above_the_keyboard(make_page, argus):
    """The prompt of an agent is the terminal's last line: with the keyboard up the terminal re-fits
    to what is visible, and its key bar stays in sight under it."""
    argus.tmux("new-session", "-d", "-s", "typing", "-x", "40", "-y", "20")
    try:
        page = make_page(viewport=PHONE, route="#/term?s=typing")
        page.wait("!!document.querySelector('#termwrap')?._term", timeout=20)
        rows_before = page.eval("document.querySelector('#termwrap')._term.rows")
        height = 380
        page.eval(f"import('/js/keyboard.js').then(m => m.fitToVisible({height}, 0))")
        page.wait(f"document.querySelector('#termwrap')._term.rows < {rows_before}", timeout=5, what="the terminal re-fitted")
        got = json.loads(page.eval("""JSON.stringify({
          term: document.querySelector('#termwrap .xterm-screen').getBoundingClientRect().bottom,
          keys: document.querySelector('#keys, .keybar')?.getBoundingClientRect().bottom ?? 0 })"""))
        assert got["term"] <= height and got["keys"] <= height + 1, f"under the keyboard: {got}"
    finally:
        argus.tmux("kill-session", "-t", "typing", check=False)

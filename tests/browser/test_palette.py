"""Find anything (Ctrl+K, ⌘K), What's new, What Argus does — how a person gets to know everything Argus has
("everything I have — how does a person get to know it?", 2026-11-12)."""

from __future__ import annotations

import os
import time

from .test_flows import eventually

OPEN = "!!document.querySelector('dialog.palette[open]')"


def shoot(page, name):
    where = os.environ.get("ARGUS_SHOTS")
    if where:
        page.screenshot(os.path.join(where, f"{name}.png"))


def find(page, words):
    page.eval(f"(() => {{ const i = document.querySelector('.palettefind'); i.value = {words!r}; i.dispatchEvent(new Event('input')); }})()")


def test_ctrl_k_finds_a_screen_an_action_and_a_setting_and_runs_it(make_page):
    page = make_page(route="#/sessions")
    page.key("k", "KeyK", modifiers=2)
    page.wait(OPEN, what="the palette")
    assert page.eval("document.activeElement?.classList.contains('palettefind')"), "typing goes in at once"
    assert page.eval("document.querySelectorAll('.paletterow').length") > 5, "screens offered before typing"
    # A screen by its name, never with the count its link carries ("Needs you18", 2026-11-12).
    labels = page.eval("[...document.querySelectorAll('.paletterow.k-screen .palettelabel')].map(l => l.textContent)")
    assert "Needs you" in labels and not [x for x in labels if any(c.isdigit() for c in x)], labels
    find(page, "notes")
    page.wait("document.querySelector('.paletterow.on .palettelabel')?.textContent === 'Notes'", what="Notes first")
    shoot(page, "palette")
    page.key("Enter", "Enter")
    page.wait("location.hash === '#/notes'", what="taken there")
    page.wait(f"!{OPEN}", what="and closed")
    # An action with its key shown, run by a click.
    page.click("#find")
    page.wait(OPEN, what="opened from its button")
    assert page.eval("document.querySelector('.palettesection')?.textContent") == "Recent", "the last one first"
    find(page, "keyboard shortcuts")
    page.wait("[...document.querySelectorAll('.paletterow kbd')].length > 0", what="its key, shown")
    page.click_at(*page._center("document.querySelector('.paletterow.on')"))
    page.wait("!!document.querySelector('dialog.keyhelp[open]')", what="the shortcuts sheet")
    page.key("Escape", "Escape")
    # Nothing by that name says what to do.
    page.click("#find")
    page.wait(OPEN)
    find(page, "zzqq nothing at all")
    page.wait("!!document.querySelector('.paletteempty')", what="nothing, said")
    page.key("Escape", "Escape")
    page.wait(f"!{OPEN}", what="Escape closes it")


def test_ctrl_k_is_left_to_a_terminal_and_ctrl_shift_p_reaches_it_from_there(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "shell", "-x", "80", "-y", "12")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "W", "desktop": [{"kind": "term", "name": "shell"}]}]}})
    page = make_page(route="#/wall")
    screen = "document.querySelector('.win[data-session=\"shell\"] .xterm-screen')"
    page.wait(f"!!{screen}", timeout=15, what="the terminal")
    page.click_at(*page._center(screen))
    page.wait("!!document.activeElement?.closest('.xterm')", what="the keyboard in it")
    page.key("k", "KeyK", modifiers=2)
    time.sleep(0.4)
    assert not page.eval(OPEN), "Ctrl+K is the shell's there"
    page.key("p", "KeyP", modifiers=2 | 8)
    page.wait(OPEN, what="Ctrl+Shift+P, from the terminal")


def test_whats_new_comes_once_after_an_update_not_on_a_first_visit(make_page, argus):
    page = make_page(route="#/files")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("newsSeen"), what="a first visit marks what there is")
    assert not page.eval("!!document.querySelector('.newscard')"), "nothing announced to a newcomer"
    # As after an update: the last seen is older than the newest.
    argus.api("/api/prefs", "PATCH", {"changes": {"newsSeen": "2026-11-10z"}})
    page.reload()
    page.wait("!!document.querySelector('.newscard')", timeout=10, what="what is new, said")
    assert page.eval("document.querySelectorAll('.newscard .newsrow').length") >= 3
    shoot(page, "whatsnew")
    page.click_at(*page._center("document.querySelector('.newsfoot button')"))
    page.wait("!document.querySelector('.newscard')", what="gone once seen")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("newsSeen", "") > "2026-11-10z", what="and remembered")
    page.reload()
    time.sleep(2)
    assert not page.eval("!!document.querySelector('.newscard')"), "not said twice"


def test_what_argus_does_shows_the_place(make_page):
    page = make_page(route="#/tour")
    page.wait("document.querySelectorAll('.agentcangroup').length >= 8", what="the areas")
    shoot(page, "tour")
    show = "[...document.querySelectorAll('.agentcancard')].find(c => c.textContent.includes('Desks of windows')).querySelector('button')"
    page.click_at(*page._center(show))
    page.wait("location.hash.startsWith('#/wall') && !!document.querySelector('.spotlit')", what="taken there, the place lit")

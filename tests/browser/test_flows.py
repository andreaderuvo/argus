"""The things people actually do, done the way they do them: clicks, typing, dialogs.

What happened is checked where it really happened — tmux has the session, the file is on disk,
the preference is on the server — not only in what the page says. The terminal is checked by
effect (a command writes a file) because xterm draws on a canvas, and because `capture-pane`
is never to be run on this project's machines (CLAUDE.md).
"""

from __future__ import annotations

import json
import time

import pytest

from .cdp import DESKTOP, PHONE


def eventually(fn, timeout: float = 10.0, what: str = "condition"):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        last = fn()
        if last:
            return last
        time.sleep(0.1)
    raise AssertionError(f"timed out waiting for {what} (last: {last!r})")


def type_in_terminal(page, line: str) -> None:
    page.click(".xterm")
    page.type(line)
    page.key("Enter")


# ------------------------------------------------------------------------ sessions

@pytest.mark.parametrize("size", [pytest.param(DESKTOP, id="desktop"), pytest.param(PHONE, id="phone")])
def test_a_shell_from_an_empty_sessions_list(make_page, argus, size):
    """The state right after a tmux server dies: nothing listed, and a shell is what you want."""
    page = make_page(viewport=size, route="#/sessions")
    page.wait("document.body.innerText.includes('No tmux sessions')", what="the empty list")
    page.click_text("New session", within="#view button")
    chosen = page.wait("document.querySelector('.startpick.on .name')?.textContent", what="a preselected launcher")
    assert chosen == "A shell"
    # homePath(): the chosen home, else the first root — here there is no chosen home.
    assert page.eval("document.querySelector('.startpath').value") == str(argus.root)
    page.wait("!document.querySelector('dialog .primary').disabled", what="Start to be enabled")
    page.click("dialog .sheetfoot .primary")
    page.wait("location.hash.startsWith('#/term?s=')", timeout=20, what="landing in the terminal")
    name = page.eval("decodeURIComponent(location.hash.split('s=')[1])")
    eventually(lambda: name in argus.sessions(), what=f"tmux to have {name}")

    marker = argus.root / f"typed-{size['width']}.txt"
    page.wait("!!document.querySelector('.xterm')", what="xterm")
    time.sleep(0.8)                      # the shell's prompt, before typing into it
    type_in_terminal(page, f"echo through-the-browser > {marker}")
    eventually(lambda: marker.exists() and marker.read_text().strip() == "through-the-browser",
               what="the typed command to run in tmux")


def test_the_launcher_box_says_what_is_missing_and_keeps_its_rows(make_page, argus):
    page = make_page(route="#/sessions")
    page.click_text("New session", within="#view button")
    page.wait("document.querySelectorAll('.startpick').length === 4", what="four launchers")
    rows = lambda: page.eval(
        "[...document.querySelectorAll('.startpick')].map(r => [r.querySelector('.name').textContent,"
        " r.querySelector('.meta').textContent, r.classList.contains('missing')])")
    page.settle()
    before = rows()
    assert [r[0] for r in before] == ["A shell", "Echo", "Missing tool", "Claude"]
    assert before[2][2] is True, "a launcher whose command is not on the PATH is marked missing"
    assert before[0][2] is False and before[1][2] is False
    page.click_text("Echo", within=".startpick")
    after = rows()
    # Picking one redraws every row: what each says about itself must survive that.
    assert [r[:2] for r in after] == [r[:2] for r in before]
    assert page.eval("document.querySelector('.startpick.on .name').textContent") == "Echo"
    page.click_text("Cancel", within="dialog button")
    page.wait("!document.querySelector('dialog')", what="the box to close")
    assert argus.sessions() == []


def test_a_session_started_elsewhere_can_be_renamed_and_killed(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "outside", "-x", "80", "-y", "24")
    page = make_page(route="#/sessions")
    page.wait("document.body.innerText.includes('outside')", what="the outside session in the list")

    page.click(".rowwrap.sess .act[title^='Rename']")
    page.wait("!!document.querySelector('dialog input')", what="the rename box")
    assert page.eval("document.querySelector('dialog input').value") == "outside"
    page.type("renamed-here")            # the box selects the old name, so typing replaces it
    page.key("Enter")
    eventually(lambda: argus.sessions() == ["renamed-here"], what="tmux to have the new name")
    page.wait("document.body.innerText.includes('renamed-here')", what="the list to follow")

    page.click(".rowwrap.sess .act.kill")
    page.wait("!!document.querySelector('dialog .danger')", what="the kill confirmation")
    assert argus.sessions() == ["renamed-here"], "nothing is killed before it is confirmed"
    page.click("dialog .danger")
    eventually(lambda: argus.sessions() == [], what="the session to be gone")


def test_cancelling_a_kill_kills_nothing(make_page, argus):
    argus.tmux("new-session", "-d", "-s", "keepme", "-x", "80", "-y", "24")
    page = make_page(route="#/sessions")
    page.wait("document.body.innerText.includes('keepme')")
    page.click(".rowwrap.sess .act.kill")
    page.wait("!!document.querySelector('dialog .danger')")
    page.key("Escape")
    page.wait("!document.querySelector('dialog')", what="the confirmation to close")
    time.sleep(0.5)
    assert argus.sessions() == ["keepme"]


# ------------------------------------------------------------------------ files

def test_walking_into_a_folder_and_opening_a_markdown_report(make_page, argus):
    page = make_page(route=f"#/files?path={argus.root}")
    docs = argus.root / "docs"
    page.click(f"#view .row[data-path={json.dumps(str(docs))}]")
    page.wait(f"!!document.querySelector('#view .row[data-path={json.dumps(str(docs / 'report.md'))}]')",
              what="the docs listing")
    page.click(f"#view .row[data-path={json.dumps(str(docs / 'report.md'))}]")
    page.wait("[...document.querySelectorAll('h1')].some(h => h.textContent.includes('Report heading'))",
              timeout=15, what="the rendered heading")
    # The figure is resolved against the document's folder and really loads.
    page.wait("[...document.querySelectorAll('img')].some(i => i.complete && i.naturalWidth > 0 && /dot\\.png/.test(i.src))",
              what="the markdown figure to load")
    # A hostile document cannot run script in the page that holds the token.
    assert page.eval("window.__pwned === undefined") is True
    assert page.eval("[...document.querySelectorAll('#view script')].length") == 0


def test_hidden_files_appear_only_when_asked_for(make_page, argus):
    page = make_page(route=f"#/files?path={argus.root}")
    hidden = f".row[data-path={json.dumps(str(argus.root / '.hidden'))}]"
    page.wait(f"!!document.querySelector('#view .row[data-path={json.dumps(str(argus.root / 'notes.txt'))}]')")
    assert page.count(hidden) == 0
    page.route("#/settings", ready="document.body.innerText.includes('Show hidden files')")
    page.click_text("Show hidden files", within=".row.setting")
    page.route(f"#/files?path={argus.root}", ready=f"!!document.querySelector({json.dumps(hidden)})")
    # And the choice was saved where every device reads it.
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("hidden") is True, what="the pref on the server")


def test_a_text_file_preview_shows_its_lines(make_page, argus):
    page = make_page(route=f"#/preview?path={argus.root / 'notes.txt'}")
    page.wait("document.body.innerText.includes('needle in a haystack')")


# ------------------------------------------------------------------------ settings

def test_the_theme_cycles_and_survives_a_reload(make_page, argus):
    page = make_page(route="#/settings")
    start = page.eval("document.documentElement.dataset.theme")
    assert start in ("dark", "light")
    page.click_text("Theme", within=".row.setting")
    page.wait(f"document.documentElement.dataset.theme !== {json.dumps(start)}", what="the theme to change")
    now = page.eval("document.documentElement.dataset.theme")
    page.settle()
    page.goto(argus.url + "/#/settings")
    page.wait(f"document.documentElement.dataset.theme === {json.dumps(now)}", what="the theme after reload")


def test_switching_the_language_translates_the_screen(make_page, argus):
    page = make_page(route="#/settings")
    page.click_text("English", within=".row.setting")
    page.click_text("Italiano", within="dialog button")
    page.wait("document.body.innerText.includes('Impostazioni') || document.body.innerText.includes('Sessioni')",
              timeout=10, what="Italian on screen")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("lang") == "it", what="the language pref on the server")


def test_the_shortcut_help_opens_and_closes(make_page):
    page = make_page(route="#/sessions")
    page.click("#keys")
    page.wait("!!document.querySelector('dialog')", what="the shortcut sheet")
    page.key("Escape")
    page.wait("!document.querySelector('dialog')", what="it to close on Escape")


# ------------------------------------------------------------------------ desks

def test_a_new_session_on_a_desk_becomes_a_window(make_page, argus):
    page = make_page(route="#/wall")
    page.wait("document.body.classList.contains('wall')")
    page.click_text("New session", within="button")
    page.wait("!!document.querySelector('.startpick.on')", what="the launcher box")
    page.click_text("A shell", within=".startpick")
    page.wait("!document.querySelector('dialog .primary').disabled")
    page.click("dialog .sheetfoot .primary")
    eventually(lambda: len(argus.sessions()) == 1, timeout=20, what="a session in tmux")
    page.wait("document.querySelectorAll('.xterm').length >= 1", timeout=15, what="a terminal window on the desk")
    name = argus.sessions()[0]
    page.wait(f"document.body.innerText.includes({json.dumps(name)})", what="the window titled with the session")


def test_the_login_token_is_kept_across_a_reload(make_page, argus):
    page = make_page(route="#/files")
    page.goto(argus.url + "/")
    page.wait("!document.getElementById('nav').hidden", what="still signed in after reload")
    assert "token" not in page.eval("location.hash"), "the token must not stay in the address bar"


def test_the_first_visit_is_not_reloaded_by_the_service_worker(make_page, argus):
    """The worker's first install claims the page and fires controllerchange; that is not an
    update and must not reload what somebody has started using."""
    page = make_page(route=None)
    origin = page.eval("performance.timeOrigin")
    time.sleep(4)                           # long enough for the install and the claim
    assert page.eval("performance.timeOrigin") == origin, "the page reloaded itself after opening"
    assert page.eval("!!navigator.serviceWorker.controller") is True, "the worker did take the page"


def test_a_token_saved_under_the_old_name_still_signs_in(make_page, argus):
    """The project was tmux-companion once; a phone that has not opened it since keeps its token
    under `tmuxc.token`. The migration has to run before the token is read — an order the split
    into modules could silently break, since the two now live in different statements of
    state.js and used to sit in one file."""
    from .conftest import TOKEN
    page = make_page(login=False, route=None)
    page.eval(f"localStorage.clear(); localStorage.setItem('tmuxc.token', {json.dumps(TOKEN)})")
    page.goto(argus.url + "/")
    page.wait("!document.getElementById('nav').hidden", what="signed in from the old key")
    assert page.eval("localStorage.getItem('argus.token')") == TOKEN


def test_alt_v_says_which_argus_is_running(make_page):
    page = make_page(route="#/sessions")
    page.key("v", code="KeyV", modifiers=1)                      # Alt
    page.wait("!!document.querySelector('dialog.aboutargus .aboutrow')", timeout=10, what="the version dialog")
    text = page.eval("document.querySelector('dialog.aboutargus').textContent")
    assert "Version" in text and "0." in text
    # No horizontal scroll: a git describe has no space to break at, and pushed the dialog wider.
    wide = page.eval("(() => { const d = document.querySelector('dialog.aboutargus'); "
                     "return [...d.querySelectorAll('*')].some(e => e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).overflowX !== 'visible'); })()")
    assert wide is False


def test_desk_shortcuts_find_their_buttons_in_another_language(make_page, argus):
    """press() matched English words, so in an Italian Argus the desk's shortcuts did nothing."""
    argus.api("/api/prefs", "PATCH", {"changes": {"lang": "it"}})
    page = make_page(route="#/wall")
    page.wait("document.body.classList.contains('wall') && !!document.querySelector('#walltools button')", timeout=15)
    page.key("X", code="KeyX", modifiers=2 | 8)                  # Ctrl+Shift+X: New session
    page.wait("!!document.querySelector('dialog.sheet[open] .startpick')", timeout=10, what="the new-session box, in Italian")

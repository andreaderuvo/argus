"""A session started in a folder that is not there yet: asked "Create it?", made, and started in it.

It used to stop at the server's "… is not a folder", with nothing to do but go and make the folder
somewhere else ("when I open a new desk and type a folder that does not exist it should ask whether
to create it, and go on — not block me", 2026-10-21).
"""

from __future__ import annotations

import shutil

from .test_flows import eventually


def test_a_folder_not_there_is_offered_made_and_started_in(make_page, argus):
    wanted = argus.root / "relu" / "runs" / "first"
    shutil.rmtree(argus.root / "relu", ignore_errors=True)
    name = None
    try:
        page = make_page(route="#/sessions")
        page.click_text("New session", within="#view button")
        page.wait("document.querySelector('.startpick.on .name')?.textContent === 'A shell'", what="a shell chosen")
        page.eval(f"(() => {{ const w = document.querySelector('.startpath'); w.value = {str(wanted)!r}; w.dispatchEvent(new Event('input')); }})()")
        name = page.eval("document.querySelector('.startname').value")
        page.wait("!document.querySelector('dialog .sheetfoot .primary').disabled", what="Start")
        page.click("dialog .sheetfoot .primary")

        page.wait("[...document.querySelectorAll('dialog[open]')].some(d => d.textContent.includes('Create it?'))", timeout=5, what="asked")
        assert str(wanted) in page.eval("[...document.querySelectorAll('dialog[open]')].pop().textContent")
        page.click_text("Create it", within="dialog[open] button.primary")

        eventually(lambda: wanted.is_dir(), timeout=10, what="the folder made, all three levels")
        eventually(lambda: name in argus.sessions(), timeout=20, what="and the session started")
        here = argus.tmux("display-message", "-p", "-t", name, "#{pane_current_path}").stdout.strip()
        assert here == str(wanted), here
    finally:
        if name:
            argus.tmux("kill-session", "-t", name, check=False)
        shutil.rmtree(argus.root / "relu", ignore_errors=True)


def test_saying_no_keeps_the_box_open_and_makes_nothing(make_page, argus):
    wanted = argus.root / "not-wanted"
    page = make_page(route="#/sessions")
    page.click_text("New session", within="#view button")
    page.wait("document.querySelector('.startpick.on .name')?.textContent === 'A shell'")
    page.eval(f"(() => {{ const w = document.querySelector('.startpath'); w.value = {str(wanted)!r}; w.dispatchEvent(new Event('input')); }})()")
    page.wait("!document.querySelector('dialog .sheetfoot .primary').disabled")
    page.click("dialog .sheetfoot .primary")
    page.wait("[...document.querySelectorAll('dialog[open]')].some(d => d.textContent.includes('Create it?'))", timeout=5)
    page.click_text("Cancel", within="dialog[open] button")
    page.wait("!!document.querySelector('dialog[open] .startpath')", timeout=5, what="the New session box still there")
    assert not wanted.exists()

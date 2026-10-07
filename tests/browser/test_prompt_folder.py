"""`{folder}` in a prompt is the sending session's own directory — in what is sent *and* in what
the Prompts window shows before sending. The preview used to fill it with the desk's folder, so
the two could disagree (found by the documentation audit of 2026-10-07)."""

from __future__ import annotations

from .test_also import desk


def test_the_preview_says_the_folder_the_prompt_will_carry(make_page, argus, tmp_path):
    a, b = desk(argus, tmp_path)
    home = argus.root / "home" / "deskhome"          # inside the roots, like any desk's folder
    home.mkdir(parents=True, exist_ok=True)
    argus.api("/api/prefs", "PATCH", {"changes": {
        "workspaces": [{"id": 1, "name": "Pair", "home": str(home), "desktop": [
            {"kind": "term", "name": "writer"}, {"kind": "term", "name": "checker"}, {"kind": "messages"}]}],
        "templates": [{"name": "Where are you", "text": "look in {folder}"}]}})
    page = make_page(route="#/wall")
    row = "[...document.querySelectorAll('.win[data-kind=\"messages\"] .msgentry')].find(r => r.textContent.includes('Where are you'))"
    page.wait(f"!!{row}", timeout=15, what="the prompt in the Prompts window")
    more = f"{row}.querySelector('button[title=\"Change it before sending\"]')"
    page.wait(f"!!{more}", timeout=5, what="its ⋯")
    page.eval(f"{more}.click()")                     # it may sit in a folded group
    page.wait("!!document.querySelector('.batonpreview')?.textContent.includes('look in /')", timeout=10, what="the preview")
    shown = page.eval("document.querySelector('.batonpreview').textContent")
    assert str(home) not in shown, f"the desk's folder, not the sender's: {shown}"
    assert str(a) in shown or str(b) in shown, shown
    page.eval("document.querySelector('dialog.sheet')?.close()")
    for s in ("writer", "checker"):
        argus.tmux("kill-session", "-t", s, check=False)

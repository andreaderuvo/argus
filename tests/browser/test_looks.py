"""How it looks: the known palettes, each with its sixteen colours for what programs print."""

from __future__ import annotations

from .test_flows import eventually

ITEMS = "[...document.querySelectorAll('dialog.sheet .sheetbody button.block')]"


def test_a_known_palette_dresses_the_session_and_its_colours(make_page, argus):
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "dressed", "-x", "80", "-y", "24")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "dressed"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("!!document.querySelector('.win[data-session=\"dressed\"]')", timeout=15)
    page.eval("[...document.querySelectorAll('.win[data-session=\"dressed\"] .winbtn')].find(b => b.title === 'How it looks').click()")
    page.wait(f"{ITEMS}.length >= 18", timeout=5, what="every look offered")
    names = page.eval(f"{ITEMS}.map(b => b.querySelector('.name')?.textContent).filter(Boolean)")
    for want in ("Argus", "Dracula", "Nord", "Solarized Light", "Gruvbox", "Catppuccin Mocha", "Tokyo Night", "Plain"):
        assert want in names, names
    assert page.eval(f"{ITEMS}.find(b => b.textContent.includes('Dracula')).querySelectorAll('.lookstrip > span').length") == 6
    page.click_at(*page._center(f"{ITEMS}.find(b => b.textContent.includes('Dracula'))"))
    eventually(lambda: page.eval("import('/js/theme.js').then(m => { const th = m.termTheme('dressed'); return [th.background, th.red, th.brightCyan]; })")
               == ["#282a36", "#ff5555", "#a4ffff"], timeout=10, what="the terminal in Dracula, its ANSI colours too")
    style = argus.tmux("show-options", "-t", "dressed", "status-style").stdout
    assert "#44475a" in style, style
    argus.kill_sessions()

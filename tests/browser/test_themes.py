"""Themes: a gallery that puts one on as it is pressed, kept across a reload (painted before the
page draws), the terminal in its colours, and an editor whose every colour shows on the page."""

from __future__ import annotations

from .test_flows import eventually

CARDS = "[...document.querySelectorAll('dialog.themesheet .themecard')]"
BG = "getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()"


def open_gallery(page):
    page.eval("import('/js/themepicker.js').then(m => m.themeSheet())")
    page.wait(f"{CARDS}.length >= 19", timeout=10, what="Auto and every theme")


def test_a_theme_is_worn_kept_and_dresses_the_terminal(make_page, argus):
    page = make_page(route="#/files")
    open_gallery(page)
    names = page.eval(f"{CARDS}.map(c => c.querySelector('.tcname').textContent)")
    for want in ("Auto", "Argus Dark", "Dark+", "One Dark Pro", "Dracula", "GitHub Light", "Night Owl"):
        assert want in names, names
    page.click_at(*page._center(f"{CARDS}.find(c => c.querySelector('.tcname').textContent === 'Dracula')"))
    page.wait(f"{BG} === '#282a36' && document.documentElement.dataset.theme === 'dark'", timeout=5, what="worn at once")
    assert page.eval("!!document.querySelector('dialog.themesheet[open]')"), "the gallery stays: the page is the preview"
    assert page.eval("import('/js/theme.js').then(m => m.termTheme('x').red)") == "#ff5555", "the terminal in its colours"
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("uiTheme") == "dracula", timeout=10, what="kept")
    again = make_page(route="#/files")
    assert again.eval("document.documentElement.style.getPropertyValue('--bg')") == "#282a36", "painted before the page drew"
    # A light one: the light half of the stylesheet's own rules.
    open_gallery(again)
    again.click_at(*again._center(f"{CARDS}.find(c => c.querySelector('.tcname').textContent === 'GitHub Light')"))
    again.wait(f"{BG} === '#ffffff' && document.documentElement.dataset.theme === 'light'", timeout=5)
    # Back to Argus's own: no colours of a theme left on the page.
    again.click_at(*again._center(f"{CARDS}.find(c => c.querySelector('.tcname').textContent === 'Argus Dark')"))
    again.wait(f"!document.documentElement.style.getPropertyValue('--bg') && {BG} === '#0b0e14'", timeout=5)


def test_the_editor_shows_each_colour_on_the_page_and_saves_a_copy(make_page, argus):
    page = make_page(route="#/files")
    page.eval("import('/js/themepicker.js').then(async m => { const s = await m.loadThemes(true);"
              " m.themeEditor(s.themes.find(t => t.id === 'nord'), { fresh: true }); })")
    page.wait("!!document.querySelector('dialog.themeeditor .tehex')", timeout=10)
    page.wait(f"{BG} === '#2e3440'", timeout=5, what="the page in the theme being edited")
    accent = "[...document.querySelectorAll('dialog.themeeditor .terow')].find(r => r.textContent.includes('Accent')).querySelector('.tehex')"
    page.eval(f"(() => {{ const i = {accent}; i.value = '#ff8800'; i.onchange(); }})()")
    page.wait("getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#ff8800'", timeout=5, what="live")
    page.eval("(() => { const n = document.querySelector('dialog.themeeditor .startpath'); n.value = 'Lab Nord'; n.oninput(); })()")
    page.click_text("Save", within="dialog.themeeditor button")
    eventually(lambda: (argus.config.parent / "themes" / "lab-nord.json").is_file(), timeout=10, what="written as yours")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("uiTheme") == "lab-nord", timeout=10, what="and worn")
    listed = {t["id"]: t for t in argus.api("/api/themes")["themes"]}
    assert listed["lab-nord"]["source"] == "yours" and listed["lab-nord"]["colors"]["accent"] == "#ff8800"
    # Cancel puts back what was worn.
    page.eval("import('/js/themepicker.js').then(async m => { const s = await m.loadThemes(true);"
              " m.themeEditor(s.themes.find(t => t.id === 'dracula'), { fresh: true }); })")
    page.wait(f"{BG} === '#282a36'", timeout=5)
    page.click_text("Cancel", within="dialog.themeeditor button")
    page.wait(f"{BG} === '#2e3440'", timeout=5, what="Lab Nord back")
    (argus.config.parent / "themes" / "lab-nord.json").unlink()


def test_the_contrast_is_measured_right(make_page):
    page = make_page(route="#/files")
    got = page.eval("import('/js/themepicker.js').then(m => [m.contrast('#a9b1d6', '#1a1b26'), m.contrast('#fff', '#000'), m.contrast('#777777', '#777777')])")
    assert round(got[0], 1) == 8.1 and round(got[1]) == 21 and round(got[2], 2) == 1.0, got

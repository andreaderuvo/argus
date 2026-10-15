"""Toasts: in the bottom-right corner, stacked rather than on top of each other, read whole, gone
after the time set in Settings (3 s by default) or kept until closed — and off, except failures.

On a desktop the nav is a rail down the side as tall as the window, and the toast's offset once
counted it as a bar along the bottom: every toast was drawn above the top of the screen."""

from __future__ import annotations

import time

import pytest

from .cdp import PHONE

TOASTS = "[...document.querySelectorAll('#toasts .toast')].filter(t => t.textContent.includes('Ⓣ'))"
ON_SCREEN = """(() => { const r = document.querySelector('#toasts .toast').getBoundingClientRect();
  return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()"""


def say(page, text, bad=False):
    """A toast of ours, marked so that nothing else the page happens to say is counted."""
    text = f"Ⓣ {text}"
    page.eval(f"import('/js/dialogs.js').then(m => m.toast({text!r}, {str(bad).lower()}))")


@pytest.mark.parametrize("phone", [False, True])
def test_a_toast_is_on_the_screen(make_page, phone):
    page = make_page(**({"viewport": PHONE} if phone else {}), route="#/files")
    say(page, "hello")
    page.wait(f"{TOASTS}.length > 0", timeout=5)
    assert page.eval(ON_SCREEN), page.eval("JSON.stringify(document.querySelector('#toasts .toast').getBoundingClientRect())")


def test_toasts_stack_in_the_bottom_right_whole_and_fade(make_page):
    page = make_page(route="#/files")
    long = "a long message that has to be read to the end " * 4
    say(page, "first")
    say(page, long)
    page.wait(f"{TOASTS}.length === 2", timeout=5)
    a, b = page.eval(f"{TOASTS}.map(t => {{ const r = t.getBoundingClientRect(); return [r.top, r.bottom, r.right]; }})")
    assert a[1] <= b[0] + 1, "one above the other, not on top of each other"
    assert abs(page.eval("innerWidth") - a[2]) < 40, "against the right edge"
    text = page.eval(f"{TOASTS}[1].querySelector('.toasttext')")
    assert page.eval(f"(() => {{ const e = {TOASTS}[1].querySelector('.toasttext'); return e.scrollHeight <= e.clientHeight + 1 && e.textContent.length > 150; }})()"), "the whole text, wrapped"
    page.wait(f"{TOASTS}.length === 0", timeout=6, what="gone after 3 s by default")


def test_the_settings_keep_them_or_turn_them_off(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"toastSecs": "close"}})      # read at boot
    page = make_page(route="#/files")
    say(page, "stays")
    time.sleep(4)
    assert page.eval(f"{TOASTS}.length") == 1, "until closed"
    page.click_at(*page._center(f"{TOASTS}[0].querySelector('.toastx')"))
    page.wait(f"{TOASTS}.length === 0", timeout=3, what="✕ closes it")
    page.eval("import('/js/state.js').then(s => { s.prefs.toastShow = false; })")
    say(page, "quiet")
    say(page, "it failed", bad=True)
    page.wait(f"{TOASTS}.length === 1", timeout=3)
    assert "it failed" in page.eval(f"{TOASTS}[0].textContent"), "off keeps only failures"


LOOK = """(() => {
  const t = [...document.querySelectorAll('#toasts .toast')].find(x => x.textContent.includes('Ⓣ'));
  const rgb = (c) => c.match(/[\\d.]+/g).slice(0, 3).map(Number);
  const lum = (c) => { const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return .2126 * r + .7152 * g + .0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
  const bg = getComputedStyle(t).backgroundColor;
  const probe = document.createElement('div'); probe.style.color = getComputedStyle(document.documentElement).getPropertyValue('--panel');
  document.body.append(probe); const panel = getComputedStyle(probe).color; probe.remove();
  const h = t.querySelector('h2, h3, strong') || t;
  return { bg, panel, text: ratio(getComputedStyle(t).color, bg), heading: ratio(getComputedStyle(h).color, bg) };
})()"""


@pytest.mark.parametrize("theme", ["dark", "light", "dracula"])
def test_a_toast_wears_the_theme_and_its_markdown_reads(make_page, theme):
    """A toast used to be an inverted block (--bright behind --bg): white on every dark theme, and the
    Markdown of an agent's words drew its headings in --bright on --bright."""
    page = make_page(route="#/files")
    if theme == "dracula":
        page.eval("import('/js/themepicker.js').then(m => m.themeSheet())")
        page.wait("document.querySelectorAll('dialog.themesheet .themecard').length >= 19", timeout=10, what="the gallery")
        page.click_at(*page._center("[...document.querySelectorAll('dialog.themesheet .themecard')].find(c => c.querySelector('.tcname').textContent === 'Dracula')"))
        page.wait("getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() === '#282a36'", timeout=5)
        page.eval("document.querySelector('dialog.themesheet').close()")
    else:
        page.eval(f"document.documentElement.dataset.theme = {theme!r}")
    page.eval("Promise.all([import('/js/dialogs.js'), import('/js/viewers.js')]).then(([d, v]) => d.toast(v.agentWords('Ⓣ ## Done\\n\\nAll **green**.')))")
    page.wait("[...document.querySelectorAll('#toasts .toast')].some(x => x.textContent.includes('Ⓣ'))", timeout=5)
    got = page.eval(LOOK)
    assert got["bg"] == got["panel"], got
    assert got["text"] >= 4.5 and got["heading"] >= 4.5, got

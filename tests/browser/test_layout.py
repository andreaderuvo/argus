"""What fits on a phone, measured rather than looked at.

A page wider than the phone is not a cosmetic problem: mobile Chrome shrinks the whole page to
fit, every target gets smaller, and a tap lands short of where the finger was (found by this
suite: the phone tap on Start in the launcher box missed by 60px until the harness corrected
for it).
"""

from __future__ import annotations

import pytest

from .cdp import PHONE

WIDTHS = [360, 390, 412]
SCREENS = ["#/sessions", "#/files", "#/settings", "#/system", "#/todo", "#/prompts"]


@pytest.mark.parametrize("width", WIDTHS)
def test_the_header_fits_a_phone(make_page, width):
    """It was 424px — seven 46px buttons, the title, the gaps — so every phone narrower than that
    was shown the page shrunk to fit. A phone does without the keyboard's shortcuts, System (in
    the menu) and the repository (in Settings)."""
    page = make_page(viewport={**PHONE, "width": width}, route="#/sessions")
    wide = page.eval("Math.round(document.querySelector('#bar').scrollWidth)")
    assert wide <= width, f"the header needs {wide}px on a {width}px phone"


@pytest.mark.parametrize("width", WIDTHS)
@pytest.mark.parametrize("hash_", SCREENS)
def test_nothing_else_makes_the_page_wider(make_page, argus, width, hash_):
    """Whatever the header does, nothing in the screen may widen the page further.

    Measured against the page's own width (which the header already stretches to 424px) and
    only for what nothing clips: an element inside a horizontal scroller — the two file panes a
    phone swipes between, a wide table, a code block — is meant to be wider than the screen.
    """
    page = make_page(viewport={**PHONE, "width": width}, route=hash_)
    culprits = page.eval("""JSON.stringify((() => {
        const clipped = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
            if (['auto', 'scroll', 'hidden', 'clip'].includes(getComputedStyle(a).overflowX)) return true; } return false; };
        const page = document.documentElement.clientWidth;
        return [...document.querySelectorAll('#view *')]
          .filter(e => e.getClientRects().length && getComputedStyle(e).position !== 'fixed')
          .map(e => [e, e.getBoundingClientRect()])
          .filter(([e, b]) => b.right > page + 1 && !clipped(e))
          .slice(0, 5)
          .map(([e, b]) => e.tagName + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' right=' + Math.round(b.right) + ' page=' + page);
    })())""")
    assert culprits == "[]", f"{hash_} at {width}px: {culprits}"


@pytest.mark.parametrize("width", WIDTHS)
def test_the_header_still_fits_with_the_system_alarm_showing(make_page, width):
    """System's button stays on a phone while it is an alarm (a disk or memory amber or red)."""
    page = make_page(viewport={**PHONE, "width": width}, route="#/sessions")
    page.eval("const v = document.querySelector('#vitals'); v.hidden = false; v.className = 'icon critical'")
    assert page.eval("getComputedStyle(document.querySelector('#vitals')).display") != "none", "the alarm is shown"
    wide = page.eval("Math.round(document.querySelector('#bar').scrollWidth)")
    assert wide <= width, f"the header needs {wide}px on a {width}px phone"
    page.eval("document.querySelector('#vitals').className = 'icon'")
    assert page.eval("getComputedStyle(document.querySelector('#vitals')).display") == "none", "and only then"


def test_the_repository_is_in_settings_where_the_header_has_no_room(make_page):
    page = make_page(viewport={**PHONE, "width": 360}, route="#/settings")
    page.wait("[...document.querySelectorAll('.row.setting')].some(r => r.textContent.includes('About Argus'))",
              timeout=10, what="About Argus in Settings")


@pytest.mark.parametrize("phone", [False, True])
def test_the_settings_filter_is_top_left_above_the_sections(make_page, phone):
    """Asked for on 2026-10-06: the filter first, above the section chips, not at the end of them."""
    page = make_page(viewport={**PHONE, "width": 390}, route="#/settings") if phone else make_page(route="#/settings")
    page.wait("!!document.querySelector('.setjump .jfind')", timeout=10, what="the filter")
    where = page.eval("""JSON.stringify((() => {
        const bar = document.querySelector('.setjump').getBoundingClientRect();
        const box = document.querySelector('.setjump .jfind').getBoundingClientRect();
        const chip = document.querySelector('.setjump .chip').getBoundingClientRect();
        return { left: Math.round(box.left - bar.left), above: box.bottom <= chip.top + 1 };
    })())""")
    import json
    said = json.loads(where)
    assert said["left"] <= 1 and said["above"], said


# Anything past the right edge of a phone, except inside something that scrolls or clips on purpose
# (a desk's tab strip, a terminal, a table). One element too wide makes the phone shrink the whole
# page and it has to be scrolled sideways: a long path in the title did exactly that (2026-10-12).
PAST_THE_EDGE = """(() => { const W = innerWidth, out = [];
  const boxed = (e) => { for (let p = e.parentElement; p && p !== document.body; p = p.parentElement) {
    const o = getComputedStyle(p).overflowX; if (o !== 'visible') return true; } return false; };
  for (const e of document.querySelectorAll('body *')) {
    const r = e.getBoundingClientRect();
    if (!r.width || e.offsetParent === null || r.right <= W + 1 || boxed(e)) continue;
    out.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ends at ${Math.round(r.right)}`);
  }
  return { W, page: document.documentElement.scrollWidth, out: out.slice(0, 6) }; })()"""


@pytest.mark.parametrize("route", ["#/files", "#/files?path={root}/docs", "#/preview?path={root}/notes.txt",
                                   "#/preview?path={root}/script.py", "#/settings", "#/sessions", "#/system",
                                   "#/wall", "#/prompts", "#/todo", "#/since", "#/changes?path={root}"])
def test_no_screen_is_wider_than_a_phone(make_page, argus, route):
    # The harness's root is a long path, which is the case that broke: it is in the title.
    page = make_page(viewport=PHONE, route=route.format(root=argus.root))
    page.settle()
    said = page.eval(PAST_THE_EDGE)
    assert said["W"] == PHONE["width"] and said["page"] <= said["W"] and not said["out"], said

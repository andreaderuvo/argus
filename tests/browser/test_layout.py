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


@pytest.mark.xfail(strict=True, reason=(
    "known bug, predates the refactor: the header is 424px wide on every screen — seven 46px "
    "icon buttons, the title and the gaps — so on any phone narrower than 424px the page "
    "overflows and is shrunk to fit. Fixing it means choosing which buttons a phone does "
    "without, which is a design decision. strict: the day it is fixed this turns red, and the "
    "xfail comes off so it can never come back."))
@pytest.mark.parametrize("width", WIDTHS)
def test_the_header_fits_a_phone(make_page, width):
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

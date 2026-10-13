"""Breadcrumbs in a file browser: every folder on the way a click away, from the root it is in;
the one you are in opens the address to type; the middle folds into … when the header is narrow."""

from __future__ import annotations

from .cdp import PHONE

STEPS = "[...document.querySelectorAll('.pane .sidehead .crumbs .crumbstep')]"


def test_each_folder_on_the_way_is_a_click_away(make_page, argus):
    deep = argus.root / "a" / "b" / "c"
    deep.mkdir(parents=True, exist_ok=True)
    page = make_page(route=f"#/files?path={deep}")
    page.wait(f"{STEPS}.length >= 4", timeout=10)
    names = page.eval(f"{STEPS}.map(b => b.textContent)")
    assert names[-3:] == ["a", "b", "c"], names
    assert page.eval(f"{STEPS}.at(-1).classList.contains('here')")
    page.click_at(*page._center(f"{STEPS}.find(b => b.textContent === 'a')"))
    page.wait(f"decodeURIComponent(location.hash).endsWith({str(argus.root / 'a')!r}) || decodeURIComponent(location.hash).includes({str(argus.root / 'a')!r} + '&')"
              f" || {STEPS}.at(-1)?.textContent === 'a'", timeout=10, what="in a, two folders up, in one click")
    # The one you are in: the address, to type.
    page.click_at(*page._center(f"{STEPS}.at(-1)"))
    page.wait("!!document.querySelector('.crumbedit .crumbbox')", timeout=5, what="the address to type in")


def test_a_narrow_header_folds_the_middle_into_a_menu(make_page, argus):
    deep = argus.root / "one" / "two" / "three" / "four" / "five" / "six" / "seven"
    deep.mkdir(parents=True, exist_ok=True)
    page = make_page(viewport=PHONE, route=f"#/files?path={deep}")
    page.wait("!!document.querySelector('.pane .sidehead .crumbs .crumbmore')", timeout=10, what="the … for the hidden folders")
    crumbs = "document.querySelector('.pane .sidehead .crumbs')"
    assert page.eval(f"{crumbs}.scrollWidth <= {crumbs}.clientWidth + 1"), "it fits"
    assert page.eval(f"{STEPS}.at(-1).textContent") == "seven", "where you are stays"
    page.eval("document.querySelector('.pane .sidehead .crumbs .crumbmore').click()")
    page.wait("document.querySelectorAll('.popmenu .popmenuitem').length >= 1", timeout=5)
    hidden = page.eval("[...document.querySelectorAll('.popmenu .popmenuitem')].map(b => b.textContent)")
    assert "one" in hidden or "two" in hidden, hidden

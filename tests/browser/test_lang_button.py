"""The language at the top right ("if I am in Italian and do not know what 'language' is called, I get lost in
Settings", 2026-11-23): the code on screen in the header, every language in its own name, a press away."""

from __future__ import annotations

from .test_flows import eventually
from .test_needs import shoot


def test_the_language_is_changed_from_the_header(make_page, argus):
    page = make_page(route="#/files")
    page.wait("document.querySelector('#lang .langcode')?.textContent === 'EN'", timeout=10, what="EN in the header")
    page.click_at(*page._center("document.getElementById('lang')"))
    page.wait("document.querySelectorAll('.popmenu .popmenuitem').length >= 5", timeout=5, what="the languages")
    names = page.eval("[...document.querySelectorAll('.popmenu .popmenuitem')].map(b => b.textContent)")
    assert {"English", "Italiano", "Español", "Français"} <= set(names), names
    shoot(page, "lang-menu")
    page.click_at(*page._center("[...document.querySelectorAll('.popmenu .popmenuitem')].find(b => b.textContent === 'Italiano')"))
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("lang") == "it", timeout=10, what="kept")
    page.wait("document.querySelector('#lang .langcode')?.textContent === 'IT'", timeout=20, what="the page again, in Italian")
    assert "Lingua" in page.eval("document.getElementById('lang').title")
    argus.api("/api/prefs", "PATCH", {"changes": {"lang": None}})


def test_on_a_phone_the_language_is_in_the_menu(make_page):
    """No room in a phone's header: the drawer has it, with the code on screen."""
    from .cdp import PHONE
    page = make_page(viewport={**PHONE, "width": 360}, route="#/files")
    page.wait("!!document.querySelector('#drawer .drawerlang')", timeout=10, what="the drawer's language row")
    assert page.eval("getComputedStyle(document.getElementById('lang')).display") == "none", "not in the header"
    page.click_at(*page._center("document.getElementById('hamburger')"))
    page.wait("document.querySelector('#drawer .drawerlang').getBoundingClientRect().width > 0", timeout=5, what="the drawer open")
    page.click_at(*page._center("document.querySelector('#drawer .drawerlang')"))
    page.wait("[...document.querySelectorAll('.popmenu .popmenuitem')].some(b => b.textContent === 'Italiano')", timeout=5, what="the languages")

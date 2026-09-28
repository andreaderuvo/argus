"""Every screen, at both sizes, opens without a single problem.

The cheapest test with the widest net: a missed import, a name that no longer exists, a module
path that 404s, a render that throws — all of them surface as a problem on *some* screen, and
the `page` fixture fails the test for it. Parametrised over routes × viewports, so the report
says exactly which screen at which size broke.
"""

from __future__ import annotations

import pytest

from .cdp import DESKTOP, PHONE

ROUTES = [
    # (hash, something that is only there once the screen has really drawn)
    ("#/sessions", "!!document.querySelector('#view button, #view .empty, #view .row')"),
    ("#/files", "document.querySelectorAll('#view .row').length > 0"),
    ("#/files?path={root}/docs", "document.body.innerText.includes('report.md')"),
    ("#/preview?path={root}/docs/report.md", "!!document.querySelector('#view h1')"),
    ("#/preview?path={root}/notes.txt", "document.body.innerText.includes('needle in a haystack')"),
    ("#/preview?path={root}/data.csv", "document.body.innerText.includes('sample')"),
    ("#/preview?path={root}/script.py", "document.body.innerText.includes('return x * 2')"),
    ("#/preview?path={root}/docs/paper.pdf", "!!document.querySelector('#view canvas, #view .pdfwrap')"),
    ("#/preview?path={root}/big.log", "document.body.innerText.includes('log line')"),
    ("#/system", "document.querySelectorAll('#view *').length > 5"),
    ("#/since", "document.querySelectorAll('#view *').length > 0"),
    ("#/journal", "document.querySelectorAll('#view *').length > 0"),
    ("#/todo", "document.querySelectorAll('#view *').length > 0"),
    ("#/settings", "document.querySelectorAll('#view *').length > 10"),
    ("#/tmuxconf", "document.querySelectorAll('#view *').length > 0"),
    ("#/placeholders", "document.querySelectorAll('#view *').length > 0"),
    ("#/prompts", "document.querySelectorAll('#view *').length > 0"),
    ("#/wall", "document.body.classList.contains('wall')"),
]

SIZES = [pytest.param(DESKTOP, id="desktop"), pytest.param(PHONE, id="phone")]


@pytest.mark.parametrize("size", SIZES)
@pytest.mark.parametrize("hash_,ready", ROUTES, ids=[r[0].split("?")[0] + ("?" + r[0].split("/")[-1] if "?" in r[0] else "") for r in ROUTES])
def test_every_screen_opens_clean(make_page, argus, size, hash_, ready):
    page = make_page(viewport=size, route=None)
    page.route(hash_.format(root=argus.root), ready=ready, timeout=15)
    # Something is on screen, and it is not an error message from render()'s catch.
    errors = page.eval("[...document.querySelectorAll('#view .error')]"
                       ".filter(e => e.getClientRects().length && e.textContent.trim())"
                       ".map(e => e.textContent.trim())")
    assert not errors, f"{hash_} drew an error: {errors}"


@pytest.mark.parametrize("size", SIZES)
def test_walking_through_every_screen_in_one_tab(make_page, argus, size):
    """The same screens one after another in one tab: what leaks from one render into the next
    (a timer, a listener, a parked terminal) only shows up here."""
    page = make_page(viewport=size, route=None)
    for hash_, ready in ROUTES + ROUTES[::-1]:
        page.route(hash_.format(root=argus.root), ready=ready, timeout=15)


def test_without_a_token_there_is_only_the_login(make_page):
    page = make_page(login=False, route=None)
    page.wait("!!document.querySelector('input[type=password]')", what="the token field")
    assert page.eval("document.getElementById('nav').hidden") is True
    # A wrong token is refused in words, not by a broken page.
    page.click("input[type=password]")
    page.type("definitely-not-the-token")
    page.key("Enter")
    page.wait("document.body.innerText.toLowerCase().includes('token')", what="the refusal")
    page.allow("http 401")

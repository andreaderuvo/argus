"""A browser that has signed in once is not asked for the token again, even after it lost its
own copy — which is what a phone does (Safari clears script storage after a week away)."""

from __future__ import annotations

import time


def test_a_browser_that_lost_its_token_gets_it_back_from_the_server(make_page, argus):
    page = make_page()                                    # signed in through #token=…
    time.sleep(0.5)                                       # the remember request is not awaited
    assert "argus_keep" not in page.eval("document.cookie"), "the cookie must not be readable by script"
    page.eval("localStorage.clear()")
    page.goto(argus.url + "/")
    page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden",
              timeout=10, what="the app, without asking for the token")
    assert page.eval("localStorage.getItem('argus.token')"), "and the page's own copy is back"


def test_a_new_browser_is_still_asked(make_page, argus):
    page = make_page(login=False, route=None)
    page.wait("!!document.querySelector('input[type=password]')", timeout=10, what="the token screen")

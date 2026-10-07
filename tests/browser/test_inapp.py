"""A QR code opened by the scanner's own browser: Argus says so, and offers the real browser.

The token is remembered by the browser that opened the link; an app's embedded browser keeps it
apart from Chrome or Safari, so the next day it had to be scanned again. Nothing on the server can
fix that — it is noticed and said, once per visit."""

from __future__ import annotations

WEBVIEW = ("Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 "
           "(KHTML, like Gecko) Version/4.0 Chrome/129.0.0.0 Mobile Safari/537.36")
CHROME = ("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) "
          "Chrome/129.0.0.0 Mobile Safari/537.36")
IOS_APP = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
           "(KHTML, like Gecko) Mobile/15E148")
IOS_SAFARI = ("Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1")

DIALOG = "[...document.querySelectorAll('dialog.sheet h2')].some(h => h.textContent.includes('Open Argus in your browser'))"


def as_(page, ua):
    page.send("Emulation.setUserAgentOverride", {"userAgent": ua})
    page.eval("sessionStorage.clear(); location.reload()")
    page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden", timeout=15, what="the app")


def test_the_scanners_browser_is_told_and_offered_chrome(make_page, argus):
    page = make_page(route="#/files")
    detect = lambda ua: page.eval(f"import('/js/inapp.js').then(m => m.inAppBrowser({ua!r}))")
    assert detect(WEBVIEW) is True and detect(IOS_APP) is True
    assert detect(CHROME) is False and detect(IOS_SAFARI) is False
    as_(page, WEBVIEW)
    page.wait(DIALOG, timeout=10, what="the advice, in the scanner's browser")
    assert page.eval("[...document.querySelectorAll('dialog.sheet button')].some(b => b.textContent === 'Open in Chrome')")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Stay here')"))
    page.eval("location.reload()")
    page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden", timeout=15)
    page.settle(quiet=0.5, timeout=3)
    assert not page.eval(DIALOG), "once per visit"


def test_a_real_browser_is_left_alone(make_page, argus):
    page = make_page(route="#/files")
    as_(page, CHROME)
    page.settle(quiet=0.8, timeout=4)
    assert not page.eval(DIALOG)

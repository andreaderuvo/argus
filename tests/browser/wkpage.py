"""The same pages, in WebKit — the engine of Safari, of every iPhone, and of argus-bridge's window on a Mac.

The suite was written against Chromium over its DevTools protocol (cdp.py), and every bug that reached the
person through argus-bridge — links that did nothing, a copy refused, drops and downloads swallowed — was one
Chromium never showed (2026-11-12). `ARGUS_ENGINE=webkit` runs the same tests in Playwright's WebKit.

`WebKitPage` is a `Page`: the generic methods (wait, click, key, route…) are inherited unchanged, and the few
DevTools calls they and the tests make are translated here into Playwright's. A call that only Chromium can
answer (CPU throttling, DOM nodes by id, performance counters, an input method's composition) skips the test
in WebKit, saying which — never a pass by doing nothing.
"""

from __future__ import annotations

import base64
import os
import time

import pytest

from .cdp import CDPError, Page, Timeout

# CDP's modifier bits, as the tests pass them: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
MODIFIERS = ((1, "Alt"), (2, "Control"), (4, "Meta"), (8, "Shift"))
CHROMIUM_ONLY = {
    "Emulation.setCPUThrottlingRate", "Performance.enable", "Performance.getMetrics", "DOM.getDocument",
    "DOM.querySelector", "DOM.setFileInputFiles", "Network.getResponseBody", "Input.imeSetComposition",
    "Emulation.setUserAgentOverride", "Browser.grantPermissions", "Target.setAutoAttach",
    "Target.createTarget", "Target.createBrowserContext",
}


class WebKitPage(Page):
    def __init__(self, context, origin: str, touch: bool):
        # Not Session.__init__: there is no DevTools socket here.
        self.origin = origin
        self.allowed: list = []
        self.events: list = []
        self._listeners: list = []
        self._inflight: dict = {}
        self._last_net = time.monotonic()
        self._held: set[str] = set()
        self._touch_at = None
        self._left_at = -1e9
        self._said: list[str] = []
        self._bad: list = []
        self.touch = touch
        self.context = context
        self.pw = context.new_page()
        OPEN.append(self)
        self.pw.on("console", self._console)
        self.pw.on("pageerror", self._exception)
        self.pw.on("request", self._request)
        self.pw.on("requestfinished", self._done)
        self.pw.on("requestfailed", self._failed)
        self.pw.on("response", self._response)

    # ---------------------------------------------------------------- what went wrong

    def _exception(self, e) -> None:
        first = (getattr(e, "message", "") or str(e) or "?").splitlines()[0]
        # A request the page was waiting on, cut when the page left (a reload, a new address): WebKit says
        # "Fetch API cannot load … due to access control checks" even where the page catches it — Chromium's
        # ERR_ABORTED, which cdp.py ignores too. Only around a new document: anywhere else it is a real refusal.
        if "due to access control checks" in first and time.monotonic() - self._left_at < 3:
            return
        stack = [line.strip() for line in (getattr(e, "stack", "") or "").splitlines()[1:3]]
        self._said.append(f"exception: {getattr(e, 'name', '') or 'Error'}: {first}" + (f" @ {' ← '.join(stack)}" if stack else ""))

    def _console(self, msg) -> None:
        if msg.type not in ("error", "assert"):
            return
        text = msg.text
        # WebKit also logs every 4xx/5xx as a console error: reported below with its status, not twice.
        if text.startswith("Failed to load resource"):
            return
        # WebKit reading the viewport meta: interactive-widget is Chrome on Android's (the keyboard resizes
        # the page), unknown to Safari and harmless there. A remark on the markup, not an error of the page.
        if 'Viewport argument key "interactive-widget"' in text:
            return
        self._said.append(f"console.{msg.type}: {text}")

    def _request(self, req) -> None:
        if req.resource_type == "document" and req.frame == self.pw.main_frame:
            self._left_at = time.monotonic()
        self._inflight[id(req)] = (req.url, time.monotonic())
        self._last_net = time.monotonic()
        for cb in list(self._listeners):
            cb({"method": "Network.requestWillBeSent",
                "params": {"request": {"url": req.url, "method": req.method, "postData": req.post_data or ""}}})

    def _done(self, req) -> None:
        self._inflight.pop(id(req), None)
        self._last_net = time.monotonic()

    def _failed(self, req) -> None:
        self._done(req)
        why = req.failure or ""
        # A request a navigation or the page itself cancelled is not a failure (Chromium's ERR_ABORTED).
        if req.url.startswith(self.origin) and not any(w in why.lower() for w in ("cancel", "abort", "load request")):
            self._said.append(f"failed: {why} {req.url[len(self.origin):]}")

    def _response(self, r) -> None:
        if not r.url.startswith(self.origin):
            return
        if r.status >= 400:
            self._bad.append(r)
        kind = (r.headers or {}).get("content-type", "")
        if r.url.split("?")[0].endswith(".js") and "html" in kind:
            self._said.append(f"script served as html (missing file?): {r.url[len(self.origin):]}")

    @property
    def problems(self) -> list[str]:
        out = list(self._said)
        for r in self._bad:
            said = ""
            try:
                said = r.text()[:240]
            except Exception:
                pass
            out.append(f"http {r.status}: {r.url[len(self.origin):]}" + (f" — {said}" if said else ""))
        return [x for x in out if not any(ok(x) for ok in self.allowed)]

    # ---------------------------------------------------------------- the protocol, translated

    def _hold(self, modifiers: int) -> None:
        want = {name for bit, name in MODIFIERS if modifiers & bit}
        for name in sorted(self._held - want):
            self.pw.keyboard.up(name)
        for name in sorted(want - self._held):
            self.pw.keyboard.down(name)
        self._held = want

    def send(self, method: str, params: dict | None = None, timeout: float = 20.0, session: str | None = None) -> dict:
        p = params or {}
        if method == "Input.dispatchMouseEvent":
            self._hold(p.get("modifiers", 0))
            x, y, kind = p.get("x", 0), p.get("y", 0), p["type"]
            button = p.get("button", "left") if p.get("button") not in (None, "none") else "left"
            if kind == "mouseMoved":
                self.pw.mouse.move(x, y)
            elif kind == "mousePressed":
                self.pw.mouse.move(x, y)
                self.pw.mouse.down(button=button, click_count=p.get("clickCount", 1))
            elif kind == "mouseReleased":
                self.pw.mouse.move(x, y)
                self.pw.mouse.up(button=button, click_count=p.get("clickCount", 1))
            elif kind == "mouseWheel":
                self.pw.mouse.move(x, y)
                self.pw.mouse.wheel(p.get("deltaX", 0), p.get("deltaY", 0))
            if kind in ("mouseReleased", "mouseWheel"):
                self._hold(0)
            return {}
        if method == "Input.dispatchKeyEvent":
            kind, key = p["type"], p.get("key", "")
            if kind in ("keyDown", "rawKeyDown"):
                self._hold(p.get("modifiers", 0))
                if key in ("Control", "Shift", "Alt", "Meta"):
                    return {}
                text = p.get("text")
                if len(key) != 1 and text and text not in ("\r", "\n"):
                    self.pw.keyboard.insert_text(text)
                else:
                    self.pw.keyboard.down(key)
            elif kind == "keyUp":
                if key not in ("Control", "Shift", "Alt", "Meta") and not (len(key) != 1 and p.get("text")):
                    self.pw.keyboard.up(key)
                self._hold(0)
            elif kind == "char":
                self.pw.keyboard.insert_text(p.get("text", ""))
            return {}
        if method == "Input.insertText":
            self.pw.keyboard.insert_text(p.get("text", ""))
            return {}
        if method == "Input.dispatchTouchEvent":
            points = p.get("touchPoints") or []
            if p["type"] == "touchStart" and points:
                self._touch_at = (points[0]["x"], points[0]["y"])
            elif p["type"] == "touchEnd" and self._touch_at:
                self.pw.touchscreen.tap(*self._touch_at)
                self._touch_at = None
            elif p["type"] == "touchMove":
                pytest.skip("WebKit: a finger moved (touchMove) needs Chromium's protocol")
            return {}
        if method == "Page.reload":
            self.pw.reload(wait_until="commit")
            return {}
        if method == "Page.navigate":
            self.pw.goto(p["url"], wait_until="commit")
            return {}
        if method == "Page.captureScreenshot":
            return {"data": base64.b64encode(self.pw.screenshot()).decode()}
        if method == "Runtime.evaluate":
            try:
                return {"result": {"value": self.pw.evaluate(p["expression"])}}
            except Exception as e:
                return {"exceptionDetails": {"text": str(e)}}
        if method == "Emulation.setDeviceMetricsOverride":
            self.pw.set_viewport_size({"width": p["width"], "height": p["height"]})
            return {}
        if method in ("Emulation.setTouchEmulationEnabled", "Page.enable", "Runtime.enable", "Log.enable", "Network.enable"):
            return {}
        if method in CHROMIUM_ONLY:
            pytest.skip(f"WebKit: {method} is Chromium's protocol only")
        raise CDPError(f"WebKit: no translation for {method}")

    # ---------------------------------------------------------------- the rest that is engine-specific

    def viewport(self, spec: dict) -> None:
        self.pw.set_viewport_size({"width": spec["width"], "height": spec["height"]})

    def eval(self, expression: str, await_promise: bool = True):
        # Playwright calls an expression whose value is a function; Chromium's protocol hands it back (as {},
        # useless). Statements that end by defining a function — helpers a test installs — end with undefined.
        tail = expression.rstrip()
        if tail.endswith(("}", "};")) and ("=>" in tail or "function" in tail):
            expression = f"{expression}\n;undefined"
        try:
            value = self.pw.evaluate(expression)
        except Exception as e:
            raise CDPError(f"eval failed: {str(e).splitlines()[0]}\n  in: {expression[:200]}") from None
        return value

    def frame_eval(self, url_part: str, expression: str, timeout: float = 10.0):
        end = time.monotonic() + timeout
        last = None
        while time.monotonic() < end:
            for frame in reversed(self.pw.frames):
                if url_part not in frame.url:
                    continue
                try:
                    return frame.evaluate(expression)
                except Exception as e:      # a frame redrawn under us, or a promise rejected: again
                    last = e
            time.sleep(0.1)
        raise Timeout(f"no frame {url_part!r} to evaluate in ({last})")

    def screenshot(self, path) -> None:
        self.pw.screenshot(path=str(path))

    def close(self) -> None:
        if self in OPEN:
            OPEN.remove(self)
        try:
            self.context.close()
        except Exception:
            pass


OPEN: list = []                  # the pages open now, the newest last
_sleep = time.sleep


def _pumping_sleep(seconds: float) -> None:
    """time.sleep that lets Playwright take in what the browser said meanwhile. Its Python API reads the
    browser only during its own calls: a test sleeping while frames load or requests go saw nothing change
    (the frame list, the requests counted). Chromium's socket in cdp.py reads on a thread of its own."""
    page = OPEN[-1] if OPEN else None
    if page is None or seconds <= 0:
        _sleep(seconds)
        return
    try:
        page.pw.wait_for_timeout(seconds * 1000)
    except Exception:
        _sleep(seconds)


def start_webkit():
    """Playwright and its WebKit, for this worker. The libraries a non-Ubuntu machine lacks are put beside
    WebKit's own (its launcher overwrites LD_LIBRARY_PATH, so they cannot be passed in)."""
    from playwright.sync_api import sync_playwright
    os.environ.setdefault("PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS", "1")
    pw = sync_playwright().start()
    time.sleep = _pumping_sleep
    return pw, pw.webkit.launch()


def open_webkit_page(browser, origin: str, viewport: dict) -> WebKitPage:
    mobile = bool(viewport.get("mobile"))
    context = browser.new_context(
        viewport={"width": viewport["width"], "height": viewport["height"]},
        device_scale_factor=viewport.get("deviceScaleFactor", 1) or 1,
        has_touch=mobile, is_mobile=False,
    )
    return WebKitPage(context, origin, mobile)

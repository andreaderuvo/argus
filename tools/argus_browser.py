"""The browser of the person's own computer, driven by an agent here: open, look, click, type.

The person's Mac or PC lends its Chrome through argus-bridge (Argus: Settings → Computers), and Argus
gives the agents on this machine a loopback address for it. These are the hands on it — standard
library only, like the rest of tools/: a small WebSocket client and a handful of Chrome DevTools
Protocol calls. Every call asks Argus for the address of the moment, so a Chrome restarted on the
Mac, or a computer connected since, is simply there; nothing to configure, no port, no tunnel.

One tab is the agent's: opened by `open` the first time, remembered (per session) and used by
every call after; `tabs` lists them all, `open(…, new=True)` starts another. `look` numbers what can
be clicked or typed into, and `click`/`type` take that number — or words the element shows.
"""

from __future__ import annotations

import base64
import json
import os
import socket
import struct
import time
from pathlib import Path
from urllib.parse import urlparse

PAGE_TEXT_MAX = 6000
LOAD_WAIT = 30.0


class BrowserError(Exception):
    pass


# --------------------------------------------------------------------------- a WebSocket, by hand

class Socket:
    """A client WebSocket over a plain TCP connection: enough for Chrome's DevTools protocol."""

    def __init__(self, url: str, timeout: float = 30.0):
        u = urlparse(url)
        if u.scheme != "ws":
            raise BrowserError(f"not a ws:// address: {url}")
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=timeout)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (f"?{u.query}" if u.query else "")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                           f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                break
            head += chunk
        status = head.split(b"\r\n", 1)[0].decode("latin-1")
        if " 101 " not in status + " ":
            body = head.split(b"\r\n\r\n", 1)[-1].decode("utf-8", "replace").strip()
            raise BrowserError(body or status)
        self.buffer = head.split(b"\r\n\r\n", 1)[1]

    def _read(self, n: int) -> bytes:
        while len(self.buffer) < n:
            chunk = self.sock.recv(max(65536, n - len(self.buffer)))
            if not chunk:
                raise BrowserError("the browser closed the connection")
            self.buffer += chunk
        out, self.buffer = self.buffer[:n], self.buffer[n:]
        return out

    def send(self, text: str) -> None:
        data = text.encode()
        head = bytearray([0x81])
        n = len(data)
        if n < 126:
            head.append(0x80 | n)
        elif n < 65536:
            head.append(0x80 | 126)
            head += struct.pack(">H", n)
        else:
            head.append(0x80 | 127)
            head += struct.pack(">Q", n)
        mask = os.urandom(4)
        self.sock.sendall(bytes(head) + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self) -> str:
        parts = []
        while True:
            b0, b1 = self._read(2)
            op, n = b0 & 0x0F, b1 & 0x7F
            if n == 126:
                n = struct.unpack(">H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack(">Q", self._read(8))[0]
            mask = self._read(4) if b1 & 0x80 else None
            data = self._read(n)
            if mask:
                data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 0x8:
                # Why it was closed is the whole message: "the browser did not start again: …".
                why = data[2:].decode("utf-8", "replace").strip() if len(data) > 2 else ""
                code = struct.unpack(">H", data[:2])[0] if len(data) >= 2 else 0
                raise BrowserError(f"the browser closed the connection: {why}" if why
                                   else f"the browser closed the connection (code {code})")
            if op == 0x9:                                  # ping: pong, and go on
                self.sock.sendall(bytes([0x8A, 0x80 | len(data)]) + b"\0\0\0\0" + data)
                continue
            if op in (0x1, 0x2, 0x0):
                parts.append(data)
                if b0 & 0x80:
                    return b"".join(parts).decode("utf-8", "replace")

    def close(self) -> None:
        try:
            self.sock.sendall(bytes([0x88, 0x80]) + b"\0\0\0\0")
        except OSError:
            pass
        self.sock.close()


class CDP:
    """Chrome DevTools Protocol over one connection to the browser, with one tab attached."""

    def __init__(self, endpoint: str):
        self.ws = Socket(endpoint)
        self.next_id = 0
        self.session: str | None = None

    def call(self, method: str, params: dict | None = None, session: str | None = "tab", timeout: float = 30.0) -> dict:
        self.next_id += 1
        mine = self.next_id
        frame = {"id": mine, "method": method, "params": params or {}}
        if session == "tab" and self.session:
            frame["sessionId"] = self.session
        self.ws.send(json.dumps(frame))
        until = time.monotonic() + timeout
        while time.monotonic() < until:
            said = json.loads(self.ws.recv())
            if said.get("id") == mine:
                if "error" in said:
                    raise BrowserError(said["error"].get("message") or str(said["error"]))
                return said.get("result") or {}
        raise BrowserError(f"{method}: no answer in {int(timeout)} s")

    def attach(self, target: str) -> None:
        self.session = self.call("Target.attachToTarget", {"targetId": target, "flatten": True}, session=None)["sessionId"]

    def evaluate(self, expression: str, timeout: float = 30.0):
        said = self.call("Runtime.evaluate", {"expression": expression, "returnByValue": True, "awaitPromise": True},
                         timeout=timeout)
        if said.get("exceptionDetails"):
            raise BrowserError(said["exceptionDetails"].get("exception", {}).get("description")
                               or said["exceptionDetails"].get("text") or "the page's script failed")
        return said.get("result", {}).get("value")

    def close(self) -> None:
        self.ws.close()


# --------------------------------------------------------------------------- which browser, which tab

def endpoint(computers: list[dict], which: str | None = None) -> tuple[str, str]:
    """(computer name, browser address) — the one named, or the one lending a browser."""
    if not computers:
        raise BrowserError("no computer is connected to Argus — the person connects one in Argus: Settings → "
                           "Computers → Connect a computer, with argus-bridge on it")
    pick = [c for c in computers if not which or c.get("name", "").lower() == which.lower() or c.get("id") == which]
    if which and not pick:
        raise BrowserError(f"no computer called {which!r}: " + ", ".join(c.get("name", "?") for c in computers))
    for c in pick:
        if c.get("endpoint"):
            return c["name"], c["endpoint"]
    names = ", ".join(c.get("name", "?") + (" (not connected)" if not c.get("connected") else "") for c in pick)
    raise BrowserError(f"no browser is lent now ({names}) — the person switches Browser on in argus-bridge, "
                       "on that computer (This computer → Browser). Do not ask for SSH tunnels or debugging ports.")


def _tab_file(computer: str) -> Path:
    session = os.environ.get("ARGUS_SESSION") or os.environ.get("TMUX_PANE", "").strip("%") or "default"
    base = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "argus" / "browser"
    return base / f"{''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in computer + '-' + session)}.json"


def _pages(cdp: CDP) -> list[dict]:
    return [t for t in cdp.call("Target.getTargets", session=None).get("targetInfos", []) if t.get("type") == "page"]


def _tab(cdp: CDP, computer: str, new: bool = False) -> str:
    """The agent's tab: the one remembered if it is still open, else a new one."""
    keep = _tab_file(computer)
    pages = {t["targetId"]: t for t in _pages(cdp)}
    if not new:
        try:
            mine = json.loads(keep.read_text()).get("tab")
        except (OSError, ValueError):
            mine = None
        if mine in pages:
            return mine
    made = cdp.call("Target.createTarget", {"url": "about:blank"}, session=None)["targetId"]
    keep.parent.mkdir(parents=True, exist_ok=True)
    keep.write_text(json.dumps({"tab": made}))
    return made


def _wait_loaded(cdp: CDP) -> None:
    until = time.monotonic() + LOAD_WAIT
    while time.monotonic() < until:
        try:
            if cdp.evaluate("document.readyState", timeout=5) == "complete":
                return
        except BrowserError:
            pass
        time.sleep(0.2)


def _session(computers: list[dict], which: str | None, new: bool = False) -> tuple[str, CDP, str]:
    name, ep = endpoint(computers, which)
    cdp = CDP(ep)
    try:
        tab = _tab(cdp, name, new)
        cdp.attach(tab)
        cdp.call("Page.enable")
    except Exception:
        cdp.close()
        raise
    return name, cdp, tab


# --------------------------------------------------------------------------- what an agent does

# Everything one can click or type into, numbered on the page itself (data-argus-n) so that the
# number `look` gave is what `click` and `type` find — and words, when a number is not at hand.
MARK = r"""
(() => {
  const pick = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[contenteditable=true],summary,label[for]';
  const seen = [];
  let n = 0;
  for (const e of document.querySelectorAll(pick)) {
    const r = e.getBoundingClientRect();
    const st = getComputedStyle(e);
    if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') { e.removeAttribute('data-argus-n'); continue; }
    n += 1;
    e.setAttribute('data-argus-n', String(n));
    const field = e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.tagName === 'SELECT';
    const words = ((field ? (e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].innerText) || e.getAttribute('placeholder') || e.getAttribute('name')) : '')
      || e.getAttribute('aria-label') || e.innerText || e.value || e.getAttribute('placeholder') || e.getAttribute('title') || e.getAttribute('name') || e.getAttribute('alt') || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    const kind = e.tagName.toLowerCase() + (e.type && e.tagName !== 'BUTTON' ? `[${e.type}]` : '');
    seen.push({ n, kind, words, href: e.href ? String(e.href).slice(0, 120) : undefined, value: (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA') && e.type !== 'password' ? String(e.value || '').slice(0, 60) : undefined });
  }
  return seen;
})()
"""

FIND = r"""
((want) => {
  if (/^\d+$/.test(want)) return document.querySelector(`[data-argus-n="${want}"]`) ? `[data-argus-n="${want}"]` : null;
  const all = [...document.querySelectorAll('[data-argus-n]')];
  const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const w = norm(want);
  // Every name a person would use for it: its label, its words, its placeholder, what it holds.
  const names = (e) => [e.getAttribute('aria-label'), e.labels && e.labels[0] && e.labels[0].innerText, e.innerText,
    e.getAttribute('placeholder'), e.getAttribute('title'), e.getAttribute('name'), e.value].map(norm).filter(Boolean);
  const hit = all.find((e) => names(e).some((n) => n === w)) || all.find((e) => names(e).some((n) => n.includes(w)));
  if (hit) return `[data-argus-n="${hit.getAttribute('data-argus-n')}"]`;
  try { if (document.querySelector(want)) return want; } catch (e) { /* not a selector */ }
  return null;
})
"""


def _find(cdp: CDP, target) -> str:
    cdp.evaluate(MARK)
    selector = cdp.evaluate(f"{FIND}({json.dumps(str(target))})")
    if not selector:
        raise BrowserError(f"nothing on the page matches {target!r} — look again (browser_look) for the numbers")
    return selector


def _center(cdp: CDP, selector: str) -> tuple[float, float]:
    box = cdp.evaluate(f"""(() => {{ const e = document.querySelector({json.dumps(selector)});
      e.scrollIntoView({{block: 'center', inline: 'center'}}); const r = e.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2]; }})()""")
    return box[0], box[1]


def _summary(cdp: CDP) -> dict:
    return cdp.evaluate("({title: document.title, url: location.href})") or {}


def open_page(computers: list[dict], url: str, which: str | None = None, new: bool = False) -> dict:
    """Open `url` in the agent's tab of the person's browser, and wait for it to load."""
    if not url or not isinstance(url, str):
        raise BrowserError("a url to open")
    if "://" not in url and not url.startswith(("about:", "data:")):
        url = "https://" + url
    name, cdp, tab = _session(computers, which, new)
    try:
        said = cdp.call("Page.navigate", {"url": url})
        if said.get("errorText"):
            raise BrowserError(f"{url}: {said['errorText']}")
        _wait_loaded(cdp)
        cdp.call("Target.activateTarget", {"targetId": tab}, session=None)
        return {"computer": name, **_summary(cdp)}
    finally:
        cdp.close()


def look(computers: list[dict], which: str | None = None, shot: bool = True) -> dict:
    """What the agent's tab shows: title, address, its text, everything clickable numbered, a picture."""
    name, cdp, _ = _session(computers, which)
    try:
        elements = cdp.evaluate(MARK) or []
        text = cdp.evaluate("document.body ? document.body.innerText : ''") or ""
        out = {"computer": name, **_summary(cdp), "elements": elements,
               "text": text[:PAGE_TEXT_MAX] + ("\n… (the rest cut)" if len(text) > PAGE_TEXT_MAX else "")}
        if shot:
            out["screenshot"] = cdp.call("Page.captureScreenshot", {"format": "jpeg", "quality": 70}).get("data")
        return out
    finally:
        cdp.close()


def click(computers: list[dict], target, which: str | None = None) -> dict:
    """A real click (the mouse, not a script) on what `look` numbered `target`, or what shows those words."""
    name, cdp, _ = _session(computers, which)
    try:
        x, y = _center(cdp, _find(cdp, target))
        for kind in ("mouseMoved", "mousePressed", "mouseReleased"):
            cdp.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
        time.sleep(0.4)
        _wait_loaded(cdp)
        return {"computer": name, "clicked": str(target), **_summary(cdp)}
    finally:
        cdp.close()


def type_text(computers: list[dict], target, text: str, enter: bool = False, which: str | None = None) -> dict:
    """Type into a field (what it held is replaced), as keystrokes; `enter` presses Return after."""
    name, cdp, _ = _session(computers, which)
    try:
        selector = _find(cdp, target)
        x, y = _center(cdp, selector)
        for kind in ("mousePressed", "mouseReleased"):
            cdp.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})
        cdp.evaluate(f"""(() => {{ const e = document.querySelector({json.dumps(selector)}); e.focus();
          if ('value' in e) {{ e.select?.(); e.value = ''; e.dispatchEvent(new Event('input', {{bubbles: true}})); }} }})()""")
        cdp.call("Input.insertText", {"text": str(text)})
        if enter:
            for kind in ("keyDown", "keyUp"):
                cdp.call("Input.dispatchKeyEvent", {"type": kind, "key": "Enter", "code": "Enter",
                                                    "windowsVirtualKeyCode": 13, "text": "\r" if kind == "keyDown" else ""})
            time.sleep(0.4)
            _wait_loaded(cdp)
        return {"computer": name, "typed_into": str(target), **_summary(cdp)}
    finally:
        cdp.close()


def evaluate(computers: list[dict], expression: str, which: str | None = None):
    """Run JavaScript in the agent's tab and give back its value (JSON)."""
    name, cdp, _ = _session(computers, which)
    try:
        return {"computer": name, "value": cdp.evaluate(expression)}
    finally:
        cdp.close()


def tabs(computers: list[dict], which: str | None = None) -> dict:
    name, ep = endpoint(computers, which)
    cdp = CDP(ep)
    try:
        try:
            mine = json.loads(_tab_file(name).read_text()).get("tab")
        except (OSError, ValueError):
            mine = None
        return {"computer": name, "tabs": [{"title": t.get("title"), "url": t.get("url"), "yours": t["targetId"] == mine}
                                           for t in _pages(cdp)]}
    finally:
        cdp.close()


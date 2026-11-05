"""Your browser, lent to the agents on this machine: Chrome on your computer, driven from here.

An agent that tests a web page or fills a portal wants a real browser — yours, on your desk, where
you can watch it. Before this it took an SSH reverse tunnel typed by hand in a terminal of the Mac,
Chrome started with the right flags, and a port that every user of a shared server could reach
("this would be nice to automate", 2026-11-05).

So argus-sync, already on that computer, does it the way it keeps a folder in sync:

- In Argus, *Lend your browser* makes a key `ab_…` that opens one thing, the bridge, and shows it
  inside an `argus-sync://browser?…` link.
- argus-sync starts a Chrome of its own (its own profile, so none of your sessions; a debugging
  port Chrome picks) and opens a WebSocket to `/api/browser/bridge`. Nothing listens on the Mac.
- Here, Argus opens an address on loopback for the agents — `ws://127.0.0.1:<port>/devtools/
  browser/<id>` — and carries every connection to it over the bridge, each as a channel.

The address answers only the browser's own path, whose id is a secret Chrome made up, and the
pages' paths (ids only a connected client can learn); `/json/…`, which would list them, is refused.
So another user of this machine who finds the port finds nothing to connect to. Agents get the
address from `GET /api/browser` (their key may read it), the MCP tool `browser`, `argus-say browser`.

The bridge's frames are JSON text: from here `open {ch, path}`, `msg {ch, data}`, `close {ch}`,
`bye`; from argus-sync `hello {browser, ws}`, `opened {ch}`, `msg {ch, data}`, `close {ch, why}`.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from . import devices
from .errors import ApiError

router = APIRouter(tags=["Browser"])

KEY_PREFIX = "ab_"
MAX_KEYS = 16
OPEN_WAIT = 15.0                       # how long a channel waits for Chrome to answer
BROWSER_PATH = re.compile(r"/devtools/browser/[\w-]{8,80}")
TARGET_PATH = re.compile(r"/devtools/(page|worker|shared_worker|service_worker|iframe|other)/[\w-]{8,80}")


# ------------------------------------------------------------------------------------- keys

def default_store(config_path: Path) -> Path:
    return config_path.parent / "browser-keys.json"


def load(store: Path | None) -> list[dict]:
    if not store:
        return []
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
        return [k for k in data.get("keys", []) if isinstance(k, dict) and k.get("hash")]
    except (OSError, ValueError):
        return []


def save(store: Path, keys: list[dict]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    tmp = store.with_suffix(".tmp")
    tmp.write_text(json.dumps({"keys": keys}, indent=1) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, store)


def public(keys: list[dict]) -> list[dict]:
    return [{k: v for k, v in key.items() if k != "hash"} for key in keys]


def matching(store: Path | None, presented: str | None) -> dict | None:
    if not presented or not presented.startswith(KEY_PREFIX):
        return None
    want = devices.fingerprint(presented)
    found = None
    for k in load(store):
        if hmac.compare_digest(k["hash"], want):
            found = k
    return found


def link(base: str, plain: str, name: str) -> str:
    return f"argus-sync://browser?url={quote(base, safe='')}&key={quote(plain, safe='')}&name={quote(name, safe='')}"


# ------------------------------------------------------------------------------------- the bridge

class Lend:
    """The one browser lent at a time: the bridge to it, and the loopback address for agents."""

    def __init__(self, port: int = 0):
        self.bridge: WebSocket | None = None
        self.key_id: str | None = None
        self.info: dict = {}
        self.since: float | None = None
        self.channels: dict[int, dict] = {}
        self.next_ch = 0
        self.server = None
        self.port = port
        self.sending = asyncio.Lock()

    @property
    def connected(self) -> bool:
        return self.bridge is not None and bool(self.info.get("ws"))

    def endpoint(self) -> str | None:
        if not self.connected or not self.port:
            return None
        return f"ws://127.0.0.1:{self.port}{self.info['ws']}"

    async def send(self, frame: dict) -> bool:
        ws = self.bridge
        if ws is None:
            return False
        try:
            async with self.sending:
                await ws.send_text(json.dumps(frame))
            return True
        except Exception:
            return False

    async def listen(self) -> None:
        """The loopback address, opened once and kept: an agent told the address keeps it."""
        if self.server is not None:
            return
        from websockets.asyncio.server import serve
        from websockets.http11 import Response
        from websockets.datastructures import Headers

        def refuse(status: int, text: str):
            body = text.encode()
            return Response(status, "Not Found" if status == 404 else "Forbidden",
                            Headers([("Content-Type", "text/plain"), ("Content-Length", str(len(body)))]), body)

        def check(connection, request):
            path = request.path.split("?", 1)[0]
            secret = self.info.get("ws") or ""
            if not self.connected:
                return refuse(404, "no browser is lent to this machine now")
            if path == secret or (TARGET_PATH.fullmatch(path) and secret):
                return None
            # /json/version, /json/list and the rest would hand the secret to anyone who asks.
            return refuse(404, "ask Argus for the address: GET /api/browser, or the MCP tool browser")

        self.server = await serve(self.carry, "127.0.0.1", self.port, process_request=check,
                                  max_size=None, ping_interval=None)
        self.port = self.server.sockets[0].getsockname()[1]

    async def carry(self, connection) -> None:
        """One agent's connection, over the bridge as a channel of its own."""
        self.next_ch += 1
        ch = self.next_ch
        opened = asyncio.Event()
        self.channels[ch] = {"conn": connection, "opened": opened, "closed": False}
        try:
            if not await self.send({"op": "open", "ch": ch, "path": connection.request.path}):
                return
            try:
                await asyncio.wait_for(opened.wait(), OPEN_WAIT)
            except asyncio.TimeoutError:
                return
            if self.channels.get(ch, {}).get("closed"):
                return
            async for data in connection:
                if isinstance(data, bytes):
                    data = data.decode("utf-8", "replace")
                if not await self.send({"op": "msg", "ch": ch, "data": data}):
                    break
        except Exception:
            pass
        finally:
            gone = self.channels.pop(ch, None)
            if gone and not gone["closed"]:
                await self.send({"op": "close", "ch": ch})

    async def heard(self, frame: dict) -> None:
        op = frame.get("op")
        one = self.channels.get(frame.get("ch"))
        if op == "hello":
            ws = str(frame.get("ws") or "")
            if BROWSER_PATH.fullmatch(ws):
                self.info = {"ws": ws, "browser": str(frame.get("browser") or "")[:120],
                             "client": str(frame.get("client") or "")[:80], "os": str(frame.get("os") or "")[:40]}
                self.since = time.time()
            return
        if one is None:
            return
        if op == "opened":
            one["opened"].set()
        elif op == "msg":
            try:
                await one["conn"].send(str(frame.get("data") or ""))
            except Exception:
                pass
        elif op == "close":
            one["closed"] = True
            one["opened"].set()
            try:
                await one["conn"].close(1000, str(frame.get("why") or "")[:100])
            except Exception:
                pass

    async def drop(self) -> None:
        """The bridge is gone: every agent's connection with it."""
        self.bridge = None
        self.info = {}
        self.since = None
        self.key_id = None
        for ch, one in list(self.channels.items()):
            one["closed"] = True
            one["opened"].set()
            try:
                await one["conn"].close(1001, "the browser went away")
            except Exception:
                pass
            self.channels.pop(ch, None)

    def status(self, with_endpoint: bool = True) -> dict:
        out = {"connected": self.connected, "browser": self.info.get("browser") or None,
               "client": self.info.get("client") or None, "os": self.info.get("os") or None,
               "since": self.since, "channels": len(self.channels)}
        if with_endpoint:
            out["endpoint"] = self.endpoint()
        return out


def lend_of(app) -> Lend:
    if not hasattr(app.state, "lend"):
        app.state.lend = Lend(int(getattr(getattr(app.state, "cfg", None), "browser_port", 0) or 0))
    return app.state.lend


@router.websocket("/api/browser/bridge")
async def bridge(ws: WebSocket) -> None:
    key = ws.scope.get("argus_browser")
    if not key:
        await ws.close(code=1008)
        return
    await ws.accept()
    lend = lend_of(ws.app)
    # A second one takes over: the computer you are at now is the one you mean.
    if lend.bridge is not None:
        old = lend.bridge
        await lend.drop()
        try:
            await old.close(code=4000, reason="another browser took over")
        except Exception:
            pass
    lend.bridge = ws
    lend.key_id = key["id"]
    try:
        await lend.listen()
        while True:
            text = await ws.receive_text()
            try:
                frame = json.loads(text)
            except ValueError:
                continue
            if isinstance(frame, dict):
                await lend.heard(frame)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if lend.bridge is ws:
            await lend.drop()


# ------------------------------------------------------------------------------------- the routes

@router.get("/api/browser", summary="The browser lent to this machine, and its address for agents")
async def status(request: Request) -> dict:
    """`{connected, browser, client, os, since, channels, endpoint}` — `endpoint` is the
    `ws://127.0.0.1:…/devtools/browser/…` to hand to Playwright (`chromium.connectOverCDP`),
    Puppeteer (`browserWSEndpoint`) or chrome-devtools-mcp (`--wsEndpoint`); null when none is lent."""
    return lend_of(request.app).status()


@router.post("/api/browser/disconnect", summary="Give the browser back: its Chrome closes")
async def disconnect(request: Request) -> dict:
    lend = lend_of(request.app)
    was = lend.connected
    await lend.send({"op": "bye"})
    if lend.bridge is not None:
        ws = lend.bridge
        await lend.drop()
        try:
            await ws.close(code=1000, reason="given back")
        except Exception:
            pass
    return {"disconnected": was}


@router.get("/api/browser/keys", summary="The keys that may lend a browser")
async def list_keys(request: Request) -> dict:
    return {"keys": public(load(request.app.state.browser_store))}


@router.post("/api/browser/keys", summary="Make a key and the argus-sync link that lends a browser")
async def make_key(request: Request) -> dict:
    body = await request.json()
    base = str(body.get("base") or "").rstrip("/")
    if not re.fullmatch(r"https?://[\w.:\[\]-]+(/proxy/\d+)?", base):
        raise ApiError(400, "base: the address this page was opened at")
    store = request.app.state.browser_store
    keys = load(store)
    if len(keys) >= MAX_KEYS:
        raise ApiError(400, f"{MAX_KEYS} keys already — take one back first")
    plain = KEY_PREFIX + secrets.token_urlsafe(devices.TOKEN_BYTES)
    entry = {"id": secrets.token_hex(6), "name": devices.tidy_name(str(body.get("name") or "").strip() or "my computer"),
             "created": int(time.time()), "hash": devices.fingerprint(plain)}
    keys.append(entry)
    save(store, keys)
    return {"key": public([entry])[0], "token": plain, "link": link(base, plain, entry["name"])}


@router.delete("/api/browser/keys/{key_id}", summary="Take a key back: its browser is given back too")
async def take_back(request: Request, key_id: str) -> dict:
    store = request.app.state.browser_store
    keys = load(store)
    gone = next((k for k in keys if k["id"] == key_id), None)
    if not gone:
        raise ApiError(404, "no such key")
    save(store, [k for k in keys if k["id"] != key_id])
    lend = lend_of(request.app)
    if lend.key_id == key_id and lend.bridge is not None:
        await lend.send({"op": "bye"})
        ws = lend.bridge
        await lend.drop()
        try:
            await ws.close(code=1000, reason="key taken back")
        except Exception:
            pass
    return {"revoked": public([gone])[0]}

"""Your computers, connected: a terminal on them, their browser for the agents, a command an agent asks.

argus-bridge, already on your Mac or PC to keep a folder in sync, also links that computer to Argus
("argus-bridge as the go-between that does things on the PC, to link the web and the PC", 2026-11-05).
Before it, the same took an SSH reverse tunnel typed by hand, Chrome started with the right flags,
and a port every user of a shared server could reach.

- *Connect a computer* makes a key `ac_…` that opens one thing, the bridge, inside an
  `argus-bridge://computer?…` link. argus-bridge opens a WebSocket to `/api/computers/bridge` and keeps
  it. Nothing listens on the computer, nothing goes over SSH.
- **The computer decides what it lends**, with three switches in argus-bridge, all off until turned
  on: *browser* (a Chrome of its own, own profile), *terminal* (a shell, for you, in a window of
  the desk), *actions* (a command an agent asks to run, each one put to you as Do it / No). Its
  hello says which are on, and it refuses a channel for one that is off: a stolen Argus token
  reaches no more than the switches allow.
- Agents get the browser at a loopback address of its own per computer —
  `ws://127.0.0.1:<port>/devtools/browser/<id>` — which answers only that path, whose id is a secret
  Chrome made up, and its pages'; `/json/…`, which would list them, is refused. Another user of this
  server who finds the port finds nothing to connect to.

The bridge's frames are JSON text. From here: `open {ch, kind, …}` with kind `cdp {path}`, `pty
{cols, rows}` or `run {command, cwd, timeout}`; `msg {ch, data | b64}`; `resize {ch, cols, rows}`;
`close {ch}`; `bye`. From the computer: `hello {name, os, client, offers, browser: {ws, version}}`,
`opened {ch}`, `msg {ch, data | b64}`, `close {ch, why, code}`.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import os
import re
import secrets
import time
import uuid
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from . import devices
from .errors import ApiError

router = APIRouter(tags=["Computers"])

KEY_PREFIX = "ac_"
MAX_KEYS = 16
OPEN_WAIT = 15.0                       # how long a channel waits for the computer to answer
RUN_WAIT_MAX = 600                     # a command an agent asked runs at most this long
RUN_OUTPUT_MAX = 200_000
OFFERS = ("browser", "terminal", "actions")
BROWSER_PATH = re.compile(r"/devtools/browser/[\w-]{8,80}")
TARGET_PATH = re.compile(r"/devtools/(page|worker|shared_worker|service_worker|iframe|other)/[\w-]{8,80}")


# ------------------------------------------------------------------------------------- keys

def default_store(config_path: Path) -> Path:
    return config_path.parent / "computer-keys.json"


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
    return f"argus-bridge://computer?url={quote(base, safe='')}&key={quote(plain, safe='')}&name={quote(name, safe='')}"


# ------------------------------------------------------------------------------------- one computer

def close_reason(why: str) -> str:
    """A WebSocket close reason holds 123 bytes: cut on a character, with an ellipsis, never mid-UTF-8.
    The whole reason is kept on the Link and said by `computers`."""
    raw = why.encode()
    if len(raw) <= 123:
        return why
    return raw[:120].decode("utf-8", "ignore") + "…"


class Link:
    """One computer's bridge, its channels, and the loopback address of its browser."""

    def __init__(self, key: dict):
        self.key_id = key["id"]
        self.name = key.get("name") or "a computer"
        self.bridge: WebSocket | None = None
        self.hello: dict = {}
        self.since: float | None = None
        self.channels: dict[int, dict] = {}
        self.next_ch = 0
        self.server = None
        self.port = 0
        self.sending = asyncio.Lock()
        # Ports of this server shown on the computer's localhost: {port here: port there}.
        self.forwards: dict[int, int] = {}
        # The browser's address for agents, made here and kept while this server runs: the computer
        # starts its Chrome only when an agent first uses it, and maps this path to that Chrome's.
        self.secret = f"/devtools/browser/{uuid.uuid4()}"
        self.asked: dict[int, asyncio.Future] = {}
        self.tcp: dict[str, asyncio.StreamWriter] = {}
        # Why the browser refused the last connection, in full (a WebSocket close says 123 bytes), and
        # when: `computers` says it instead of "lends browser" while it does not work.
        self.browser_trouble: tuple[str, float] | None = None
        # The questions sent to this computer's notifications: the only ones it may answer.
        self.offered: set[str] = set()
        self.app = None

    @property
    def connected(self) -> bool:
        return self.bridge is not None and bool(self.hello)

    def offers(self, what: str) -> bool:
        return self.connected and bool((self.hello.get("offers") or {}).get(what))

    def browser_ws(self) -> str:
        """The browser's path agents connect to — this server's, not Chrome's (which changes with
        every start): the computer carries it to whatever Chrome is running, starting one if none."""
        return self.secret if self.offers("browser") else ""

    def endpoint(self) -> str | None:
        if not self.offers("browser") or not self.browser_ws() or not self.port:
            return None
        return f"ws://127.0.0.1:{self.port}{self.browser_ws()}"

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

    # -- channels

    def channel(self, kind: str, sink) -> tuple[int, dict]:
        """A new channel; `sink(frame)` is called with what the computer sends on it."""
        self.next_ch += 1
        one = {"kind": kind, "sink": sink, "opened": asyncio.Event(), "closed": False, "why": "", "code": None}
        self.channels[self.next_ch] = one
        return self.next_ch, one

    async def open(self, ch: int, one: dict, frame: dict) -> bool:
        if not await self.send({"op": "open", "ch": ch, **frame}):
            return False
        try:
            await asyncio.wait_for(one["opened"].wait(), OPEN_WAIT)
        except asyncio.TimeoutError:
            one["why"] = one["why"] or "the computer did not answer"
            return False
        return not one["closed"]

    async def answer(self, ident: str, said: str) -> None:
        """Do it / No pressed on the computer's notification: the same answer as a tap in Argus — only for a
        question this computer was shown, and only once (the first answer, here or in a page, stands)."""
        if ident not in self.offered or self.app is None:
            return
        self.offered.discard(ident)
        from . import asks
        try:
            await asks.answer(SimpleNamespace(app=self.app, state=SimpleNamespace(who=self.name)), ident, {"answer": said})
        except ApiError:
            pass

    async def end(self, ch: int) -> None:
        one = self.channels.pop(ch, None)
        if one and not one["closed"]:
            await self.send({"op": "close", "ch": ch})

    async def heard(self, frame: dict) -> None:
        op = frame.get("op")
        if op == "hello":
            offers = frame.get("offers") if isinstance(frame.get("offers"), dict) else {}
            browser = frame.get("browser") if isinstance(frame.get("browser"), dict) else {}
            hello = {
                "name": str(frame.get("name") or "")[:80], "os": str(frame.get("os") or "")[:40],
                "client": str(frame.get("client") or "")[:80],
                "offers": {k: bool(offers.get(k)) for k in OFFERS},
                "browser": {"ws": str(browser.get("ws") or "")[:120], "version": str(browser.get("version") or "")[:120]},
            }
            # The browser's address first, then "connected": an agent that sees the computer
            # connected must find the address there too (CI caught the moment in between).
            if hello["offers"]["browser"]:
                await self.listen()
            self.hello = hello
            self.browser_trouble = None
            self.since = time.time()
            # Back after a reconnection: the ports it showed, shown again.
            for port, local in list(self.forwards.items()):
                await self.send({"op": "forward", "port": port, "local": local})
            return
        if op == "answer":
            await self.answer(str(frame.get("ask") or ""), str(frame.get("answer") or ""))
            return
        if op == "forwarded":
            port = int(frame.get("port") or 0)
            if frame.get("ok"):
                self.forwards[port] = int(frame.get("local") or port)
            waiting = self.asked.pop(port, None)
            if waiting and not waiting.done():
                waiting.set_result(frame)
            return
        if op == "tcp":
            # Someone on the computer opened localhost:<local>: a connection to the port here.
            asyncio.ensure_future(self.carry_tcp(str(frame.get("ch")), int(frame.get("port") or 0)))
            return
        if op in ("tcp-data", "tcp-close"):
            writer = self.tcp.get(str(frame.get("ch")))
            if writer is None:
                return
            if op == "tcp-data":
                try:
                    writer.write(base64.b64decode(frame.get("b64") or ""))
                    await writer.drain()
                except Exception:
                    self.tcp.pop(str(frame.get("ch")), None)
            else:
                self.tcp.pop(str(frame.get("ch")), None)
                writer.close()
            return
        one = self.channels.get(frame.get("ch"))
        if one is None:
            return
        if op == "opened":
            one["opened"].set()
        elif op == "close":
            one["closed"] = True
            one["why"] = str(frame.get("why") or "")[:300]
            one["code"] = frame.get("code")
            one["opened"].set()
        try:
            await one["sink"](frame)
        except Exception:
            pass

    async def carry_tcp(self, ch: str, port: int) -> None:
        """One connection from the computer's localhost to a port here, for as long as both keep it."""
        if port not in self.forwards:
            await self.send({"op": "tcp-close", "ch": ch, "why": "that port is not shown on this computer"})
            return
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", port)
        except OSError as e:
            await self.send({"op": "tcp-close", "ch": ch, "why": f"nothing answers on port {port} here: {e}"})
            return
        self.tcp[ch] = writer
        await self.send({"op": "tcp-opened", "ch": ch})
        try:
            while ch in self.tcp:
                data = await reader.read(65536)
                if not data:
                    break
                if not await self.send({"op": "tcp-data", "ch": ch, "b64": base64.b64encode(data).decode()}):
                    break
        except Exception:
            pass
        finally:
            if self.tcp.pop(ch, None) is not None:
                await self.send({"op": "tcp-close", "ch": ch})
            writer.close()

    async def drop(self) -> None:
        """The bridge is gone: every channel with it."""
        self.bridge = None
        for writer in self.tcp.values():
            writer.close()
        self.tcp.clear()
        self.hello = {}
        self.since = None
        for ch, one in list(self.channels.items()):
            one["closed"] = True
            one["why"] = one["why"] or "the computer went away"
            one["opened"].set()
            try:
                await one["sink"]({"op": "close", "ch": ch, "why": one["why"]})
            except Exception:
                pass
            self.channels.pop(ch, None)

    # -- the browser, for agents

    async def listen(self) -> None:
        """The loopback address, opened once and kept: an agent told the address keeps it."""
        if self.server is not None:
            return
        from websockets.asyncio.server import serve
        from websockets.datastructures import Headers
        from websockets.http11 import Response

        def refuse(text: str):
            body = text.encode()
            return Response(404, "Not Found", Headers([("Content-Type", "text/plain"), ("Content-Length", str(len(body)))]), body)

        def check(connection, request):
            path = request.path.split("?", 1)[0]
            secret = self.browser_ws()
            if not self.offers("browser") or not secret:
                return refuse("no browser is lent from this computer now")
            if path == secret or TARGET_PATH.fullmatch(path):
                return None
            # /json/version, /json/list and the rest would hand the secret to anyone who asks.
            return refuse("ask Argus for the address: GET /api/computers, or the MCP tool computers")

        self.server = await serve(self.carry_cdp, "127.0.0.1", 0, process_request=check, max_size=None, ping_interval=None)
        self.port = self.server.sockets[0].getsockname()[1]

    async def carry_cdp(self, connection) -> None:
        async def sink(frame):
            if frame.get("op") == "msg":
                await connection.send(str(frame.get("data") or ""))
            elif frame.get("op") == "close":
                why = str(frame.get("why") or "")
                if why and not one.get("opened_ok"):
                    self.browser_trouble = (why, time.time())
                await connection.close(1000 if not why else 1011, close_reason(why))

        ch, one = self.channel("cdp", sink)
        try:
            if not await self.open(ch, one, {"kind": "cdp", "path": connection.request.path}):
                why = one["why"] or "the browser did not answer"
                self.browser_trouble = (why, time.time())
                await connection.close(1011, close_reason(why))
                return
            one["opened_ok"] = True
            self.browser_trouble = None
            async for data in connection:
                if isinstance(data, bytes):
                    data = data.decode("utf-8", "replace")
                if not await self.send({"op": "msg", "ch": ch, "data": data}):
                    break
        except Exception:
            pass
        finally:
            await self.end(ch)

    def status(self, with_endpoint: bool = True) -> dict:
        out = {"id": self.key_id, "name": self.name, "connected": self.connected,
               "os": self.hello.get("os") or None, "client": self.hello.get("client") or None,
               "since": self.since, "offers": (self.hello.get("offers") if self.connected else {k: False for k in OFFERS}),
               "browser": (((self.hello.get("browser") or {}).get("version") or "Chrome — starts when an agent uses it")
                           if self.offers("browser") else None),
               "channels": len(self.channels),
               "forwards": [{"port": p, "local": loc} for p, loc in sorted(self.forwards.items())] if self.connected else []}
        if with_endpoint:
            out["endpoint"] = self.endpoint()
        if self.browser_trouble and self.offers("browser"):
            out["browser_trouble"] = self.browser_trouble[0]
        return out


def links(app) -> dict[str, Link]:
    if not hasattr(app.state, "computers"):
        app.state.computers = {}
    return app.state.computers


def link_for(app, key: dict) -> Link:
    known = links(app)
    if key["id"] not in known:
        known[key["id"]] = Link(key)
    one = known[key["id"]]
    one.name = key.get("name") or one.name
    return one


def find(app, ident: str) -> Link:
    """A computer by id or by name (agents say the name)."""
    store = app.state.computer_store
    for key in load(store):
        if key["id"] == ident or (key.get("name") or "").lower() == str(ident).lower():
            return link_for(app, key)
    raise ApiError(404, f"no computer called {ident!r} — see GET /api/computers")


async def give_back(one: Link, why: str) -> bool:
    was = one.connected
    await one.send({"op": "bye"})
    if one.bridge is not None:
        ws = one.bridge
        await one.drop()
        try:
            await ws.close(code=1000, reason=why)
        except Exception:
            pass
    return was


# ------------------------------------------------------------------------------------- the bridge

@router.websocket("/api/computers/bridge")
async def bridge(ws: WebSocket) -> None:
    key = ws.scope.get("argus_computer")
    if not key:
        await ws.close(code=1008)
        return
    await ws.accept()
    one = link_for(ws.app, key)
    # The same computer again (it restarted, the network came back): the new one is the one.
    if one.bridge is not None:
        old = one.bridge
        await one.drop()
        try:
            await old.close(code=4000, reason="connected again")
        except Exception:
            pass
    one.bridge = ws
    one.app = ws.app
    try:
        while True:
            text = await ws.receive_text()
            try:
                frame = json.loads(text)
            except ValueError:
                continue
            if isinstance(frame, dict):
                await one.heard(frame)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if one.bridge is ws:
            await one.drop()


# ------------------------------------------------------------------------------------- a terminal, for you

@router.websocket("/ws/computer/{ident}")
async def terminal(ws: WebSocket, ident: str, cols: int = 80, rows: int = 24) -> None:
    """A shell on the computer, in the same protocol as a tmux session's (app/term.py): binary
    frames are keys and output, text frames JSON (`resize` in, `ready` / `exit` out)."""
    await ws.accept()
    try:
        one = find(ws.app, ident)
    except ApiError as e:
        await ws.send_text(json.dumps({"type": "exit", "reason": str(getattr(e, "message", "") or e)}))
        return await ws.close()
    if not one.offers("terminal"):
        reason = "the computer is not connected" if not one.connected else "its terminal is off — turn it on in argus-bridge, on that computer"
        await ws.send_text(json.dumps({"type": "exit", "reason": reason}))
        return await ws.close()

    async def sink(frame):
        if frame.get("op") == "msg":
            data = base64.b64decode(frame["b64"]) if frame.get("b64") else str(frame.get("data") or "").encode()
            await ws.send_bytes(data)
        elif frame.get("op") == "close":
            await ws.send_text(json.dumps({"type": "exit", "reason": str(frame.get("why") or "the shell ended")}))
            await ws.close()

    ch, chan = one.channel("pty", sink)
    try:
        if not await one.open(ch, chan, {"kind": "pty", "cols": max(2, min(cols, 1000)), "rows": max(2, min(rows, 1000))}):
            await ws.send_text(json.dumps({"type": "exit", "reason": chan["why"] or "the computer did not open a shell"}))
            return await ws.close()
        await ws.send_text(json.dumps({"type": "ready", "fixed": False}))
        while True:
            message = await ws.receive()
            if message["type"] == "websocket.disconnect":
                break
            if message.get("bytes") is not None:
                await one.send({"op": "msg", "ch": ch, "b64": base64.b64encode(message["bytes"]).decode()})
            elif message.get("text"):
                try:
                    control = json.loads(message["text"])
                except ValueError:
                    continue
                if isinstance(control, dict) and control.get("type") == "resize":
                    await one.send({"op": "resize", "ch": ch, "cols": max(2, min(int(control.get("cols") or 80), 1000)),
                                    "rows": max(2, min(int(control.get("rows") or 24), 1000))})
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        await one.end(ch)


# ------------------------------------------------------------------------------------- a command

async def run(app, ident: str, command: str, cwd: str = "", timeout: float = 120) -> dict:
    """Run one command on the computer and wait for it: `{code, output, cut, seconds}`."""
    one = find(app, ident)
    if not one.offers("actions"):
        raise ApiError(409, "the computer is not connected" if not one.connected
                       else "its actions are off — turn them on in argus-bridge, on that computer")
    command = str(command or "").strip()
    if not command:
        raise ApiError(400, "a command, in words the computer's shell runs")
    timeout = max(1.0, min(float(timeout or 120), RUN_WAIT_MAX))
    out: list[str] = []
    size = 0
    done = asyncio.Event()

    async def sink(frame):
        nonlocal size
        if frame.get("op") == "msg":
            text = base64.b64decode(frame["b64"]).decode("utf-8", "replace") if frame.get("b64") else str(frame.get("data") or "")
            if size < RUN_OUTPUT_MAX:
                out.append(text[: RUN_OUTPUT_MAX - size])
            size += len(text)
        elif frame.get("op") == "close":
            done.set()

    ch, chan = one.channel("run", sink)
    started = time.monotonic()
    try:
        if not await one.open(ch, chan, {"kind": "run", "command": command, "cwd": str(cwd or ""), "timeout": timeout}):
            raise ApiError(502, chan["why"] or "the computer did not run it")
        try:
            await asyncio.wait_for(done.wait(), timeout + 10)
        except asyncio.TimeoutError:
            raise ApiError(504, f"no answer after {int(timeout)} s — stopped") from None
    finally:
        await one.end(ch)
    return {"computer": one.name, "command": command, "code": chan["code"], "output": "".join(out),
            "cut": size > RUN_OUTPUT_MAX, "seconds": round(time.monotonic() - started, 2),
            "why": chan["why"] if chan["code"] is None else ""}


async def login(app, ident: str, target: str, want: str = "fill", account: str = "") -> dict:
    """An agent signed in with the person's saved login, in its own tab of that computer's browser:
    argus-bridge finds the login for the tab's site, asks the person there (unless the site is "Always"),
    and types it into the page. What comes back says which fields, for which account, from where —
    never a password, which does not pass through this server at all. `want: "list"` names the accounts
    kept for the tab's site instead."""
    one = find(app, ident)
    if not one.offers("browser"):
        raise ApiError(409, "the computer is not connected" if not one.connected
                       else "its browser is off — turn it on in argus-bridge, on that computer")
    if not re.fullmatch(r"[A-Za-z0-9]{8,64}", str(target or "")):
        raise ApiError(400, "target: the agent's own tab")
    said: list[str] = []
    done = asyncio.Event()

    async def sink(frame):
        if frame.get("op") == "msg":
            said.append(str(frame.get("data") or ""))
        elif frame.get("op") == "close":
            done.set()

    ch, chan = one.channel("login", sink)
    try:
        frame = {"kind": "login", "target": target, "want": "list" if want == "list" else "fill",
                 "account": str(account or "")[:200]}
        # Answered and closed already, cleanly, before the open was even looked at (a sign-in on a site
        # marked Always takes a moment): that is an answer, not a computer gone.
        if not await one.open(ch, chan, frame) and chan["code"] != 0:
            raise ApiError(409, chan["why"] or "the computer did not answer — is its argus-bridge up to date?")
        try:
            # The person may be asked on the computer first: as long as a question waits.
            await asyncio.wait_for(done.wait(), LOGIN_WAIT)
        except asyncio.TimeoutError:
            raise ApiError(504, f"no answer from {one.name} after {LOGIN_WAIT} s — the person was asked there, and has not answered") from None
    finally:
        await one.end(ch)
    if chan["code"] != 0:
        raise ApiError(409, chan["why"] or "not signed in")
    try:
        return {"computer": one.name, **json.loads("".join(said) or "{}")}
    except ValueError:
        raise ApiError(502, "argus-bridge answered something unreadable") from None


LOGIN_WAIT = 150


# ------------------------------------------------------------------------------------- the routes

@router.get("/api/computers", summary="The computers connected to Argus, and what each lends")
async def listing(request: Request) -> dict:
    """`{computers: [{id, name, connected, os, client, since, offers: {browser, terminal, actions},
    browser, endpoint}]}`. `endpoint` is the `ws://127.0.0.1:…/devtools/browser/…` of the browser
    that computer lends — for Playwright (`chromium.connectOverCDP`), Puppeteer (`browserWSEndpoint`)
    or chrome-devtools-mcp (`--wsEndpoint`); null when it lends none."""
    keys = load(request.app.state.computer_store)
    return {"computers": [link_for(request.app, k).status() | {"created": k.get("created")} for k in keys]}


@router.post("/api/computers/keys", summary="Connect a computer: a key, and the argus-bridge link that carries it")
async def make_key(request: Request) -> dict:
    body = await request.json()
    base = str(body.get("base") or "").rstrip("/")
    if not re.fullmatch(r"https?://[\w.:\[\]-]+(/proxy/\d+)?", base):
        raise ApiError(400, "base: the address this page was opened at")
    store = request.app.state.computer_store
    keys = load(store)
    if len(keys) >= MAX_KEYS:
        raise ApiError(400, f"{MAX_KEYS} computers already — forget one first")
    plain = KEY_PREFIX + secrets.token_urlsafe(devices.TOKEN_BYTES)
    entry = {"id": secrets.token_hex(6), "name": devices.tidy_name(str(body.get("name") or "").strip() or "my computer"),
             "created": int(time.time()), "hash": devices.fingerprint(plain)}
    keys.append(entry)
    save(store, keys)
    return {"computer": public([entry])[0], "token": plain, "link": link(base, plain, entry["name"])}


@router.post("/api/computers/{ident}/disconnect", summary="Disconnect a computer: what it lent closes")
async def disconnect(request: Request, ident: str) -> dict:
    return {"disconnected": await give_back(find(request.app, ident), "given back")}


@router.post("/api/computers/{ident}/run", summary="Run a command on a computer and wait for it")
async def run_route(request: Request, ident: str) -> dict:
    """`{command, cwd?, timeout?}` → `{code, output, cut, seconds}`. Only if that computer has its
    actions on (a switch in argus-bridge, there). Agents ask for it as the request `computer_run`."""
    body = await request.json()
    return await run(request.app, ident, body.get("command"), body.get("cwd") or "", body.get("timeout") or 120)


@router.post("/api/computers/login", summary="Sign an agent in with the person's saved login")
async def login_route(request: Request) -> dict:
    """`{target, computer?, account?, want?}` → `{host, account, source, username, password, otp}` (which fields
    were filled — never with what), or with `want: "list"` → `{host, accounts}`. The agent's own tab of
    the computer's browser; argus-bridge keeps the logins (its vault in the system keychain, 1Password),
    asks the person there unless the site is "Always", and fills only on the login's own site."""
    body = await request.json()
    ident = str(body.get("computer") or "")
    if not ident:
        connected = [one for one in links(request.app).values() if one.offers("browser")]
        if len(connected) != 1:
            raise ApiError(400, "computer: which one" if connected else "no computer lends its browser")
        ident = connected[0].key_id
    said = await login(request.app, ident, str(body.get("target") or ""), str(body.get("want") or "fill"), str(body.get("account") or ""))
    from . import journal
    if said.get("accounts") is not None:
        journal.note(request.scope, f"logins listed for {said.get('host')}")
    else:
        journal.note(request.scope, f"signed in on {said.get('host')} as {said.get('account')} (from {said.get('source')})")
    return said


@router.post("/api/computers/{ident}/forward", summary="Show a port of this server on the computer's localhost")
async def forward(request: Request, ident: str) -> dict:
    """`{port, local?}` → `{port, local, url}`: localhost:<local> on that computer now reaches
    127.0.0.1:<port> here, through argus-bridge — what `ssh -N -L` does, without SSH. `local` defaults to
    the same number, or the next free one there."""
    body = await request.json()
    try:
        port = int(body.get("port"))
        local = int(body.get("local") or port)
    except (TypeError, ValueError):
        raise ApiError(400, "port: a number") from None
    if not (1 <= port <= 65535 and 1024 <= local <= 65535):
        raise ApiError(400, "a port here 1-65535, and one there from 1024")
    one = find(request.app, ident)
    if not one.connected:
        raise ApiError(409, f"{one.name} is not connected")
    waiting = asyncio.get_running_loop().create_future()
    one.asked[port] = waiting
    await one.send({"op": "forward", "port": port, "local": local})
    try:
        said = await asyncio.wait_for(waiting, OPEN_WAIT)
    except asyncio.TimeoutError:
        raise ApiError(504, f"{one.name} did not answer — is its argus-bridge up to date?") from None
    if not said.get("ok"):
        raise ApiError(409, str(said.get("why") or "it could not listen there"))
    there = int(said.get("local") or local)
    return {"computer": one.name, "port": port, "local": there, "url": f"http://localhost:{there}/"}


@router.delete("/api/computers/{ident}/forward/{port}", summary="Stop showing a port on the computer")
async def unforward(request: Request, ident: str, port: int) -> dict:
    one = find(request.app, ident)
    one.forwards.pop(port, None)
    await one.send({"op": "unforward", "port": port})
    return {"stopped": port}


@router.delete("/api/computers/{ident}", summary="Forget a computer: its key no longer opens anything")
async def forget(request: Request, ident: str) -> dict:
    one = find(request.app, ident)
    store = request.app.state.computer_store
    keys = load(store)
    gone = next(k for k in keys if k["id"] == one.key_id)
    save(store, [k for k in keys if k["id"] != one.key_id])
    await give_back(one, "key taken back")
    if one.server is not None:
        one.server.close()
    links(request.app).pop(one.key_id, None)
    return {"forgotten": public([gone])[0]}

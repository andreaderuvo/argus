"""A browser lent from a computer, driven by the agents here (app/browserlend.py).

"An SSH tunnel by hand, Chrome with the right flags, a port every user can reach: it would be nice
to automate this" (2026-11-05). argus-sync, on that computer, starts a Chrome of its own and opens a
WebSocket to Argus; Argus gives the agents a loopback address that carries their connections over it.

Here the computer is played by a few lines of Python doing what argus-sync does, against a real
Argus and a real headless Chromium: an agent's CDP client gets the browser's version, opens a page
and evaluates in it — through the bridge. And what must not work does not: the lists under /json,
a made-up browser id, the browser key anywhere but the bridge.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from tests.browser.conftest import find_chromium

MASTER = "m" * 64
CHROMIUM = find_chromium()

pytestmark = pytest.mark.skipif(CHROMIUM is None, reason="needs a Chromium")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def live(tmp_path):
    import uvicorn

    from app.config import Config
    from app.main import create_app

    port = free_port()
    cfg = Config(token=MASTER, roots=[tmp_path], listen=f"127.0.0.1:{port}")
    cfg.devices_store = tmp_path / "devices.json"
    cfg.prefs_store = tmp_path / "prefs.json"
    cfg.tmux_socket = f"argus-t-lend-{os.getpid()}"
    server = uvicorn.Server(uvicorn.Config(create_app(cfg), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(5)


@pytest.fixture
def chrome(tmp_path):
    """A headless Chromium with its own profile and a debugging port it picks — what argus-sync starts."""
    profile = Path(tempfile.mkdtemp(prefix="argus-lend-"))
    proc = subprocess.Popen([CHROMIUM, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
                             "--remote-debugging-port=0", f"--user-data-dir={profile}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    active = profile / "DevToolsActivePort"
    for _ in range(200):
        if active.exists() and len(active.read_text().splitlines()) >= 2:
            break
        time.sleep(0.05)
    port, path = active.read_text().splitlines()[:2]
    yield int(port), path
    proc.kill()
    proc.wait(5)
    shutil.rmtree(profile, ignore_errors=True)


def call(base, path, method="GET", body=None, token=MASTER):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


async def lender(base, key, chrome_port, chrome_path, told):
    """What argus-sync does: hello, then each channel Argus opens is a connection to Chrome."""
    import websockets

    url = base.replace("http", "ws", 1) + "/api/browser/bridge"
    async with websockets.connect(url, additional_headers={"authorization": f"Bearer {key}"}, max_size=None) as bridge:
        await bridge.send(json.dumps({"op": "hello", "browser": "HeadlessChrome/test", "ws": chrome_path,
                                      "client": "test lender", "os": "linux"}))
        pipes = {}

        async def pipe(ch, path):
            try:
                async with websockets.connect(f"ws://127.0.0.1:{chrome_port}{path}", max_size=None) as tab:
                    pipes[ch] = tab
                    await bridge.send(json.dumps({"op": "opened", "ch": ch}))
                    async for data in tab:
                        await bridge.send(json.dumps({"op": "msg", "ch": ch, "data": data}))
            except Exception as e:
                await bridge.send(json.dumps({"op": "close", "ch": ch, "why": str(e)[:80]}))

        async for text in bridge:
            frame = json.loads(text)
            told.append(frame["op"])
            if frame["op"] == "open":
                asyncio.ensure_future(pipe(frame["ch"], frame["path"]))
            elif frame["op"] == "msg":
                for _ in range(100):
                    if frame["ch"] in pipes:
                        break
                    await asyncio.sleep(0.01)
                await pipes[frame["ch"]].send(frame["data"])
            elif frame["op"] == "close" and frame["ch"] in pipes:
                await pipes.pop(frame["ch"]).close()
            elif frame["op"] == "bye":
                return


async def cdp(endpoint, method, params=None):
    import websockets
    async with websockets.connect(endpoint, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            said = json.loads(await ws.recv())
            if said.get("id") == 1:
                return said


def test_an_agent_drives_the_lent_browser_through_argus_and_nothing_else_gets_in(live, chrome):
    code, made = call(live, "/api/browser/keys", "POST", {"base": live, "name": "Mac di prova"})
    assert code == 200 and made["link"].startswith("argus-sync://browser?url=") and made["token"].startswith("ab_")
    key = made["token"]
    assert call(live, "/api/browser")[1]["connected"] is False

    # The browser key opens the bridge and nothing else.
    assert call(live, "/api/browser", token=key)[0] == 403
    assert call(live, "/api/tmux/sessions", token=key)[0] == 403

    async def scenario():
        told = []
        lending = asyncio.ensure_future(lender(live, key, *chrome, told))
        for _ in range(100):
            said = await asyncio.to_thread(call, live, "/api/browser")
            if said[1].get("connected"):
                break
            await asyncio.sleep(0.05)
        status = said[1]
        assert status["browser"] == "HeadlessChrome/test" and status["client"] == "test lender"
        endpoint = status["endpoint"]
        assert endpoint.startswith("ws://127.0.0.1:") and endpoint.endswith(chrome[1])

        version = await cdp(endpoint, "Browser.getVersion")
        assert "Chrome" in version["result"]["product"], version
        made = await cdp(endpoint, "Target.createTarget", {"url": "about:blank"})
        page = endpoint.split("/devtools/")[0] + f"/devtools/page/{made['result']['targetId']}"
        two = await cdp(page, "Runtime.evaluate", {"expression": "6 * 7", "returnByValue": True})
        assert two["result"]["result"]["value"] == 42

        # What would give the secret away, or guess at it: refused.
        port_base = endpoint.split("/devtools/")[0].replace("ws://", "http://")
        for path in ("/json/version", "/json/list", "/json"):
            with pytest.raises(urllib.error.HTTPError) as no:
                await asyncio.to_thread(urllib.request.urlopen, port_base + path, None, 5)
            assert no.value.code == 404
        import websockets
        with pytest.raises(websockets.exceptions.InvalidStatus):
            await cdp(port_base.replace("http://", "ws://") + "/devtools/browser/00000000-0000-0000-0000-000000000000",
                      "Browser.getVersion")

        # Given back: the lender is told, the address answers nothing.
        assert (await asyncio.to_thread(call, live, "/api/browser/disconnect", "POST", {}))[1]["disconnected"] is True
        await asyncio.wait_for(lending, 10)
        assert "bye" in told
        after = (await asyncio.to_thread(call, live, "/api/browser"))[1]
        assert after["connected"] is False and after["endpoint"] is None
        with pytest.raises(websockets.exceptions.InvalidStatus):
            await cdp(endpoint, "Browser.getVersion")

    asyncio.run(scenario())


def test_a_key_taken_back_opens_nothing(live):
    code, made = call(live, "/api/browser/keys", "POST", {"base": live})
    keys = call(live, "/api/browser/keys")[1]["keys"]
    assert [k["id"] for k in keys] == [made["key"]["id"]] and "hash" not in keys[0]
    assert call(live, f"/api/browser/keys/{made['key']['id']}", "DELETE")[0] == 200

    async def refused():
        import websockets
        url = live.replace("http", "ws", 1) + "/api/browser/bridge"
        with pytest.raises((websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed)):
            async with websockets.connect(url, additional_headers={"authorization": f"Bearer {made['token']}"}) as ws:
                await ws.recv()
    asyncio.run(refused())


SYNC_BIN = os.environ.get("ARGUS_SYNC_BIN") or str(Path.home() / "argus-sync/target/debug/argus-sync")


@pytest.mark.skipif(not os.access(SYNC_BIN, os.X_OK), reason="needs an argus-sync build (ARGUS_SYNC_BIN)")
def test_the_real_argus_sync_lends_a_chrome_and_gives_it_back(live, tmp_path):
    """The client itself, end to end: `argus-sync browser <link>` starts a Chrome of its own, Argus's
    agents drive it, Disconnect in Argus closes it and the client ends."""
    made = call(live, "/api/browser/keys", "POST", {"base": live, "name": "test computer"})[1]
    home = tmp_path / "sync-home"
    client = subprocess.Popen([SYNC_BIN, "browser", made["link"], "--headless", "--chrome", CHROMIUM],
                              env={**os.environ, "ARGUS_SYNC_HOME": str(home)}, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
    try:
        status = {}
        for _ in range(300):
            status = call(live, "/api/browser")[1]
            if status.get("connected"):
                break
            time.sleep(0.1)
        assert status.get("connected"), status
        assert status["client"].startswith("argus-sync ") and "Chrome" in status["browser"]

        async def drive():
            made = await cdp(status["endpoint"], "Target.createTarget", {"url": "about:blank"})
            page = status["endpoint"].split("/devtools/")[0] + f"/devtools/page/{made['result']['targetId']}"
            said = await cdp(page, "Runtime.evaluate", {"expression": "navigator.userAgent", "returnByValue": True})
            return said["result"]["result"]["value"]
        assert "Chrome" in asyncio.run(drive())
        assert (home / "browser-link").exists() and (home / "browser-profile").is_dir()

        call(live, "/api/browser/disconnect", "POST", {})
        out, _ = client.communicate(timeout=20)
        assert client.returncode == 0 and "given back" in out, out
    finally:
        if client.poll() is None:
            client.kill()

"""A computer connected through argus-sync (app/computers.py): its browser for the agents, a terminal
on it for you, a command an agent asks — each only if that computer has it switched on.

"argus-sync as the go-between that does things on the PC" (2026-11-05). Here the computer is played
by a few lines of Python doing what argus-sync does, against a real Argus, a real headless Chromium,
a real shell in a PTY; and, when it is built, by argus-sync itself.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import pty
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
    cfg.tmux_socket = f"argus-t-pc-{os.getpid()}"
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
def chrome():
    """A headless Chromium with its own profile and a debugging port it picks — what argus-sync starts."""
    if CHROMIUM is None:
        pytest.skip("needs a Chromium")
    profile = Path(tempfile.mkdtemp(prefix="argus-pc-"))
    proc = subprocess.Popen([CHROMIUM, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
                             "--remote-debugging-port=0", f"--user-data-dir={profile}", "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    active = profile / "DevToolsActivePort"
    for _ in range(600):
        if active.exists() and len(active.read_text().splitlines()) >= 2:
            break
        time.sleep(0.05)
    else:
        proc.kill()
        pytest.fail(f"{CHROMIUM} did not open its debugging port in 30 s")
    port, path = active.read_text().splitlines()[:2]
    yield int(port), path
    proc.kill()
    proc.wait(5)
    shutil.rmtree(profile, ignore_errors=True)


def call(base, path, method="GET", body=None, token=MASTER):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def connect_one(base, name="test computer"):
    code, made = call(base, "/api/computers/keys", "POST", {"base": base, "name": name})
    assert code == 200, made
    return made


async def computer(base, key, offers, chrome_at=None, told=None):
    """What argus-sync does: hello with its switches, then each channel Argus opens — refusing a
    kind that is switched off, as the real one does."""
    import websockets

    told = told if told is not None else []
    url = base.replace("http", "ws", 1) + "/api/computers/bridge"
    async with websockets.connect(url, additional_headers={"authorization": f"Bearer {key}"}, max_size=None) as bridge:
        hello = {"op": "hello", "name": "test", "os": "linux", "client": "test computer", "offers": offers}
        if chrome_at:
            hello["browser"] = {"ws": chrome_at[1], "version": "HeadlessChrome/test"}
        await bridge.send(json.dumps(hello))
        pipes, ptys, kids = {}, {}, []

        async def say(frame):
            await bridge.send(json.dumps(frame))

        async def cdp_pipe(ch, path):
            try:
                async with websockets.connect(f"ws://127.0.0.1:{chrome_at[0]}{path}", max_size=None) as tab:
                    pipes[ch] = tab
                    await say({"op": "opened", "ch": ch})
                    async for data in tab:
                        await say({"op": "msg", "ch": ch, "data": data})
            except Exception as e:
                await say({"op": "close", "ch": ch, "why": str(e)[:80]})

        async def shell(ch, cols, rows):
            pid, fd = pty.fork()
            if pid == 0:
                os.execvpe("sh", ["sh"], {**os.environ, "PS1": "pc$ ", "TERM": "xterm"})
            ptys[ch] = fd
            kids.append(pid)
            await say({"op": "opened", "ch": ch})
            loop = asyncio.get_running_loop()
            while True:
                try:
                    data = await loop.run_in_executor(None, os.read, fd, 4096)
                except OSError:
                    data = b""
                if not data:
                    await say({"op": "close", "ch": ch, "why": "the shell ended", "code": 0})
                    return
                await say({"op": "msg", "ch": ch, "b64": base64.b64encode(data).decode()})

        async def run(ch, command, cwd):
            await say({"op": "opened", "ch": ch})
            proc = await asyncio.create_subprocess_shell(command, cwd=cwd or None, stdout=asyncio.subprocess.PIPE,
                                                         stderr=asyncio.subprocess.STDOUT)
            out, _ = await proc.communicate()
            await say({"op": "msg", "ch": ch, "data": out.decode()})
            await say({"op": "close", "ch": ch, "code": proc.returncode})

        async for text in bridge:
            frame = json.loads(text)
            told.append(frame["op"])
            ch = frame.get("ch")
            if frame["op"] == "open":
                kind = frame.get("kind")
                switch = {"cdp": "browser", "pty": "terminal", "run": "actions"}[kind]
                if not offers.get(switch):
                    await say({"op": "close", "ch": ch, "why": f"{switch} is off on this computer"})
                elif kind == "cdp":
                    asyncio.ensure_future(cdp_pipe(ch, frame["path"]))
                elif kind == "pty":
                    asyncio.ensure_future(shell(ch, frame["cols"], frame["rows"]))
                else:
                    asyncio.ensure_future(run(ch, frame["command"], frame.get("cwd")))
            elif frame["op"] == "msg":
                if ch in ptys:
                    os.write(ptys[ch], base64.b64decode(frame["b64"]))
                else:
                    for _ in range(100):
                        if ch in pipes:
                            break
                        await asyncio.sleep(0.01)
                    await pipes[ch].send(frame["data"])
            elif frame["op"] == "close":
                if ch in pipes:
                    await pipes.pop(ch).close()
                if ch in ptys:
                    os.close(ptys.pop(ch))
            elif frame["op"] == "bye":
                # The shells go with it, or their readers would hold the loop open.
                for pid in kids:
                    try:
                        os.kill(pid, 9)
                    except OSError:
                        pass
                for fd in ptys.values():
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                return


async def cdp(endpoint, method, params=None):
    import websockets
    async with websockets.connect(endpoint, max_size=None) as ws:
        await ws.send(json.dumps({"id": 1, "method": method, "params": params or {}}))
        while True:
            said = json.loads(await ws.recv())
            if said.get("id") == 1:
                return said


async def until_connected(base, cid):
    for _ in range(200):
        said = (await asyncio.to_thread(call, base, "/api/computers"))[1]
        one = next((c for c in said["computers"] if c["id"] == cid), None)
        if one and one["connected"]:
            return one
        await asyncio.sleep(0.05)
    raise AssertionError(f"never connected: {said}")


@pytest.mark.browser
def test_an_agent_drives_the_lent_browser_and_nothing_else_gets_in(live, chrome):
    made = connect_one(live, "Mac di prova")
    assert made["link"].startswith("argus-sync://computer?url=") and made["token"].startswith("ac_")
    key, cid = made["token"], made["computer"]["id"]
    assert call(live, "/api/computers")[1]["computers"][0]["connected"] is False
    # The computer's key opens its bridge and nothing else.
    assert call(live, "/api/computers", token=key)[0] == 403
    assert call(live, "/api/tmux/sessions", token=key)[0] == 403

    async def scenario():
        import websockets
        told = []
        lending = asyncio.ensure_future(computer(live, key, {"browser": True}, chrome, told))
        status = await until_connected(live, cid)
        assert status["browser"] == "HeadlessChrome/test" and status["offers"] == {"browser": True, "terminal": False, "actions": False}
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
        with pytest.raises(websockets.exceptions.InvalidStatus):
            await cdp(port_base.replace("http://", "ws://") + "/devtools/browser/00000000-0000-0000-0000-000000000000",
                      "Browser.getVersion")

        # A switch that is off is off: no shell, no command.
        code, said = await asyncio.to_thread(call, live, f"/api/computers/{cid}/run", "POST", {"command": "echo hi"})
        assert code == 409 and "actions are off" in said

        # Given back: the computer is told, the address answers nothing.
        assert (await asyncio.to_thread(call, live, f"/api/computers/{cid}/disconnect", "POST", {}))[1]["disconnected"] is True
        await asyncio.wait_for(lending, 10)
        assert "bye" in told
        after = (await asyncio.to_thread(call, live, "/api/computers"))[1]["computers"][0]
        assert after["connected"] is False and after["endpoint"] is None
        with pytest.raises(websockets.exceptions.InvalidStatus):
            await cdp(endpoint, "Browser.getVersion")

    asyncio.run(scenario())


def test_a_terminal_on_the_computer_and_a_command_run_there(live, tmp_path):
    made = connect_one(live)
    key, cid = made["token"], made["computer"]["id"]

    async def scenario():
        import websockets
        lending = asyncio.ensure_future(computer(live, key, {"terminal": True, "actions": True}))
        await until_connected(live, cid)

        # A shell, in the protocol of a tmux session's terminal: ready, keys in, output out.
        url = live.replace("http", "ws", 1) + f"/ws/computer/{cid}?token={MASTER}&cols=80&rows=24"
        async with websockets.connect(url) as term:
            assert json.loads(await term.recv())["type"] == "ready"
            await term.send(json.dumps({"type": "resize", "cols": 100, "rows": 30}))
            await term.send(f"echo $((6*7)) > {tmp_path}/typed\n".encode())
            for _ in range(100):
                if (tmp_path / "typed").exists() and (tmp_path / "typed").read_text().strip():
                    break
                await asyncio.sleep(0.05)
            assert (tmp_path / "typed").read_text().strip() == "42"

        # A command, waited for: its output and its exit code.
        code, said = await asyncio.to_thread(call, live, f"/api/computers/{cid}/run", "POST",
                                             {"command": "echo on the pc; exit 3", "cwd": str(tmp_path)})
        assert code == 200 and said["code"] == 3 and said["output"].strip() == "on the pc", said

        await asyncio.to_thread(call, live, f"/api/computers/{cid}/disconnect", "POST", {})
        await asyncio.wait_for(lending, 10)

    asyncio.run(scenario())


def test_a_terminal_when_the_computer_is_away_says_so(live):
    made = connect_one(live)

    async def scenario():
        import websockets
        url = live.replace("http", "ws", 1) + f"/ws/computer/{made['computer']['id']}?token={MASTER}"
        async with websockets.connect(url) as term:
            said = json.loads(await term.recv())
            assert said == {"type": "exit", "reason": "the computer is not connected"}
    asyncio.run(scenario())


def test_a_computer_forgotten_opens_nothing(live):
    made = connect_one(live)
    keys = call(live, "/api/computers")[1]["computers"]
    assert [k["id"] for k in keys] == [made["computer"]["id"]]
    assert call(live, f"/api/computers/{made['computer']['id']}", "DELETE")[0] == 200
    assert call(live, "/api/computers")[1]["computers"] == []

    async def refused():
        import websockets
        url = live.replace("http", "ws", 1) + "/api/computers/bridge"
        with pytest.raises((websockets.exceptions.InvalidStatus, websockets.exceptions.ConnectionClosed)):
            async with websockets.connect(url, additional_headers={"authorization": f"Bearer {made['token']}"}) as ws:
                await ws.recv()
    asyncio.run(refused())


SYNC_BIN = os.environ.get("ARGUS_SYNC_BIN") or str(Path.home() / "argus-sync/target/debug/argus-sync")


@pytest.mark.browser
@pytest.mark.skipif(not os.access(SYNC_BIN, os.X_OK), reason="needs an argus-sync build (ARGUS_SYNC_BIN)")
def test_the_real_argus_sync_connects_this_computer(live, tmp_path):
    """The client itself, end to end: `argus-sync computer <link> --browser --terminal --actions`
    starts a Chrome of its own, an agent drives it, a command runs, a shell answers; Disconnect in
    Argus closes all of it and the client ends."""
    if CHROMIUM is None:
        pytest.skip("needs a Chromium")
    made = connect_one(live)
    cid = made["computer"]["id"]
    home = tmp_path / "sync-home"
    client = subprocess.Popen([SYNC_BIN, "computer", made["link"], "--browser", "--terminal", "--actions",
                               "--headless", "--chrome", CHROMIUM],
                              env={**os.environ, "ARGUS_SYNC_HOME": str(home)}, stdout=subprocess.PIPE,
                              stderr=subprocess.STDOUT, text=True)
    try:
        async def scenario():
            import websockets
            status = await until_connected(live, cid)
            assert status["client"].startswith("argus-sync ") and "Chrome" in status["browser"], status
            made = await cdp(status["endpoint"], "Target.createTarget", {"url": "about:blank"})
            page = status["endpoint"].split("/devtools/")[0] + f"/devtools/page/{made['result']['targetId']}"
            said = await cdp(page, "Runtime.evaluate", {"expression": "navigator.userAgent", "returnByValue": True})
            assert "Chrome" in said["result"]["result"]["value"]

            code, ran = await asyncio.to_thread(call, live, f"/api/computers/{cid}/run", "POST",
                                                {"command": "echo from argus-sync; exit 4", "cwd": str(tmp_path)})
            assert code == 200 and ran["code"] == 4 and "from argus-sync" in ran["output"], ran

            url = live.replace("http", "ws", 1) + f"/ws/computer/{cid}?token={MASTER}&cols=80&rows=24"
            async with websockets.connect(url) as term:
                assert json.loads(await term.recv())["type"] == "ready"
                await term.send(f"echo typed-in-the-shell > {tmp_path}/shell\n".encode())
                for _ in range(100):
                    if (tmp_path / "shell").exists() and (tmp_path / "shell").read_text().strip():
                        break
                    await asyncio.sleep(0.05)
                assert (tmp_path / "shell").read_text().strip() == "typed-in-the-shell"
        asyncio.run(scenario())
        assert (home / "computer.json").exists() and (home / "browser-profile").is_dir()

        call(live, f"/api/computers/{cid}/disconnect", "POST", {})
        out, _ = client.communicate(timeout=20)
        assert client.returncode == 0 and "disconnected in Argus" in out, out
    finally:
        if client.poll() is None:
            client.kill()


def test_an_agent_asks_to_run_a_command_and_the_person_allows_it(live, tmp_path):
    """`request computer_run`: put to the person in words, done on Do it, the output given back."""
    made = connect_one(live, "Mac")
    cid = made["computer"]["id"]

    async def scenario():
        lending = asyncio.ensure_future(computer(live, made["token"], {"actions": True}))
        await until_connected(live, cid)
        # Refused before anything is asked, when it could not be done.
        code, said = await asyncio.to_thread(call, live, "/api/agent/request", "POST",
                                             {"action": "computer_run", "args": {"computer": "Nowhere", "command": "ls"}})
        assert code == 400 and "no computer called" in said
        code, asked = await asyncio.to_thread(call, live, "/api/agent/request", "POST",
                                              {"action": "computer_run", "args": {"computer": "mac", "command": "echo hello from the mac",
                                                                                  "cwd": str(tmp_path)}, "why": "to see"})
        assert code == 200 and asked["state"] == "asked" and "run on Mac" in asked["text"] and "echo hello from the mac" in asked["text"], asked
        question = next(q for q in (await asyncio.to_thread(call, live, "/api/asks"))[1]["asks"])
        await asyncio.to_thread(call, live, f"/api/ask/{question['id']}/answer", "POST", {"answer": "Do it"})
        for _ in range(100):
            said = (await asyncio.to_thread(call, live, f"/api/agent/request/{asked['id']}"))[1]
            if said["state"] in ("done", "failed"):
                break
            await asyncio.sleep(0.05)
        assert said["state"] == "done" and said["result"]["code"] == 0 and said["result"]["output"].strip() == "hello from the mac", said
        await asyncio.to_thread(call, live, f"/api/computers/{cid}/disconnect", "POST", {})
        await asyncio.wait_for(lending, 10)

    asyncio.run(scenario())


@pytest.mark.skipif(not os.access(SYNC_BIN, os.X_OK), reason="needs an argus-sync build (ARGUS_SYNC_BIN)")
def test_a_port_of_this_server_on_the_computers_localhost(live, tmp_path):
    """"The ssh -N -L line in System: a button too, for someone with argus-sync" (2026-11-05). A port
    that listens only on this server's loopback, made to appear on the computer's localhost."""
    import http.server
    import socketserver
    (tmp_path / "site").mkdir()
    (tmp_path / "site" / "index.html").write_text("served on the server, read on the Mac")
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(tmp_path / "site"), **k)  # noqa: E731
    site = socketserver.TCPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=site.serve_forever, daemon=True).start()
    port = site.server_address[1]
    made = connect_one(live, "Mac")
    cid = made["computer"]["id"]
    client = subprocess.Popen([SYNC_BIN, "computer", made["link"], "--nothing"],
                              env={**os.environ, "ARGUS_SYNC_HOME": str(tmp_path / "sync-home")},
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        asyncio.run(until_connected(live, cid))
        local = free_port()
        code, said = call(live, f"/api/computers/{cid}/forward", "POST", {"port": port, "local": local})
        assert code == 200 and said["local"] == local and said["url"] == f"http://localhost:{local}/", said
        assert call(live, "/api/computers")[1]["computers"][0]["forwards"] == [{"port": port, "local": local}]
        for _ in range(3):                                 # a page fetched, then again: each its own connection
            with urllib.request.urlopen(f"http://127.0.0.1:{local}/index.html", timeout=10) as r:
                assert r.read().decode() == "served on the server, read on the Mac"
        call(live, f"/api/computers/{cid}/forward/{port}", "DELETE")
        time.sleep(0.5)
        with pytest.raises(OSError):
            urllib.request.urlopen(f"http://127.0.0.1:{local}/index.html", timeout=3)
    finally:
        call(live, f"/api/computers/{cid}/disconnect", "POST", {})
        try:
            client.communicate(timeout=20)
        except subprocess.TimeoutExpired:
            client.kill()
        site.shutdown()

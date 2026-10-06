"""Argus as an MCP server (`tools/argus_mcp.py`), spoken to the way an agent's client speaks to it.

The end-to-end test starts a real Argus on a port and a throwaway tmux socket, starts the MCP
server as a subprocess with only a config file to go on — as `claude mcp add argus -- argus-mcp`
would — and talks JSON-RPC over its stdin and stdout: initialize, list the tools, call them.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import argus_mcp                                                  # noqa: E402

AGENT = "a" * 64
MASTER = "m" * 64


class Fake:
    def __init__(self):
        self.calls = []

    def who(self):
        return {"machine": "box", "launchers": ["Claude Code"], "sessions": [
            {"name": "fix", "agent": "claude", "model": "Opus", "folder": "/p", "state": "working", "wants_you": False},
            {"name": "rev", "agent": "codex", "folder": "/p", "state": "waiting", "wants_you": True}]}

    def ring(self, text, why, session):
        self.calls.append(("ring", text, why))

    def relay(self, to, text, run):
        return {"to": to, "characters": len(text), "sent": run}

    def ask(self, text, options, wait, session, patience):
        self.calls.append(("ask", text, options, patience))
        return "keep" if options else None


def call(fake, method, params=None, ident=1):
    return argus_mcp.answer({"jsonrpc": "2.0", "id": ident, "method": method, "params": params or {}}, lambda: fake)


def test_the_handshake_and_the_tool_list():
    said = call(Fake(), "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t"}})
    assert said["result"]["protocolVersion"] == "2025-06-18" and "tools" in said["result"]["capabilities"]
    assert "ask" in said["result"]["instructions"]
    # A version it does not know is answered with the newest it does, as the spec asks.
    assert call(Fake(), "initialize", {"protocolVersion": "1999-01-01"})["result"]["protocolVersion"] == argus_mcp.VERSIONS[0]
    names = [t["name"] for t in call(Fake(), "tools/list")["result"]["tools"]]
    assert names == ["who", "ring", "ask", "relay", "open_desk", "rename_desk", "launchers", "start_agent", "teams", "worktree", "prompts"]
    assert all(t["inputSchema"]["type"] == "object" for t in call(Fake(), "tools/list")["result"]["tools"])
    assert argus_mcp.answer({"jsonrpc": "2.0", "method": "notifications/initialized"}, Fake) is None
    assert call(Fake(), "nope")["error"]["code"] == -32601


def test_the_tools_say_what_happened_in_words():
    fake = Fake()
    who = call(fake, "tools/call", {"name": "who", "arguments": {}})["result"]
    assert not who["isError"]
    text = who["content"][0]["text"]
    assert "fix: claude · Opus in /p [working]" in text and "WAITING FOR THE PERSON" in text
    asked = call(fake, "tools/call", {"name": "ask", "arguments": {"question": "drop 4?", "options": ["drop", "keep"], "wait_minutes": 2}})
    assert asked["result"]["content"][0]["text"] == "The person answered: keep"
    assert fake.calls[-1] == ("ask", "drop 4?", ["drop", "keep"], 120.0)
    unanswered = call(fake, "tools/call", {"name": "ask", "arguments": {"question": "well?"}})
    assert "Nobody answered within 10 minutes" in unanswered["result"]["content"][0]["text"]
    bad = call(fake, "tools/call", {"name": "relay", "arguments": {}})["result"]
    assert bad["isError"] and "bad arguments" in bad["content"][0]["text"]


# ------------------------------------------------------------------------- end to end

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
    sock = f"argus-t-mcp-{os.getpid()}"
    cfg = Config(token=MASTER, roots=[tmp_path], listen=f"127.0.0.1:{port}")
    cfg.agents = [{"name": "in-session", "token": AGENT}]
    cfg.tmux_socket = sock
    cfg.allow_write = True
    cfg.launchers = [{"name": "Shell", "command": "sh"}]
    cfg.prefs_store = tmp_path / "prefs.json"
    server = uvicorn.Server(uvicorn.Config(create_app(cfg), host="127.0.0.1", port=port, log_level="error"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    for _ in range(100):
        if server.started:
            break
        time.sleep(0.05)
    conf = tmp_path / "config.yaml"
    conf.write_text(f"listen: 127.0.0.1:{port}\ntoken: {MASTER}\nagents:\n  - name: in-session\n    token: {AGENT}\n")
    yield conf, tmp_path
    server.should_exit = True
    thread.join(5)
    if shutil.which("tmux"):
        subprocess.run(["tmux", "-L", sock, "kill-server"], capture_output=True)


@pytest.mark.skipif(not shutil.which("tmux"), reason="needs tmux")
def test_an_agent_client_over_stdio(live):
    conf, folder = live
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "ARGUS_TOKEN", "ARGUS_SESSION")}
    env["ARGUS_CONFIG"] = str(conf)
    proc = subprocess.Popen([sys.executable, str(ROOT / "tools" / "argus-mcp")], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, text=True, env=env, cwd=folder)
    n = 0

    def rpc(method, params=None):
        nonlocal n
        n += 1
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": params or {}}) + "\n")
        proc.stdin.flush()
        return json.loads(proc.stdout.readline())

    try:
        assert rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test"}})["result"]["serverInfo"]["name"] == "argus"
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": "notifications/initialized"}) + "\n")
        assert len(rpc("tools/list")["result"]["tools"]) == 11

        def tool(tool_name, **args):
            return rpc("tools/call", {"name": tool_name, "arguments": args})["result"]

        started = tool("start_agent", launcher="Shell", name="helper", folder=str(folder), prompt="echo hi > from-helper", show_on_desk=False)
        assert not started["isError"], started
        who = tool("who")["content"][0]["text"]
        assert "helper:" in who and "can start: Shell" in who
        relayed = tool("relay", to="helper", text="echo relayed > by-relay", press_enter=True)
        assert not relayed["isError"], relayed
        for _ in range(50):
            if (folder / "by-relay").exists():
                break
            time.sleep(0.1)
        assert (folder / "by-relay").read_text().strip() == "relayed", "typed into the session, through the agent key"
        assert not tool("ring", text="finished the parser", why="done")["isError"]
        assert tool("teams")["content"][0]["text"] == "no teams", "the agent key may read the teams"
        made = tool("open_desk", name="pippo")
        assert made["content"][0]["text"] == "made the desk pippo, and switched to it"
        again = tool("open_desk", name="Pippo", show=False)
        assert again["content"][0]["text"] == "the desk pippo was already there", "found by name, any case"
        renamed = tool("rename_desk", desk="Desk 1", to="Pluto")
        assert not renamed["isError"] and "now called Pluto" in renamed["content"][0]["text"]
        clash = tool("rename_desk", desk="pluto", to="PIPPO")
        assert clash["isError"] and "already a desk called" in clash["content"][0]["text"], "two of one name: refused"
        assert tool("rename_desk", desk="Pluto", to="Desk 1")["isError"] is False
        into = tool("start_agent", launcher="Shell", name="into-pippo", folder=str(folder), desk="pippo")
        assert not into["isError"], into
        desks = json.loads((folder / "prefs.json").read_text())
        desks = desks.get("prefs", desks).get("workspaces")
        assert [d["name"] for d in desks] == ["Desk 1", "pippo"] and desks[1]["id"] == 2, \
            "one desk, once, beside the Desk 1 a browser would have made"
        refused = tool("worktree", repo=str(folder), branch="x")
        assert refused["isError"] and "Argus refused" in refused["content"][0]["text"], "not a repository: said, not raised"
    finally:
        proc.stdin.close()
        proc.wait(5)


def test_an_agent_key_cannot_start_an_agent_that_asks_nobody(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app import agentflags, launch, tmux
    from app.config import Config
    from app.main import create_app

    cfg = Config(token=MASTER, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.agents = [{"name": "in-session", "token": AGENT}]
    cfg.allow_write = True
    cfg.tmux_socket = f"argus-t-mcp-{os.getpid()}-x"
    cfg.launchers = [{"name": "Claude Code", "command": "claude"}]
    monkeypatch.setattr(agentflags, "help_of", lambda *a: "--permission-mode acceptEdits --dangerously-skip-permissions --model")
    monkeypatch.setattr(launch, "versions", lambda *a, **k: {})

    def no_start(*a, **k):
        raise tmux.TmuxError("not starting anything in a test")

    monkeypatch.setattr(launch, "start", no_start)
    c = TestClient(create_app(cfg))
    body = {"launcher": "Claude Code", "name": "x", "path": str(tmp_path)}
    as_agent = {"authorization": f"Bearer {AGENT}"}
    r = c.post("/api/tmux/launch", json={**body, "options": {"permissions": "skip"}}, headers=as_agent)
    assert r.status_code == 403 and "the person's" in r.text
    r = c.post("/api/tmux/launch", json={**body, "options": {"permissions": "edits"}}, headers=as_agent)
    assert r.status_code == 502, "an ordinary option goes through, to the start"
    r = c.post("/api/tmux/launch", json={**body, "options": {"permissions": "skip"}}, headers={"authorization": f"Bearer {MASTER}"})
    assert r.status_code == 502, "the person's key may choose it"
    assert agentflags.dangerous("claude", "--dangerously-skip-permissions", {"permissions": "skip"})
    assert not agentflags.dangerous("claude", "--dangerously-skip-permissions", {"permissions": "ask"})

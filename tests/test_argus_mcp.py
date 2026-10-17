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

    def me(self, session=""):
        return session or ""

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
    assert names == ["who", "ring", "ask", "relay", "open_desk", "rename_desk", "launchers", "start_agent", "team_task", "team_done", "team_check", "team_propose", "close_gone_windows", "request", "request_status", "todos", "todo_set", "todo_add", "notes", "note_read", "note_new", "note_add", "note_write", "note_rename", "note_delete", "teams", "worktree", "prompts"]
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
    cfg.notes_dir = tmp_path / "notes"
    cfg.agents = [{"name": "in-session", "token": AGENT}]
    cfg.tmux_socket = sock
    cfg.allow_write = True
    cfg.launchers = [{"name": "Shell", "command": "sh"}]
    cfg.prefs_store = tmp_path / "prefs.json"
    cfg.todo_store = tmp_path / "todo.json"
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
        assert len(rpc("tools/list")["result"]["tools"]) == 28

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
        assert tool("todos")["content"][0]["text"] == "nothing on the list"
        assert tool("todo_add", note="fix the parser")["content"][0]["text"] == "added #1: fix the parser"
        tool("todo_add", note="write the docs")
        assert tool("todo_set", todo="#1", status="doing")["content"][0]["text"] == "#1 is doing: fix the parser"
        assert tool("todos")["content"][0]["text"] == "#1 [doing] fix the parser\n#2 [open] write the docs"
        tool("todo_set", todo="1", status="done")
        assert "#1" not in tool("todos")["content"][0]["text"] and "#1 [done]" in tool("todos", all=True)["content"][0]["text"]
        said = tool("todo_add", note="call the lab", due="2026-10-20T15:00", remind=60)["content"][0]["text"]
        assert said == "added #3: call the lab — due 2026-10-20 15:00, Argus rings 60 minutes before", said
        assert "#3 [open] call the lab  (due 2026-10-20 15:00)" in tool("todos")["content"][0]["text"]
        assert tool("todo_add", note="x", due="soon")["isError"], "a deadline that does not read: said"
        assert tool("notes")["content"][0]["text"].startswith("no notes yet")
        made = tool("note_new", text="# Listeria ST6\n\nfour isolates")["content"][0]["text"]
        assert made.startswith("made note-1.md: ") and made.endswith("note-1.md")
        assert tool("note_add", name="note-1.md", text="- one farm")["isError"] is False
        assert tool("note_read", name="note-1.md")["content"][0]["text"].endswith("four isolates\n\n- one farm\n")
        assert tool("note_rename", name="note-1.md", to="listeria")["content"][0]["text"] == "note-1.md is now listeria.md"
        assert "listeria.md: Listeria ST6" in tool("notes")["content"][0]["text"]
        assert tool("note_write", name="listeria.md", text="rewritten")["isError"] is False
        assert "kept in the notes' trash" in tool("note_delete", name="listeria.md")["content"][0]["text"]
        assert tool("note_read", name="listeria.md")["isError"], "gone: said, not raised"
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


# ------------------------------------------------------------------- the command line, the same

# Every MCP tool, and the argus-say verb that does the same — the verbs added for parity run the
# tool's own function, so what they do cannot drift; this keeps the two lists together.
CLI_FOR = {"who": "who", "ring": "ring", "ask": "ask", "relay": "relay", "open_desk": "desk",
           "rename_desk": "desk", "launchers": "launchers", "start_agent": "start", "team_task": "task",
           "team_done": "turn", "team_check": "team-check", "team_propose": "team-propose",
           "close_gone_windows": "close-gone", "request": "request", "request_status": "status",
           "todos": "todos", "todo_set": "todo", "todo_add": "todo", "teams": "teams",
           "notes": "notes", "note_read": "note", "note_new": "note", "note_add": "note", "note_write": "note",
           "note_rename": "note", "note_delete": "note",
           "worktree": "worktree", "prompts": "prompts"}


def test_every_mcp_tool_has_its_argus_say_verb():
    import re
    tools = {t["name"] for t in argus_mcp.TOOLS}
    assert tools == set(CLI_FOR), f"a tool without its verb (or a stale entry): {tools ^ set(CLI_FOR)}"
    verbs = set(re.findall(r'add_parser\(\s*"([a-z-]+)"', (ROOT / "tools" / "argus_client.py").read_text()))
    assert set(CLI_FOR.values()) <= verbs, f"verbs missing from argus-say: {set(CLI_FOR.values()) - verbs}"


@pytest.mark.skipif(not shutil.which("tmux"), reason="needs tmux")
def test_argus_say_does_what_the_mcp_tools_do(live):
    conf, folder = live
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE", "ARGUS_TOKEN", "ARGUS_SESSION")}
    env["ARGUS_CONFIG"] = str(conf)

    def say(*args):
        done = subprocess.run([sys.executable, str(ROOT / "tools" / "argus-say"), *args], capture_output=True,
                              text=True, env=env, cwd=folder, timeout=60)
        return done.returncode, (done.stdout + done.stderr).strip()

    code, out = say("todo", "add", "write the paper")
    assert code == 0 and out.startswith("added #1"), out
    code, out = say("todo", "set", "1", "--status", "doing")
    assert code == 0 and "#1 is doing" in out, out
    code, out = say("todos")
    assert "#1 [doing] write the paper" in out, out
    (folder / "proj").mkdir()
    code, out = say("desk", "Trading", "--folder", str(folder / "proj"), "--quiet")
    assert code == 0 and "made the desk Trading" in out, out
    code, out = say("desk", "Trading", "--to", "Kraken")
    assert code == 0 and "now called Kraken" in out, out
    code, out = say("launchers")
    assert code == 0 and "Shell" in out, out
    code, out = say("launchers", "--json")
    assert json.loads(out)[0]["name"] == "Shell"
    code, out = say("prompts")
    assert code == 0, out
    code, out = say("status", "nope")
    assert code == 1 and out, "an unknown request is said, not a traceback"

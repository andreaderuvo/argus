"""The Argus plugin in each agent: read from the agents' own records, installed or updated with a
press, reloaded only where a Claude sits at its prompt, and announced at the start of a session."""

from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import pluginstate

ROOT = Path(__file__).resolve().parent.parent


def fake_home(tmp_path, claude=None, codex=None, claude_market=True, codex_market=True):
    if claude is not None:
        d = tmp_path / ".claude" / "plugins"
        d.mkdir(parents=True)
        (d / "installed_plugins.json").write_text(json.dumps({"version": 2, "plugins": {
            "argus@argus": [{"scope": "user", "version": claude}]} if claude else {}}))
        (d / "known_marketplaces.json").write_text(json.dumps({"argus": {}} if claude_market else {}))
    if codex is not None:
        d = tmp_path / ".codex"
        d.mkdir()
        conf = ('[marketplaces.argus]\nsource_type = "local"\n' if codex_market else "")
        if codex:
            conf += '[plugins."argus@argus"]\nenabled = true\n'
            (d / "plugins" / "cache" / "argus" / "argus" / codex).mkdir(parents=True)
        (d / "config.toml").write_text(conf)
    return tmp_path


def test_versions_are_read_from_the_agents_own_records(tmp_path):
    home = fake_home(tmp_path, claude="0.1.3", codex="")
    said = pluginstate.state(home, {"claude": True, "codex": True})
    offered = pluginstate.repo_version()
    assert said["version"] == offered
    claude, codex = said["agents"]
    assert claude["installed"] == "0.1.3" and claude["outdated"] == pluginstate.older("0.1.3", offered)
    assert codex["installed"] == "" and codex["outdated"] is False, "not installed is not outdated"
    assert pluginstate.older("0.1.9", "0.1.10") and not pluginstate.older("0.2.0", "0.1.10")


def test_install_uses_this_checkout_when_there_is_no_marketplace(tmp_path):
    home = fake_home(tmp_path, claude="", codex="", claude_market=False, codex_market=False)
    assert pluginstate.commands("claude", home, "install") == [
        ["claude", "plugin", "marketplace", "add", str(ROOT)], ["claude", "plugin", "install", "argus@argus"]]
    assert pluginstate.commands("codex", home, "install") == [
        ["codex", "plugin", "marketplace", "add", str(ROOT)], ["codex", "plugin", "add", "argus@argus"]]


def test_update_refreshes_the_marketplace_it_already_has(tmp_path):
    home = fake_home(tmp_path, claude="0.1.1", codex="0.1.1")
    assert pluginstate.commands("claude", home, "update") == [
        ["claude", "plugin", "marketplace", "update", "argus"], ["claude", "plugin", "update", "argus@argus"]]
    assert pluginstate.commands("codex", home, "update")[-1] == ["codex", "plugin", "add", "argus@argus"]


@pytest.fixture
def client(tmp_path, monkeypatch):
    from app.config import Config
    from app.main import create_app
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.tmux_socket = "argus-t-plugin-unused"
    app = create_app(cfg)
    home = fake_home(tmp_path / "h", claude="0.0.1", codex="")
    monkeypatch.setattr("app.main.Path.home", lambda: home)
    monkeypatch.setattr("app.launch.versions", lambda words: {"claude": "2.1", "codex": "0.160"})
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    return app, c


def test_the_routes_say_and_do(client, monkeypatch):
    app, c = client
    assert c.get("/api/plugin/version").json() == {"version": pluginstate.repo_version()}
    said = c.get("/api/plugin").json()
    assert [(a["agent"], a["installed"], a["outdated"]) for a in said["agents"]] == [("claude", "0.0.1", True), ("codex", "", False)]
    ran = []
    monkeypatch.setattr(pluginstate, "run", lambda agent, home, action: ran.append((agent, action)) or {"ok": True, "said": ["$ x"]})
    assert c.post("/api/plugin", json={"agent": "codex", "action": "install"}).status_code == 200 and ran == [("codex", "install")]
    assert c.post("/api/plugin", json={"agent": "gemini"}).status_code == 400
    monkeypatch.setattr(pluginstate, "run", lambda *a: {"ok": False, "said": ["$ claude plugin update\nnot found"]})
    assert "not found" in c.post("/api/plugin", json={"agent": "claude", "action": "update"}).json()["error"]


def test_reload_types_only_where_a_claude_sits_at_its_prompt(client, monkeypatch):
    """Last word 'done' and waiting: at its prompt. 'asking' may be a permission question, where
    an Enter would answer it; working is never typed into."""
    from app import bells
    app, c = client
    monkeypatch.setattr(app.state.agents, "states", lambda: {
        "idle": {"agent": "claude", "state": "waiting"}, "asks": {"agent": "claude", "state": "waiting"},
        "busy": {"agent": "claude", "state": "working"}, "cx": {"agent": "codex", "state": "waiting"}})
    req = type("R", (), {"app": app})()
    kept = bells.store(req)["list"]
    kept.append({"seq": 1, "session": "idle", "why": "done", "source": "hook"})
    kept.append({"seq": 2, "session": "asks", "why": "asking", "source": "hook"})
    typed = []
    monkeypatch.setattr("app.tmux.run", lambda argv: typed.append(argv[-3:]))
    said = c.post("/api/plugin/reload").json()
    assert said["reloaded"] == ["idle"] and said["not_now"] == ["asks", "busy"]
    assert typed == [["=idle:", "-l", "/reload-plugins"], ["-t", "=idle:", "Enter"]]
    assert c.get("/api/plugin").json()["reload"] == ["idle"]


def test_a_session_start_hears_of_a_newer_plugin_and_only_then(tmp_path):
    class Answer(BaseHTTPRequestHandler):
        offered = "9.9.9"

        def do_GET(self):
            body = json.dumps({"version": Answer.offered}).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), Answer)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "ARGUS_TOKEN": "t",
           "ARGUS_URL": f"http://127.0.0.1:{server.server_port}"}
    check = ROOT / "plugin" / "bin" / "argus-check"
    out = subprocess.run([str(check)], capture_output=True, text=True, env=env, timeout=15).stdout
    assert "9.9.9 is available" in json.loads(out)["systemMessage"]
    Answer.offered = pluginstate.repo_version()
    assert subprocess.run([str(check)], capture_output=True, text=True, env=env, timeout=15).stdout == "", "up to date: silent"
    server.shutdown()

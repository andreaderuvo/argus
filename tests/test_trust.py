"""Trusting a team's folder in the agent before starting it there, and the first prompt on the
agent's command line — so nothing is typed into a session asking "trust this folder?"."""

from __future__ import annotations

import json

from app import trust


def test_codex_gets_the_folder_as_trusted_once_and_keeps_its_own_answer(tmp_path):
    (tmp_path / ".codex").mkdir()
    conf = tmp_path / ".codex" / "config.toml"
    conf.write_text('model = "gpt"\n\n[projects."/somewhere"]\ntrust_level = "untrusted"\n')
    folder = tmp_path / "team"
    folder.mkdir()
    assert trust.trust(str(folder), "codex", tmp_path) is True
    import tomllib
    said = tomllib.loads(conf.read_text())
    assert said["projects"][str(folder.resolve())]["trust_level"] == "trusted"
    assert said["projects"]["/somewhere"]["trust_level"] == "untrusted", "an answer of yours is kept"
    assert trust.trust(str(folder), "codex", tmp_path) is False, "once"
    assert (tmp_path / ".codex" / "config.toml.before-argus").exists()


def test_claude_gets_the_folder_as_trusted_and_everything_else_is_kept(tmp_path):
    state = tmp_path / ".claude.json"
    state.write_text(json.dumps({"numStartups": 9, "projects": {"/a": {"hasTrustDialogAccepted": True, "x": 1}}}))
    assert trust.trust(str(tmp_path), "claude", tmp_path) is True
    doc = json.loads(state.read_text())
    assert doc["numStartups"] == 9 and doc["projects"]["/a"] == {"hasTrustDialogAccepted": True, "x": 1}
    assert doc["projects"][str(tmp_path.resolve())]["hasTrustDialogAccepted"] is True
    assert trust.trust(str(tmp_path), "claude", tmp_path) is False
    assert trust.trust(str(tmp_path), "something-else", tmp_path) is False


def test_the_first_prompt_rides_on_the_command_line():
    import shlex
    line = trust.with_first_prompt("claude --model opus", "claude", "fix it's crash;\nrm -rf /")
    assert shlex.split(line) == ["claude", "--model", "opus", "fix it's crash;\nrm -rf /"], "one argument, whatever it says"
    assert shlex.split(trust.with_first_prompt("codex", "codex", "go")) == ["codex", "go"]
    assert shlex.split(trust.with_first_prompt("gemini", "gemini", "go")) == ["gemini", "-i", "go"]
    assert trust.with_first_prompt("bash", "", "go") is None, "anything else is typed into, as before"


def test_stop_can_end_every_session_of_the_team(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app
    from app.teams import TEMPLATES, fill_graph
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    app = create_app(cfg)
    app.state.teams.home = tmp_path / "teams"
    monkeypatch.setattr(app.state.teams, "io", type("IO", (), {
        "send": lambda *a: None, "launch": lambda *a: None, "ring": lambda *a: None, "now": lambda self: 0.0,
        "state": lambda *a: None, "run_check": lambda *a, **k: None})())
    graph = fill_graph(TEMPLATES["fix"]["graph"], "t", {}, default_check="true")
    team = app.state.teams.create(name="t", goal="g", folder=str(tmp_path), graph=graph, template="fix", gate="ask", max_rounds=3)
    killed = []
    monkeypatch.setattr("app.tmux.session_exists", lambda sock, name: True)
    monkeypatch.setattr("app.tmux.run", lambda argv: killed.append(argv[-1]))
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    said = c.post(f"/api/teams/{team['id']}/stop", json={"kill": True}).json()
    assert said["team"]["status"] == "stopped" and sorted(said["ended"]) == ["t-check", "t-executor"]
    assert sorted(killed) == ["=t-check", "=t-executor"]

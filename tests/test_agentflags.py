"""Options for starting an agent, in words: offered only where its own --help has them, and turned
into flags here — a request names options, it never carries a command line."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import agentflags
from app.agentflags import agent_of, flags_for, options_for

CLAUDE_HELP = """
  --dangerously-skip-permissions        Bypass all permission checks.
  --permission-mode <mode>              (choices: "acceptEdits", "auto", "bypassPermissions", "plan")
  --model <model>                       an alias (e.g. 'fable', 'opus', or 'sonnet')
  --effort <level>                      (low, medium, high, xhigh, max)
  -c, --continue                        Continue the most recent conversation
"""
# Codex as installed here in 2026-10: --full-auto is gone, --approve-for-me has arrived.
CODEX_HELP = """
  -m, --model <MODEL>
  -s, --sandbox <SANDBOX_MODE>   [possible values: read-only, workspace-write, danger-full-access]
      --approve-for-me
      --dangerously-bypass-approvals-and-sandbox
  -a, --ask-for-approval <APPROVAL_POLICY>
      --search
"""


def test_which_agent_a_launcher_starts():
    assert agent_of("claude") == "claude"
    assert agent_of("conda activate review && codex --search") == "codex"
    assert agent_of("/opt/bin/gemini") == "gemini"
    assert agent_of("") is None and agent_of("vim") is None


def test_only_what_the_installed_version_has_is_offered():
    codex = {o["id"]: o for o in options_for("codex", CODEX_HELP)}
    perms = [c["value"] for c in codex["permissions"]["choices"]]
    assert "auto" not in perms, "--full-auto is not in this version's help"
    assert perms == ["ask", "workspace", "review", "yolo"]
    assert set(codex) == {"permissions", "model", "search"}
    assert options_for("claude", "") == [], "no help, no options: nothing is offered on a guess"


def test_the_flag_nobody_remembers_is_one_choice_in_words():
    claude = {o["id"]: o for o in options_for("claude", CLAUDE_HELP)}
    skip = next(c for c in claude["permissions"]["choices"] if c["value"] == "skip")
    assert skip["flags"] == ["--dangerously-skip-permissions"] and skip["danger"] is True
    assert flags_for("claude", CLAUDE_HELP, {"permissions": "skip", "model": "opus", "effort": "high",
                                             "continue": True}) == [
        "--dangerously-skip-permissions", "--model", "opus", "--effort", "high", "--continue"]
    assert flags_for("claude", CLAUDE_HELP, {"permissions": "ask", "model": "", "continue": False}) == []


@pytest.mark.parametrize("agent, help_text, chosen", [
    ("claude", CLAUDE_HELP, {"permissions": "everything"}),       # not a choice
    ("claude", CLAUDE_HELP, {"rm": True}),                        # not an option
    ("claude", CLAUDE_HELP, {"continue": "yes"}),                 # a toggle is on or off
    ("codex", CODEX_HELP, {"model": "opus; rm -rf ~"}),           # not a value
    ("codex", CODEX_HELP, {"permissions": "auto"}),               # not in this version
])
def test_nothing_off_the_table_gets_through(agent, help_text, chosen):
    with pytest.raises(ValueError):
        flags_for(agent, help_text, chosen)


def test_a_text_value_must_look_like_one():
    assert flags_for("codex", CODEX_HELP, {"model": "gpt-5.5-codex"}) == ["--model", "gpt-5.5-codex"]


# ------------------------------------------------------------------ through the launch endpoint

@pytest.fixture
def started(tmp_path, monkeypatch):
    from app import launch
    from app.config import Config
    from app.main import create_app

    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.launchers = [{"name": "Claude Code", "command": "claude"}]
    app = create_app(cfg)
    calls = []
    monkeypatch.setattr(launch, "start", lambda sock, name, where, command: calls.append(command))
    monkeypatch.setattr(launch, "versions", lambda words: {w: "1.0" for w in words})
    monkeypatch.setattr(agentflags, "help_of", lambda program, version="": CLAUDE_HELP)
    monkeypatch.setattr("app.tmux.session_exists", lambda sock, name: False)
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    return c, calls


def test_options_become_the_command_line_on_the_server(started):
    c, calls = started
    r = c.post("/api/tmux/launch", json={"launcher": "Claude Code", "name": "api",
                                         "options": {"permissions": "skip", "model": "opus"}})
    assert r.status_code == 200, r.text
    assert calls == ["claude '--dangerously-skip-permissions' '--model' 'opus'"]
    assert r.json()["command"] == calls[0]


def test_an_option_off_the_table_starts_nothing(started):
    c, calls = started
    r = c.post("/api/tmux/launch", json={"launcher": "Claude Code", "name": "api",
                                         "options": {"model": "x && curl evil"}})
    assert r.status_code == 400 and calls == []

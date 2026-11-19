"""Whether Claude Code, Codex or Gemini is out of date, and the update that matches how it was installed
("it does not tell me they are old — and a button that updates them", 2026-11-19)."""

from __future__ import annotations

import subprocess

import pytest

from app import agentupdate as au


def test_the_version_is_read_from_what_each_says():
    assert au.version_of("2.1.235 (Claude Code)") == "2.1.235"
    assert au.version_of("codex-cli 0.147.0") == "0.147.0"
    assert au.version_of("0.12.0") == "0.12.0"
    assert au.version_of("") is None


def test_newer_compares_numbers_and_never_offers_a_pre_release():
    assert au.newer("2.1.9", "2.1.10")
    assert au.newer("0.147.0", "0.160.1")
    assert not au.newer("2.1.10", "2.1.9")
    assert not au.newer("1.0.0", "1.0.0")
    assert not au.newer("1.0.0", "1.0.1-beta.2")
    assert not au.newer(None, "1.0.0") and not au.newer("1.0.0", None)


@pytest.mark.parametrize("agent,path,kind", [
    ("claude", "/home/me/.local/share/claude/versions/2.1.0", "claude"),
    ("codex", "/home/me/.nvm/versions/node/v22/lib/node_modules/@openai/codex/bin/codex.js", "npm"),
    ("gemini", "/opt/homebrew/Cellar/gemini-cli/0.6.0/bin/gemini", "brew"),
    ("codex", "/usr/local/bin/codex", ""),
])
def test_the_update_matches_how_it_was_installed(agent, path, kind):
    got, command = au.how(agent, path)
    assert got == kind
    assert bool(command) == bool(kind)


def test_the_state_says_which_are_out_of_date(monkeypatch):
    monkeypatch.setenv("ARGUS_AGENT_LATEST", '{"claude": "2.2.0", "codex": "0.160.0"}')
    monkeypatch.setattr(au.launch, "probe", lambda words: {"claude": True, "codex": True, "gemini": False})
    monkeypatch.setattr(au.launch, "versions", lambda words: {"claude": "2.1.9 (Claude Code)", "codex": "codex-cli 0.160.0"})
    monkeypatch.setattr(au, "where", lambda agent: "/x/node_modules/@openai/codex/bin/codex.js" if agent == "codex" else "/x/claude")
    rows = {r["agent"]: r for r in au.state()}
    assert set(rows) == {"claude", "codex"}, "only the ones installed"
    assert rows["claude"]["outdated"] and rows["claude"]["command"] == "claude update"
    assert not rows["codex"]["outdated"] and rows["codex"]["how"] == "npm"


def test_an_update_runs_its_command_and_reads_the_version_again(monkeypatch):
    ran = []
    monkeypatch.setattr(au, "where", lambda agent: "/x/node_modules/@google/gemini-cli/dist/index.js")
    monkeypatch.setattr(au.launch, "login_shell", lambda: "/bin/sh")
    monkeypatch.setattr(au.launch, "versions", lambda words: {"gemini": "0.69.0"})

    def run(argv, **kw):
        ran.append(argv[-1])
        return subprocess.CompletedProcess(argv, 0, stdout="added 1 package\n", stderr="")
    monkeypatch.setattr(au.subprocess, "run", run)
    said = au.update("gemini")
    assert said["ok"] and said["installed"] == "0.69.0"
    assert ran == ["npm install -g @google/gemini-cli@latest </dev/null 2>&1"]
    with pytest.raises(ValueError):
        au.update("nano")

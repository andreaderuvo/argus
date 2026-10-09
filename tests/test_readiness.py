"""Is the machine ready for a team — said before Start (app/readiness.py)."""

from __future__ import annotations

from app import readiness


def test_codex_asking_before_the_team_tools_is_said_and_fixed(tmp_path, monkeypatch):
    home = tmp_path
    (home / ".codex").mkdir()
    (home / ".codex/config.toml").write_text('model = "x"\n\n[plugins."argus@argus".mcp_servers.argus.tools.team_task]\napproval_mode = "prompt"\n')
    monkeypatch.setattr(readiness.pluginstate, "state", lambda h, p: {"agents": [
        {"agent": "codex", "installed": "0.1.12", "outdated": False}, {"agent": "claude", "installed": "", "outdated": False}]})
    said = readiness.check(home, [{"name": "Codex", "agent": "codex"}, {"name": "Claude Code", "agent": "claude"},
                                  {"name": "A shell"}], codex_heard=False)
    codex, claude, shell = (r["notes"] for r in said)
    asks = next(n for n in codex if n.get("fix") == "codex-team-tools")
    assert "team_task, team_done" in asks["text"]
    # Said twice: as words for an older page, and as a sentence + values the page translates.
    assert asks["say"].startswith("Codex asks before {tools}") and asks["values"] == {"tools": "team_task, team_done"}
    assert asks["say"].format(**asks["values"]) == asks["text"]
    assert any("hooks have not been heard" in n["text"] for n in codex)
    assert any(n.get("fix") == "plugin:claude" for n in claude)
    assert "not an agent" in shell[0]["text"]
    assert readiness.allow_codex_team_tools(home) == ["team_task", "team_done"]
    assert readiness.codex_tool_modes(home) == {"team_task": "approve", "team_done": "approve"}
    text = (home / ".codex/config.toml").read_text()
    assert 'model = "x"' in text and text.count("team_task]") == 1, "the rest kept, the section edited in place"
    assert list(home.glob(".codex/config.toml.argus-*")), "a copy of how it was"
    assert readiness.allow_codex_team_tools(home) == [], "nothing to do twice"
    said = readiness.check(home, [{"name": "Codex", "agent": "codex"}], codex_heard=True)
    assert said[0]["notes"] == []

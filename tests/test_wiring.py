"""Setting the agents up to ring, and taking it back out.

These write into files that belong to the user, so what matters is not only that the
hooks appear: it is that nothing of theirs is lost, that doing it twice is inert, and
that an event they have already claimed is left exactly as it was.
"""

import json
import tomllib
from pathlib import Path

import pytest

from app import wiring

MINE = "il-mio-script.sh"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude/settings.json").write_text(json.dumps({
        "permissions": {"allow": ["Bash(*)"], "deny": ["Bash(rm -rf /)"]},
        "model": "opus",
        "hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": MINE}]}]},
    }, indent=2))
    (tmp_path / ".codex").mkdir()
    (tmp_path / ".codex/config.toml").write_text(
        'model = "gpt"\npersonality = "pragmatic"\n\n[projects."/work"]\ntrust_level = "trusted"\n'
    )
    (tmp_path / ".gemini").mkdir()
    (tmp_path / ".gemini/settings.json").write_text(json.dumps({
        "general": {"vimMode": True},
        "hooks": {"PreToolUse": [{"matcher": "run_shell_command", "hooks": [{"type": "command", "command": MINE}]}]},
    }, indent=2))
    return tmp_path


def settings(home: Path) -> dict:
    return json.loads((home / wiring.CLAUDE_SETTINGS).read_text())


def gemini_settings(home: Path) -> dict:
    return json.loads((home / wiring.GEMINI_SETTINGS).read_text())


def codex(home: Path) -> dict:
    return tomllib.loads((home / wiring.CODEX_CONFIG).read_text())


def test_wiring_adds_the_hooks_and_keeps_everything_else(home):
    wiring.wire(home, True)

    hooks = settings(home)["hooks"]
    assert wiring.MARK in hooks["Stop"][0]["hooks"][0]["command"]
    assert wiring.MARK in hooks["Notification"][0]["hooks"][0]["command"]
    # Theirs, untouched.
    assert hooks["PreToolUse"][0]["hooks"][0]["command"] == MINE
    assert settings(home)["permissions"]["deny"] == ["Bash(rm -rf /)"]
    assert settings(home)["model"] == "opus"

    assert wiring.MARK in codex(home)["notify"][0]
    assert list(codex(home)["projects"]) == ["/work"]
    assert codex(home)["model"] == "gpt"


def test_notify_goes_before_the_first_table(home):
    """A bare key written after a `[table]` header belongs to that table, and codex would
    never see it — the file would look configured and do nothing."""
    wiring.wire(home, True)
    lines = (home / wiring.CODEX_CONFIG).read_text().splitlines()
    assert lines.index(next(l for l in lines if l.startswith("notify"))) < \
        lines.index(next(l for l in lines if l.startswith("[")))


def test_doing_it_twice_changes_nothing(home):
    wiring.wire(home, True)
    before = (home / wiring.CLAUDE_SETTINGS).read_text(), (home / wiring.CODEX_CONFIG).read_text()
    assert wiring.wire(home, True)["changed"] == []
    assert ((home / wiring.CLAUDE_SETTINGS).read_text(), (home / wiring.CODEX_CONFIG).read_text()) == before


def test_removing_takes_back_only_what_we_wrote(home):
    wiring.wire(home, True)
    wiring.wire(home, False)

    hooks = settings(home)["hooks"]
    assert list(hooks) == ["PreToolUse"], "their own hook has to survive"
    assert "notify" not in codex(home)
    assert list(codex(home)["projects"]) == ["/work"]
    assert not wiring.script_home(home).exists()
    assert all(not a["on"] for a in wiring.state(home)["agents"])


def test_an_event_they_already_use_is_left_alone(home):
    data = settings(home)
    data["hooks"]["Stop"] = [{"hooks": [{"type": "command", "command": MINE}]}]
    (home / wiring.CLAUDE_SETTINGS).write_text(json.dumps(data))

    said = wiring.wire(home, True)["changed"]
    assert any("left Stop alone" in s for s in said)
    assert settings(home)["hooks"]["Stop"][0]["hooks"][0]["command"] == MINE
    # The other one still gets wired: one clash does not abandon the job.
    assert wiring.MARK in settings(home)["hooks"]["Notification"][0]["hooks"][0]["command"]


def test_their_notify_is_left_alone_too(home):
    (home / wiring.CODEX_CONFIG).write_text('notify = ["mio.sh"]\n\n[projects."/work"]\n')
    said = wiring.wire(home, True)["changed"]
    assert any("left notify alone" in s for s in said)
    assert codex(home)["notify"] == ["mio.sh"]


def test_a_copy_is_kept_of_the_file_as_it_was(home):
    original = (home / wiring.CLAUDE_SETTINGS).read_text()
    wiring.wire(home, True)
    wiring.wire(home, False)
    wiring.wire(home, True)
    spare = home / (wiring.CLAUDE_SETTINGS + ".before-argus")
    assert spare.read_text() == original, "the copy is of the file before Argus, not before the last write"


def test_an_agent_that_is_not_installed_is_not_offered(tmp_path):
    assert wiring.state(tmp_path)["agents"] == []
    assert wiring.wire(tmp_path, True)["changed"][0].startswith("wrote ")


def test_unreadable_settings_are_refused_rather_than_replaced(home):
    (home / wiring.CLAUDE_SETTINGS).write_text("{ this is not json")
    with pytest.raises(ValueError):
        wiring.wire(home, True)
    assert (home / wiring.CLAUDE_SETTINGS).read_text() == "{ this is not json"


def test_where_is_offered_only_where_it_can_work(tmp_path):
    """Claude Code has a status line hook and can say which folder it considers current.
    Codex has no equivalent, and is listed as unable rather than offered a switch that does
    nothing."""
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".codex").mkdir()
    said = wiring.where_state(tmp_path)
    assert [(a["name"], a["on"], a.get("cannot", False)) for a in said["agents"]] == [
        ("claude", False, False), ("codex", False, True),
    ]


def test_wiring_where_is_additive_and_reversible(tmp_path):
    """It writes the status line hook, keeps the file as it was, and takes back only its
    own on the way out."""
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"model": "opus"}) + "\n")

    on = wiring.wire_where(tmp_path, True)
    assert any("status line" in line for line in on["changed"])
    after = json.loads(settings.read_text())
    assert after["model"] == "opus"                       # nothing of theirs disturbed
    assert wiring.WHERE_MARK in after["statusLine"]["command"]
    assert (tmp_path / ".claude" / "settings.json.before-argus").exists()
    assert on["state"]["agents"][0]["on"] is True

    off = wiring.wire_where(tmp_path, False)
    assert any("back out" in line for line in off["changed"])
    assert "statusLine" not in json.loads(settings.read_text())


def test_a_status_line_you_wrote_is_left_alone(tmp_path):
    """Reported, never replaced — the file belongs to the person, not to us."""
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir()
    settings.write_text(json.dumps({"statusLine": {"type": "command", "command": "~/mine.sh"}}) + "\n")

    answer = wiring.wire_where(tmp_path, True)
    assert any("left the status line alone" in line for line in answer["changed"])
    assert json.loads(settings.read_text())["statusLine"]["command"] == "~/mine.sh"
    assert answer["state"]["agents"][0]["taken"] is True


def test_gemini_gets_the_same_two_hooks_under_its_own_names(home):
    wiring.wire(home, True)

    hooks = gemini_settings(home)["hooks"]
    assert wiring.MARK in hooks["AfterAgent"][0]["hooks"][0]["command"]
    assert wiring.MARK in hooks["Notification"][0]["hooks"][0]["command"]
    # Theirs, untouched — same guarantee as Claude Code's own PreToolUse.
    assert hooks["PreToolUse"][0]["hooks"][0]["command"] == MINE
    assert gemini_settings(home)["general"] == {"vimMode": True}


def test_gemini_removal_and_idempotency_match_claudes(home):
    wiring.wire(home, True)
    before = json.dumps(gemini_settings(home), sort_keys=True)
    wiring.wire(home, True)                              # doing it twice changes nothing
    assert json.dumps(gemini_settings(home), sort_keys=True) == before

    wiring.wire(home, False)
    hooks = gemini_settings(home)["hooks"]
    assert "AfterAgent" not in hooks and "Notification" not in hooks
    assert hooks["PreToolUse"][0]["hooks"][0]["command"] == MINE


def test_gemini_event_already_in_use_is_left_alone(home):
    data = gemini_settings(home)
    data["hooks"]["AfterAgent"] = [{"hooks": [{"type": "command", "command": MINE}]}]
    (home / wiring.GEMINI_SETTINGS).write_text(json.dumps(data))

    said = wiring.wire(home, True)["changed"]
    assert any("left AfterAgent alone" in s for s in said)
    assert gemini_settings(home)["hooks"]["AfterAgent"][0]["hooks"][0]["command"] == MINE
    # The other one still gets wired: one clash does not abandon the job.
    assert wiring.MARK in gemini_settings(home)["hooks"]["Notification"][0]["hooks"][0]["command"]


def test_gemini_is_reported_alongside_the_others(home):
    said = wiring.state(home)
    names = {a["name"] for a in said["agents"]}
    assert names == {"Claude Code", "Codex", "Gemini CLI"}


def test_gemini_unreadable_settings_are_refused_rather_than_replaced(home):
    (home / wiring.GEMINI_SETTINGS).write_text("{ not json at all")
    with pytest.raises(ValueError):
        wiring.wire(home, True)
    assert (home / wiring.GEMINI_SETTINGS).read_text() == "{ not json at all"


def test_gemini_not_installed_means_not_offered(tmp_path):
    (tmp_path / ".claude").mkdir()
    (tmp_path / ".claude/settings.json").write_text("{}")
    names = {a["name"] for a in wiring.state(tmp_path)["agents"]}
    assert "Gemini CLI" not in names

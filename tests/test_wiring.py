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
    return tmp_path


def settings(home: Path) -> dict:
    return json.loads((home / wiring.CLAUDE_SETTINGS).read_text())


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

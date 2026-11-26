"""Settings → Backup: a copy of what it takes to bring the agents back elsewhere (app/backup.py)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from app import backup, resume

CLAUDE_ID = "11111111-2222-3333-4444-555555555555"
CODEX_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
SECRET = "0123456789abcdef0123456789abcdef"


def _home(tmp: Path) -> Path:
    home = tmp / "home"
    proj = home / ".claude" / "projects" / "-work-paper"
    proj.mkdir(parents=True)
    (proj / f"{CLAUDE_ID}.jsonl").write_text('{"a": 1}\n')
    (proj / CLAUDE_ID / "subagents").mkdir(parents=True)
    (proj / CLAUDE_ID / "subagents" / "one.jsonl").write_text("sub\n")
    (proj / "99999999-0000-0000-0000-000000000000.jsonl").write_text("someone else's\n")
    day = home / ".codex" / "sessions" / "2026" / "11" / "26"
    day.mkdir(parents=True)
    (day / f"rollout-2026-11-26T09-00-00-{CODEX_ID}.jsonl").write_text("codex\n")
    return home


def _config(tmp: Path) -> Path:
    cfg = tmp / "cfg"
    (cfg / "notes").mkdir(parents=True)
    (cfg / "config.yaml").write_text("token: secret\n")
    (cfg / "devices.json").write_text("{}")
    (cfg / "prefs.json").write_text('{"prefs": {"workspaces": [{"id": 1}], '
                                    '"geom": {"37:web:/proxy/1455/cb?code=x&token=' + SECRET + '": {}}}}')
    (cfg / "todo.json").write_text("[]")
    (cfg / "notes" / "idea.md").write_text(f"# idea\nopen http://host/?token={SECRET}\n")
    return cfg


LEDGER = {"sessions": {
    "claude-paper": {"agent": "claude", "cwd": "/work/paper", "flags": [], "conversation": CLAUDE_ID},
    "codex-paper": {"agent": "codex", "cwd": "/work/paper", "flags": [], "conversation": CODEX_ID},
}, "lost": {"old-one": {"agent": "claude", "cwd": "/work", "flags": [], "conversation": None, "lost_at": 1}}}


def test_a_copy_holds_the_conversations_the_desks_and_no_secret(tmp_path):
    home, cfg = _home(tmp_path), _config(tmp_path)
    place = tmp_path / "copy"
    report = backup.run([str(place)], home, LEDGER, cfg, cfg / "notes", [SECRET])
    assert report["places"][0]["ok"], report
    for f in place.rglob("*"):
        if f.is_file():
            assert SECRET not in f.read_text(errors="replace"), f"the key reached {f}"
    assert "<removed>" in (place / "argus" / "prefs.json").read_text()
    assert report["sessions"] == 3 and report["conversations"] == 3
    files = {str(p.relative_to(place)) for p in place.rglob("*") if p.is_file()}
    assert f"home/.claude/projects/-work-paper/{CLAUDE_ID}.jsonl" in files
    assert f"home/.claude/projects/-work-paper/{CLAUDE_ID}/subagents/one.jsonl" in files
    assert f"home/.codex/sessions/2026/11/26/rollout-2026-11-26T09-00-00-{CODEX_ID}.jsonl" in files
    assert {"argus/prefs.json", "argus/todo.json", "argus/notes/idea.md", "manifest.json", "README.txt"} <= files
    assert not any("99999999" in f for f in files), "only the conversations of the sessions kept"
    assert not any(f.endswith(("config.yaml", "devices.json")) for f in files), "never a secret"
    manifest = json.loads((place / "manifest.json").read_text())
    assert set(manifest["sessions"]) == {"claude-paper", "codex-paper", "old-one"}


def test_a_growing_conversation_is_carried_on_and_a_rewritten_one_copied_again(tmp_path):
    src, dst = tmp_path / "a.jsonl", tmp_path / "b" / "a.jsonl"
    src.write_text("line 1\n")
    assert backup.copy_one(src, dst) == 7
    assert backup.copy_one(src, dst) == 0
    with open(src, "a") as f:
        f.write("line 2\n")
    assert backup.copy_one(src, dst) == 7, "only the new part"
    assert dst.read_text() == "line 1\nline 2\n"
    src.write_text("other 1\nother 2\nmore\n")
    backup.copy_one(src, dst)
    assert dst.read_text() == src.read_text()


def test_bringing_back_puts_conversations_where_missing_and_offers_the_sessions(tmp_path):
    home, cfg = _home(tmp_path), _config(tmp_path)
    place = tmp_path / "copy"
    backup.run([str(place)], home, LEDGER, cfg, cfg / "notes")

    new_home, new_cfg = tmp_path / "new" / "home", tmp_path / "new" / "cfg"
    new_home.mkdir(parents=True)
    (new_cfg / "notes").mkdir(parents=True)
    longer = new_home / ".codex" / "sessions" / "2026" / "11" / "26" / f"rollout-2026-11-26T09-00-00-{CODEX_ID}.jsonl"
    longer.parent.mkdir(parents=True)
    longer.write_text("codex\nand more since\n")
    ledger = resume.Ledger(new_cfg / "agents-seen.json")
    done = backup.restore(str(place), new_home, ledger, {"codex-paper"}, new_cfg, new_cfg / "notes")

    assert (new_home / ".claude" / "projects" / "-work-paper" / f"{CLAUDE_ID}.jsonl").read_text() == '{"a": 1}\n'
    assert (new_home / ".claude" / "projects" / "-work-paper" / CLAUDE_ID / "subagents" / "one.jsonl").exists()
    assert longer.read_text() == "codex\nand more since\n", "never over a longer conversation"
    assert (new_cfg / "prefs.json").exists() and (new_cfg / "notes" / "idea.md").exists()
    assert not (new_cfg / "config.yaml").exists()
    assert done["offered"] == ["claude-paper", "old-one"], "a session running already is not offered"
    lost = {one["name"]: one for one in ledger.lost()}
    assert lost["claude-paper"]["how"] == "resume" and lost["claude-paper"]["conversation"] == CLAUDE_ID
    assert lost["old-one"]["how"] == "fresh"


def test_a_folder_is_checked_in_words(tmp_path):
    assert backup.check_place(str(tmp_path / "new" / "deeper")) == str(tmp_path / "new" / "deeper")
    with pytest.raises(ValueError, match="whole path"):
        backup.check_place("relative/place")
    (tmp_path / "file").write_text("x")
    with pytest.raises(ValueError, match="a file"):
        backup.check_place(str(tmp_path / "file" / "inside"))
    with pytest.raises(ValueError, match="no Argus backup"):
        backup.look(str(tmp_path))


def test_a_place_that_fails_says_why_and_the_others_still_get_their_copy(tmp_path):
    home, cfg = _home(tmp_path), _config(tmp_path)
    (tmp_path / "blocked").write_text("a file where a folder should be")
    report = backup.run([str(tmp_path / "blocked"), str(tmp_path / "fine")], home, LEDGER, cfg, cfg / "notes")
    bad, good = report["places"]
    assert not bad["ok"] and bad["error"]
    assert good["ok"] and (tmp_path / "fine" / "manifest.json").exists()

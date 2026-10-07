"""What resetting a team means, declared in its file and carried out exactly (app/teams.py)."""

from __future__ import annotations

import pytest

from app import teams


def test_reset_is_read_and_checked():
    assert teams.read_reset({"files": "a.csv"}) == {"files": ["a.csv"], "log": "archive"}
    assert teams.read_reset({"files": ["x"], "run": "make clean", "log": "keep"})["run"] == "make clean"
    for bad, words in [({"files": ["/etc/passwd"]}, "inside the team's folder"), ({"files": ["../up"]}, "inside"),
                       ({"log": "burn"}, "reset.log"), ({"wipe": True}, "is not read"), ("x", "files, run and log")]:
        with pytest.raises(ValueError, match=words):
            teams.read_reset(bad)


def test_a_team_file_carries_its_reset_there_and_back():
    said = teams.from_yaml("name: T\nsteps:\n  a: {role: executor}\nflow:\n  - a -> a if REDO\n"
                           "reset:\n  files: [ledger.csv, 'state/*.json']\n  log: clear\n")
    assert said["graph"]["reset"] == {"files": ["ledger.csv", "state/*.json"], "log": "clear"}
    again = teams.from_yaml(teams.to_yaml(said["graph"], "T"))
    assert again["graph"]["reset"] == said["graph"]["reset"]


def test_the_plan_is_exact_and_stays_in_the_folder(tmp_path):
    root = tmp_path / "team"
    (root / "state").mkdir(parents=True)
    (root / ".git").mkdir()
    for f in ("ledger.csv", "state/a.json", "state/b.json", "state/keep.txt", ".git/x.json", "team.yaml", "TEAM.argus.md"):
        (root / f).write_text("x")
    outside = tmp_path / "secret.csv"
    outside.write_text("x")
    (root / "link.csv").symlink_to(outside)
    plan = teams.reset_plan(str(root), {"files": ["*.csv", "state/*.json", "**/*.json", "team.yaml", "TEAM.argus.md"], "log": "archive"})
    assert plan["files"] == ["ledger.csv", "state/a.json", "state/b.json"], "no .git, no team.yaml, no log, nothing outside"
    said = teams.do_reset(str(root), {"files": ["*.csv", "state/*.json"], "run": "touch ran", "log": "archive"}, 0)
    assert said["deleted"] == ["ledger.csv", "state/a.json", "state/b.json"]
    assert outside.exists() and (root / "state/keep.txt").exists() and (root / "team.yaml").exists()
    assert not (root / "TEAM.argus.md").exists() and list(root.glob("TEAM.argus.*.md")), "the log archived with a date"
    assert said["ran"]["code"] == 0 and (root / "ran").exists()


def test_nothing_declared_deletes_nothing(tmp_path):
    (tmp_path / "ledger.csv").write_text("x")
    (tmp_path / "TEAM.argus.md").write_text("log")
    said = teams.do_reset(str(tmp_path), None, 0)
    assert said["deleted"] == [] and (tmp_path / "ledger.csv").exists() and said["log"].startswith("archived")

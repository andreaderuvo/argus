"""How long a dropped file is kept, and who may say so.

The drop folder never emptied, on purpose: deciding which of somebody's files have expired
is not a thing to do quietly, and a path handed to an agent yesterday has to still resolve
today. This is the other half of that decision — a number you set, from the command line or
from Settings, after which the folder is swept.

Everything here is about the edges of a feature that *deletes*: what it touches, what it
refuses to touch, and whether it can be turned on by anything that should not be able to.
"""

import errno
import os
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Config, ConfigError
from app.fsops import sweep_drops
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def drops(tmp_path):
    folder = tmp_path / "root" / "argus-drops"
    folder.mkdir(parents=True)
    return folder


def aged(path: Path, days: float) -> Path:
    path.write_text("x")
    when = time.time() - days * 86400
    os.utime(path, (when, when))
    return path


def client_for(tmp_path, **over):
    (tmp_path / "root").mkdir(exist_ok=True)
    settings = {"token": TOKEN, "roots": [tmp_path / "root"], "allow_write": True}
    settings.update(over)
    app = create_app(Config(**settings))
    app.state.config_path = tmp_path / "config.yaml"
    return TestClient(app)


def test_it_takes_the_old_and_leaves_the_rest(drops):
    aged(drops / "ancient.txt", 40)
    aged(drops / "yesterday.txt", 1)
    gone = sweep_drops(drops, 30)
    assert [Path(g).name for g in gone] == ["ancient.txt"]
    assert (drops / "yesterday.txt").exists()


def test_zero_days_is_for_ever(drops):
    aged(drops / "ancient.txt", 900)
    assert sweep_drops(drops, 0) == []
    assert (drops / "ancient.txt").exists()


def test_it_does_not_walk_into_folders(drops):
    """A directory in there was put there by hand — nothing this app writes is one — and a
    tidy-up that recurses is a recursive delete, which is not what a number of days means."""
    old = drops / "a-folder"
    old.mkdir()
    aged(old / "inside.txt", 900)
    when = time.time() - 900 * 86400
    os.utime(old, (when, when))

    assert sweep_drops(drops, 30) == []
    assert (old / "inside.txt").exists()


def test_a_symlink_is_left_alone(drops):
    """Following one would delete something that is not in this folder at all."""
    elsewhere = drops.parent / "kept.txt"
    aged(elsewhere, 900)
    link = drops / "link.txt"
    link.symlink_to(elsewhere)
    os.utime(link, (time.time() - 900 * 86400,) * 2, follow_symlinks=False)

    assert sweep_drops(drops, 30) == []
    assert elsewhere.exists(), "the target of a link in the drop folder is not ours to delete"


def test_one_file_that_will_not_go_does_not_stop_the_sweep(drops, monkeypatch):
    aged(drops / "a.txt", 90)
    aged(drops / "b.txt", 90)
    real = Path.unlink

    def stubborn(self, *a, **k):
        if self.name == "a.txt":
            raise PermissionError(errno.EACCES, "Permission denied", str(self))
        return real(self, *a, **k)

    monkeypatch.setattr(Path, "unlink", stubborn)
    assert [Path(g).name for g in sweep_drops(drops, 30)] == ["b.txt"]


def test_setting_it_writes_the_config_and_sweeps_at_once(tmp_path, drops):
    """Not at the next daily sweep: somebody who just typed 7 wants to know what that means
    for the folder in front of them."""
    aged(drops / "ancient.txt", 40)
    client = client_for(tmp_path)

    r = client.post("/api/drops/keep", json={"days": 30},
                    headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200, r.text
    assert r.json() == {"ok": True, "days": 30, "removed": 1}
    assert not (drops / "ancient.txt").exists()
    assert "drop_keep_days: 30" in (tmp_path / "config.yaml").read_text()


def test_writing_one_key_keeps_the_comments(tmp_path):
    """The config is a document people edit and annotate. Re-dumping it to change a number
    erases every comment they wrote, silently, which is a rude way to save a setting."""
    written = tmp_path / "config.yaml"
    written.write_text(
        "# my machine, my rules\n"
        "listen: 0.0.0.0:8090\n"
        "drop_keep_days: 5\n"
        "# the roots matter\n"
        "roots:\n"
        "- /home/me\n"
    )
    cfg = Config(token=TOKEN, roots=[tmp_path])
    cfg.set_in_file(written, "drop_keep_days", 90)

    after = written.read_text()
    assert "# my machine, my rules" in after
    assert "# the roots matter" in after
    assert "drop_keep_days: 90" in after
    assert "drop_keep_days: 5" not in after
    assert cfg.drop_keep_days == 90


def test_a_key_that_is_not_there_yet_is_appended(tmp_path):
    written = tmp_path / "config.yaml"
    written.write_text("listen: 0.0.0.0:8090\n\n")
    Config(token=TOKEN, roots=[tmp_path]).set_in_file(written, "drop_keep_days", 7)
    assert written.read_text() == "listen: 0.0.0.0:8090\ndrop_keep_days: 7\n"


def test_a_read_only_server_will_not_be_told_to_delete_things(tmp_path):
    r = client_for(tmp_path, allow_write=False).post(
        "/api/drops/keep", json={"days": 30}, headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 403


def test_nonsense_is_refused(tmp_path):
    client = client_for(tmp_path)
    for asked in ({"days": -1}, {"days": 4000}, {"days": "soon"}, {}):
        r = client.post("/api/drops/keep", json=asked,
                        headers={"Authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 400, f"{asked} was accepted"


def test_a_sweep_with_nowhere_to_sweep_is_refused_at_startup():
    cfg = Config(token=TOKEN, roots=[Path("/tmp")], drop_dir=None, drop_keep_days=30)
    with pytest.raises(ConfigError, match="no folder to sweep"):
        cfg.validate()


def test_the_browser_is_told_the_current_answer(tmp_path):
    client = client_for(tmp_path, drop_keep_days=14)
    said = client.get("/api/config", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert said["drop_keep_days"] == 14

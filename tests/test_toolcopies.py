"""Copies of Argus's commands that a pull left behind (app/toolcopies.py).

A link into the checkout, the installer's launcher and a copy identical to today's file are fine;
any other `argus-say` & co. on the PATH is reported with the line that links it, and "Link them"
replaces exactly those, keeping the old file beside it.
"""

from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

from app import toolcopies
from app.config import Config
from app.main import create_app


def bin_with(tmp_path: Path) -> Path:
    b = tmp_path / "bin"
    b.mkdir()
    (b / "argus-say").write_text("#!/bin/sh\necho an old argus-say\n")                       # a stale copy
    (b / "argus-mcp").symlink_to(toolcopies.TOOLS / "argus-mcp")                            # a link: fine
    (b / "argus-bell").write_bytes((toolcopies.TOOLS / "argus-bell").read_bytes())         # today's copy: fine
    (b / "argus_client.py").write_text("#!/bin/sh\n# Written by install.sh.\nexec python x\n")  # the launcher
    return b


def test_only_the_old_copies_are_reported_with_their_fix(tmp_path):
    b = bin_with(tmp_path)
    plugin = tmp_path / ".claude" / "plugins" / "cache" / "argus" / "bin"
    plugin.mkdir(parents=True)
    (plugin / "argus-say").write_text("old, but the plugin's own")
    said = toolcopies.stale_copies(f"{b}:{plugin}", home=tmp_path)
    assert [o["name"] for o in said] == ["argus-say"]
    assert said[0]["path"] == str(b / "argus-say") and said[0]["fix"] == f"ln -sf {toolcopies.TOOLS / 'argus-say'} {b / 'argus-say'}"
    assert said[0]["why"] == "a copy older than this Argus"


def test_a_link_to_another_checkout_is_old_too(tmp_path):
    other = tmp_path / "old-argus" / "tools"
    other.mkdir(parents=True)
    (other / "argus-say").write_text("from last month")
    b = tmp_path / "bin"
    b.mkdir()
    (b / "argus-say").symlink_to(other / "argus-say")
    (said,) = toolcopies.stale_copies(str(b), home=tmp_path)
    assert said["why"] == "a link to another copy of Argus"


def test_linking_replaces_them_and_keeps_the_old_file(tmp_path):
    b = bin_with(tmp_path)
    found = toolcopies.stale_copies(str(b), home=tmp_path)
    assert toolcopies.link(found) == [str(b / "argus-say")]
    assert (b / "argus-say").resolve() == (toolcopies.TOOLS / "argus-say").resolve()
    kept = list(b.glob("argus-say.argus-old-*"))
    assert len(kept) == 1 and "an old argus-say" in kept[0].read_text()
    assert toolcopies.stale_copies(str(b), home=tmp_path) == [], "nothing old any more"
    # Only what was reported, by its exact name: a forged entry is ignored.
    assert toolcopies.link([{"name": "rm", "path": str(b / "rm")}]) == []


def test_version_says_which_and_link_does_it(tmp_path, monkeypatch):
    b = bin_with(tmp_path)
    original = toolcopies.stale_copies
    monkeypatch.setattr(toolcopies, "stale_copies", lambda *a, **k: original(str(b), home=tmp_path))
    h = {"Authorization": "Bearer " + "m" * 64}
    ro = create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0"))
    with TestClient(ro) as c:
        said = c.get("/api/version", headers=h).json()
        assert [o["name"] for o in said["old_tools"]] == ["argus-say"]
        assert c.post("/api/tools/link", json={}, headers=h).status_code == 403, "read-only: it writes nothing"
    rw = create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0", allow_write=True))
    with TestClient(rw) as c:
        assert c.post("/api/tools/link", json={}, headers=h).json() == {"linked": [str(b / "argus-say")]}
        assert c.get("/api/version", headers=h).json()["old_tools"] == []


def test_stat_of_a_file_gone_answers_missing_when_asked(tmp_path):
    """A window watching a file that was deleted (a team's log after a Reset) polled /api/stat
    and got a 404 every few seconds; with missing_ok it is told, quietly."""
    app = create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0"))
    h = {"Authorization": "Bearer " + "m" * 64}
    with TestClient(app) as c:
        gone = tmp_path / "TEAM.argus.md"
        assert c.get("/api/stat", params={"path": str(gone)}, headers=h).status_code == 404
        assert c.get("/api/stat", params={"path": str(gone), "missing_ok": 1}, headers=h).json() == {"missing": True}
        gone.write_text("back")
        assert c.get("/api/stat", params={"path": str(gone), "missing_ok": 1}, headers=h).json()["size"] == 4

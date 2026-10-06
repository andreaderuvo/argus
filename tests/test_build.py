"""Which build is running: the version alone is the same for every commit between two tags."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app import build


def test_a_checkout_knows_its_commit():
    made = build.read()
    assert made and len(made["commit"]) == 40 and made["short"] == made["commit"][:7] and made["date"]


def test_the_version_says_the_commit_and_whether_a_pull_needs_a_restart(tmp_path, monkeypatch):
    from app.config import Config
    from app.main import create_app
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.check_releases = False
    app = create_app(cfg)
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    said = c.get("/api/version").json()
    assert said["build"]["commit"] == build.read()["commit"] and said["pulled"] is False
    monkeypatch.setattr(build, "on_disk", lambda: "0" * 40)
    assert c.get("/api/version").json()["pulled"] is True, "a pull since start: restart to run it"


def test_without_git_the_commit_comes_from_the_image(monkeypatch, tmp_path):
    monkeypatch.setattr(build, "ROOT", tmp_path)
    monkeypatch.setenv("ARGUS_COMMIT", "abcdef1234567890")
    assert build.read()["short"] == "abcdef1"
    monkeypatch.delenv("ARGUS_COMMIT")
    assert build.read() is None

"""Renaming a desk that is not there: the refusal names the desks, and the asker's own desk.

An agent asked to rename "its" desk guessed the name from its session ("a-deruvo su codex") and got
only "no desk called …" — it took a second try. The answer now carries what the second try needed."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

M = {"authorization": "Bearer " + "m" * 64}


def test_a_wrong_name_is_answered_with_the_desks_and_where_the_asker_is(tmp_path):
    cfg = Config(token="m" * 64, roots=[tmp_path])
    cfg.prefs_store = tmp_path / "prefs.json"
    c = TestClient(create_app(cfg))
    c.patch("/api/prefs", json={"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "argus", "desktop": []},
        {"id": 2, "name": "AMT 3D Circuit Viewer", "desktop": [{"kind": "term", "name": "codex-a-deruvo"}]}]}}, headers=M)
    r = c.post("/api/desks", json={"rename": "a-deruvo su codex", "name": "Viewer", "asker": "codex-a-deruvo"}, headers=M)
    assert r.status_code == 404
    said = r.json()["error"]
    assert "'argus'" in said and "'AMT 3D Circuit Viewer'" in said, said
    assert "your session codex-a-deruvo is in 'AMT 3D Circuit Viewer'" in said, said
    r = c.post("/api/desks", json={"rename": "nope", "name": "x", "asker": "elsewhere"}, headers=M)
    assert "your session elsewhere is in no desk" in r.json()["error"]
    assert c.post("/api/desks", json={"rename": "AMT 3D Circuit Viewer", "name": "Viewer"}, headers=M).json()["name"] == "Viewer"


def test_rename_mine_renames_the_desk_of_the_asking_session(tmp_path):
    """"Rename the desk" with no name: the desk the agent's own session is in."""
    cfg = Config(token="m" * 64, roots=[tmp_path])
    cfg.prefs_store = tmp_path / "prefs.json"
    c = TestClient(create_app(cfg))
    c.patch("/api/prefs", json={"changes": {"ws": 1, "wsSeq": 3, "workspaces": [
        {"id": 1, "name": "argus", "desktop": [{"kind": "term", "name": "twice"}]},
        {"id": 2, "name": "Desk 13", "desktop": [{"kind": "term", "name": "codex-a-deruvo"}, {"kind": "term", "name": "twice"}]}]}}, headers=M)
    r = c.post("/api/desks", json={"rename_mine": True, "asker": "codex-a-deruvo", "name": "AMT 3D Circuit Viewer"}, headers=M)
    assert r.json()["name"] == "AMT 3D Circuit Viewer"
    assert [w["name"] for w in c.get("/api/prefs", headers=M).json()["prefs"]["workspaces"]] == ["argus", "AMT 3D Circuit Viewer"]
    r = c.post("/api/desks", json={"rename_mine": True, "asker": "twice", "name": "x"}, headers=M)
    assert r.status_code == 409 and "several desks" in r.json()["error"] and "'argus'" in r.json()["error"]
    r = c.post("/api/desks", json={"rename_mine": True, "asker": "nowhere", "name": "x"}, headers=M)
    assert r.status_code == 404 and "in no desk" in r.json()["error"]

"""Notes: a folder of Argus's own, every note a file in it — listed latest first, written in place,
never overwritten unseen, never a door out of the folder, deleted into a trash."""

from __future__ import annotations

import os
import time

import pytest
from fastapi.testclient import TestClient

TOKEN = "n" * 64


@pytest.fixture
def notes_dir(tmp_path):
    return tmp_path / "notes"


@pytest.fixture
def client(tmp_path, notes_dir):
    from app.config import Config
    from app.main import create_app
    root = tmp_path / "root"
    root.mkdir()
    # No allow_write: the notes are Argus's own folder, not one of yours.
    app = create_app(Config(token=TOKEN, roots=[root], listen="127.0.0.1:0", notes_dir=notes_dir))
    c = TestClient(app)
    c.headers.update({"authorization": f"Bearer {TOKEN}"})
    return c


def test_a_new_note_is_note_n_and_is_listed_latest_first(client, notes_dir):
    a = client.post("/api/notes", json={"text": "# Listeria ST6\n\ncluster of four"}).json()
    b = client.post("/api/notes", json={}).json()
    assert (a["name"], b["name"]) == ("note-1.md", "note-2.md")
    assert a["path"] == str(notes_dir / "note-1.md") and a["title"] == "Listeria ST6"
    os.utime(notes_dir / "note-1.md", (time.time() + 5, time.time() + 5))
    said = client.get("/api/notes").json()
    assert said["dir"] == str(notes_dir)
    assert [n["name"] for n in said["notes"]] == ["note-1.md", "note-2.md"], "the latest first"


def test_written_in_place_and_read_back(client, notes_dir):
    made = client.post("/api/notes", json={"name": "plan"}).json()
    assert made["name"] == "plan.md", "a name with no suffix becomes Markdown"
    w = client.put("/api/notes/note", json={"name": "plan.md", "text": "- rerun cgDist", "base": made["mtime"]}).json()
    assert "conflict" not in w
    assert client.get("/api/notes/note", params={"name": "plan.md"}).json()["text"] == "- rerun cgDist"
    assert not list(notes_dir.glob(".*.part")), "no part file left"


def test_a_note_changed_meanwhile_is_not_overwritten(client, notes_dir):
    made = client.post("/api/notes", json={"name": "shared.md", "text": "mine"}).json()
    # An agent writes in it.
    (notes_dir / "shared.md").write_text("the agent's")
    os.utime(notes_dir / "shared.md", (made["mtime"] + 3, made["mtime"] + 3))
    r = client.put("/api/notes/note", json={"name": "shared.md", "text": "mine, edited", "base": made["mtime"]})
    assert r.status_code == 200 and r.json()["conflict"] is True
    assert r.json()["note"]["text"] == "the agent's"
    assert (notes_dir / "shared.md").read_text() == "the agent's"
    forced = client.put("/api/notes/note", json={"name": "shared.md", "text": "mine, edited", "base": None}).json()
    assert "conflict" not in forced and (notes_dir / "shared.md").read_text() == "mine, edited"


@pytest.mark.parametrize("name", ["../escape.md", "a/b.md", ".hidden.md", "..", ""])
def test_a_name_is_one_plain_file_name(client, name):
    assert client.put("/api/notes/note", json={"name": name, "text": "x"}).status_code == 400


def test_a_link_in_the_folder_is_no_door_out(client, notes_dir, tmp_path):
    outside = tmp_path / "secret.md"
    outside.write_text("private")
    client.get("/api/notes")
    (notes_dir / "door.md").symlink_to(outside)
    assert client.get("/api/notes/note", params={"name": "door.md"}).status_code == 403
    assert client.put("/api/notes/note", json={"name": "door.md", "text": "x"}).status_code == 403
    assert outside.read_text() == "private"
    assert "door.md" not in [n["name"] for n in client.get("/api/notes").json()["notes"]]


def test_rename_refuses_a_taken_name_and_delete_keeps_a_copy(client, notes_dir):
    client.post("/api/notes", json={"name": "a.md", "text": "A"})
    client.post("/api/notes", json={"name": "b.md", "text": "B"})
    assert client.post("/api/notes/rename", json={"name": "a.md", "to": "b.md"}).status_code == 409
    assert client.post("/api/notes/rename", json={"name": "a.md", "to": "alpha"}).json()["name"] == "alpha.md"
    gone = client.delete("/api/notes/note", params={"name": "alpha.md"}).json()
    assert not (notes_dir / "alpha.md").exists()
    assert open(gone["kept"]).read() == "A", "kept in the notes' trash"
    assert [n["name"] for n in client.get("/api/notes").json()["notes"]] == ["b.md"], "the trash is not listed"


def test_without_a_folder_there_are_no_notes(tmp_path):
    from app.config import Config
    from app.main import create_app
    c = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path], listen="127.0.0.1:0")))
    c.headers.update({"authorization": f"Bearer {TOKEN}"})
    assert c.get("/api/notes").status_code == 404

"""Deadlines and reminders on the to-do list: a day or a day and a time, a reminder some minutes
before it, rung once as a bell (so ntfy, so the phone), and rung again only if the deadline or
the reminder is moved."""

from __future__ import annotations

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

from app import todo

TOKEN = "r" * 64


@pytest.fixture
def app(tmp_path):
    from app.config import Config
    from app.main import create_app
    a = create_app(Config(token=TOKEN, roots=[tmp_path], listen="127.0.0.1:0"))
    a.state.todo = tmp_path / "todo.json"
    return a


@pytest.fixture
def client(app):
    c = TestClient(app)
    c.headers.update({"authorization": f"Bearer {TOKEN}"})
    return c


def at(text: str) -> float:
    return datetime.fromisoformat(text).timestamp()


def test_a_day_alone_rings_in_the_morning_and_is_due_by_its_end():
    one = todo.clean_one({"note": "call the lab", "due": "2026-10-20", "remind": 0})
    assert todo.ring_at(one) == at("2026-10-20T09:00")
    assert todo.due_at(one) == at("2026-10-20T23:59")
    a_day_before = todo.clean_one({"note": "x", "due": "2026-10-20", "remind": 1440})
    assert todo.ring_at(a_day_before) == at("2026-10-19T09:00")
    timed = todo.clean_one({"note": "x", "due": "2026-10-20T15:00", "remind": 60})
    assert todo.ring_at(timed) == at("2026-10-20T14:00")


@pytest.mark.parametrize("due", ["tomorrow", "2026-13-01", "2026-02-30", "2026-10-20 15:00"])
def test_a_deadline_that_does_not_read_is_refused(client, due):
    assert client.post("/api/todo", json={"note": "x", "due": due}).status_code == 400


def test_a_reminder_rings_once_and_again_when_moved(app, client):
    made = client.post("/api/todo", json={"note": "send the cgDist matrix", "due": "2026-10-20T15:00", "remind": 60}).json()
    from app.main import remind_todos
    assert remind_todos(app, now=at("2026-10-20T13:59")) == [], "not before its time"
    rang = remind_todos(app, now=at("2026-10-20T14:01"))
    assert [x["n"] for x in rang] == [made["n"]]
    bell = client.get("/api/bells?since=0").json()["bells"][-1]
    assert bell["why"] == "asking" and "send the cgDist matrix" in bell["text"] and "15:00" in bell["text"]
    assert bell["todo"] == made["n"]
    assert remind_todos(app, now=at("2026-10-20T14:30")) == [], "once"
    client.patch(f"/api/todo/{made['id']}", json={"due": "2026-10-21T15:00"})
    assert remind_todos(app, now=at("2026-10-20T14:30")) == [], "moved to tomorrow: not yet"
    assert len(remind_todos(app, now=at("2026-10-21T14:05"))) == 1, "and rings on the new day"


def test_done_ones_and_ones_without_a_reminder_ring_nothing(app, client):
    from app.main import remind_todos
    client.post("/api/todo", json={"note": "no reminder", "due": "2026-10-20"})
    done = client.post("/api/todo", json={"note": "finished", "due": "2026-10-20", "remind": 0}).json()
    client.patch(f"/api/todo/{done['id']}", json={"status": "done"})
    assert remind_todos(app, now=at("2026-10-21T10:00")) == []


def test_taking_the_deadline_away_takes_the_reminder_with_it(client):
    made = client.post("/api/todo", json={"note": "x", "due": "2026-10-20", "remind": 15}).json()
    after = client.patch(f"/api/todo/{made['id']}", json={"due": ""}).json()
    assert after["due"] == "" and after["remind"] is None


def test_an_old_list_still_reads(tmp_path):
    store = tmp_path / "todo.json"
    store.write_text('[{"note": "old one", "status": "open"}, {"note": "bad date", "due": "soon"}]')
    items = todo.load(store)
    assert [x["note"] for x in items] == ["old one", "bad date"]
    assert all(x["due"] == "" and x["remind"] is None for x in items)

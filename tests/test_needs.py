"""Needs you: what waits on the person now, from wherever it is kept, in one list.

"Copy only the best" (2026-11-04): a product had one inbox of what wants you. Argus had each piece in
its own place — the question in the corner, the amber on a desk, the team's line, the to-do's date.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import needs

TOKEN = "n" * 64


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


def test_questions_first_then_agents_then_late_to_dos(app, client):
    assert client.get("/api/needs").json() == {"items": []}
    asked = client.post("/api/ask", json={"text": "Overwrite results.tsv?", "options": ["yes", "no"],
                                           "session": "fixer", "wait": 0}).json()
    client.post("/api/todo", json={"note": "send the matrix", "due": "2020-01-01"})
    client.post("/api/todo", json={"note": "later", "due": "2999-01-01"})
    states = {"fixer": {"state": "waiting", "agent": "claude", "since": time.time()},
              "writer": {"state": "waiting", "agent": "codex", "since": time.time()},
              "seen-one": {"state": "waiting", "agent": "claude", "since": time.time(), "seen": True},
              "busy": {"state": "working", "agent": "claude", "since": time.time()}}
    items = needs.gather(app, states)
    assert [(x["kind"], x.get("session") or x.get("text")) for x in items] == [
        ("ask", "fixer"), ("waiting", "writer"), ("todo", "send the matrix")], items
    assert items[0]["options"] == ["yes", "no"] and items[0]["id"] == asked["id"]
    assert items[2]["late"] is True

    # Answered anywhere: off the list.
    client.post(f"/api/ask/{asked['id']}/answer", json={"answer": "no"})
    assert [x["kind"] for x in needs.gather(app, states)] == ["waiting", "waiting", "todo"]
    assert needs.count(app, {}) == 1


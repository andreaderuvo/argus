"""An agent asks; a person answers.

The rules worth pinning down are all about who may do which half. Asking is the narrowest
power in here — what it buys is *less* autonomy, an agent stopping to defer — and answering is
the one thing that must stay with a person, because the entire value of a question is that a
person answered it.
"""

import threading
import time

import pytest
from fastapi.testclient import TestClient

from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"
AGENT = "agentkey-0123456789abcdefxy"


@pytest.fixture
def client(tmp_path):
    (tmp_path / "root").mkdir()
    return TestClient(create_app(Config(
        token=TOKEN, roots=[tmp_path / "root"],
        agents=[{"name": "claude", "token": AGENT}],
    )))


MINE = {"Authorization": f"Bearer {TOKEN}"}
THEIRS = {"Authorization": f"Bearer {AGENT}"}


def test_the_answer_comes_back_as_the_return_value(client):
    """The whole feature in one test: the call waits, somebody taps, the call returns."""
    got = {}

    def asking():
        got.update(client.post("/api/ask", json={
            "text": "Drop the four bad isolates?", "options": ["drop", "keep"], "wait": 10,
        }, headers=THEIRS).json())

    waiter = threading.Thread(target=asking)
    waiter.start()
    for _ in range(100):                       # until the question is on the board
        open_ones = client.get("/api/asks", headers=MINE).json()["asks"]
        if open_ones:
            break
        time.sleep(0.02)
    assert client.post(f"/api/ask/{open_ones[0]['id']}/answer",
                       json={"answer": "drop"}, headers=MINE).status_code == 200
    waiter.join(timeout=15)
    assert got["answered"] is True
    assert got["answer"] == "drop"


def test_asking_rings_the_same_bell_as_everything_else(client):
    """A phone that already tells you an agent wants you should not need a second mechanism
    to tell you *what it wants*."""
    said = client.post("/api/ask", json={"text": "shall I?", "wait": 0}, headers=THEIRS).json()
    rung = client.get("/api/bells?since=0", headers=MINE).json()["bells"]
    assert [b["why"] for b in rung] == ["asking"]
    assert rung[0]["text"] == "shall I?"
    assert rung[0]["ask"] == said["id"], "the bell carries the question it is about"


def test_an_agent_cannot_answer(client):
    """Not its own, and not anybody else's."""
    ident = client.post("/api/ask", json={"text": "shall I?", "wait": 0}, headers=THEIRS).json()["id"]
    assert client.post(f"/api/ask/{ident}/answer", json={"answer": "yes"}, headers=THEIRS).status_code == 403
    assert client.get("/api/asks", headers=THEIRS).status_code == 403, "nor read everyone's"
    assert client.get(f"/api/ask/{ident}", headers=THEIRS).status_code == 200, "but may wait on its own"


def test_an_answer_outside_the_options_is_refused(client):
    """Offering three buttons and accepting a fourth thing is how an agent ends up branching
    on a string nobody promised it."""
    ident = client.post("/api/ask", json={"text": "which?", "options": ["a", "b"], "wait": 0},
                        headers=THEIRS).json()["id"]
    assert client.post(f"/api/ask/{ident}/answer", json={"answer": "c"}, headers=MINE).status_code == 400
    assert client.post(f"/api/ask/{ident}/answer", json={"answer": "a"}, headers=MINE).status_code == 200


def test_answering_twice_says_what_it_already_was(client):
    ident = client.post("/api/ask", json={"text": "which?", "wait": 0}, headers=THEIRS).json()["id"]
    client.post(f"/api/ask/{ident}/answer", json={"answer": "left"}, headers=MINE)
    again = client.post(f"/api/ask/{ident}/answer", json={"answer": "right"}, headers=MINE)
    assert again.status_code == 409
    assert "left" in again.json()["error"], "two devices tapping is a race worth naming"


def test_not_answered_yet_is_not_a_failure(client):
    """The agent is told nobody has answered, and can ask again with the same id — which is
    what makes this survive a dropped connection."""
    asked = client.post("/api/ask", json={"text": "shall I?", "wait": 0}, headers=THEIRS).json()
    assert asked["answered"] is False
    assert asked["answer"] is None
    again = client.get(f"/api/ask/{asked['id']}?wait=0", headers=THEIRS).json()
    assert again["answered"] is False


def test_an_empty_question_is_refused(client):
    assert client.post("/api/ask", json={"text": "  ", "wait": 0}, headers=THEIRS).status_code == 400


def test_a_form_is_not_a_question(client):
    many = [f"option {n}" for n in range(9)]
    r = client.post("/api/ask", json={"text": "pick", "options": many, "wait": 0}, headers=THEIRS)
    assert r.status_code == 400


def test_an_answered_question_leaves_the_list(client):
    ident = client.post("/api/ask", json={"text": "shall I?", "wait": 0}, headers=THEIRS).json()["id"]
    assert len(client.get("/api/asks", headers=MINE).json()["asks"]) == 1
    client.post(f"/api/ask/{ident}/answer", json={"answer": "yes"}, headers=MINE)
    assert client.get("/api/asks", headers=MINE).json()["asks"] == []


def test_the_waiting_machinery_never_leaves_the_server(client):
    """`asyncio.Event` is not JSON, and more to the point it is nobody's business."""
    said = client.post("/api/ask", json={"text": "shall I?", "wait": 0}, headers=THEIRS).json()
    assert "landed" not in said

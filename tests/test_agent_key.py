"""An agent key: what it opens, and — mostly — what it does not.

The point of this scope is subtraction, so the tests that matter are the refusals. An agent
living in a session on this machine can read the config file anyway; what this decides is the
shape of the access it takes when it does, and that is only true for as long as the list stays
short. A route added to `AGENT_ROUTES` without a reason should make one of these fail.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.auth import AGENT_ROUTES

AGENT_TOKEN = "a" * 64


@pytest.fixture
def app_with_agent(tmp_path, monkeypatch):
    from app.config import Config
    from app.main import create_app

    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.agents = [{"name": "in-session", "token": AGENT_TOKEN}]
    cfg.allow_write = True
    return create_app(cfg)


@pytest.fixture
def agent(app_with_agent):
    client = TestClient(app_with_agent)
    client.headers.update({"authorization": f"Bearer {AGENT_TOKEN}"})
    return client


def test_it_may_ask_what_is_happening(agent):
    assert agent.get("/api/who").status_code == 200
    assert agent.get("/api/tmux/sessions").status_code == 200
    assert agent.get("/api/launchers").status_code == 200


def test_it_may_ring(agent):
    assert agent.post("/api/bell", json={"why": "asking", "text": "stuck"}).status_code == 200


@pytest.mark.parametrize("method, path, body", [
    ("GET", "/api/file?path=/etc/passwd", None),
    ("GET", "/api/list?path=/", None),
    ("POST", "/api/tmux/kill", {"name": "anything"}),
    ("POST", "/api/tmux/new", {"name": "anything"}),
    ("POST", "/api/ports", {"port": 8000, "open": True}),
    ("POST", "/api/devices", {"name": "a new key for me"}),
    ("DELETE", "/api/devices/whatever", None),
    ("POST", "/api/journal", {"older_than": 0}),
    ("POST", "/api/shutdown", None),
    # Adding one is allowed; removing one deletes work, so it is not.
    ("DELETE", "/api/git/worktree?path=/tmp", None),
    ("POST", "/api/fs/delete", {"path": "/tmp/x"}),
])
def test_the_things_it_must_never_do(agent, method, path, body):
    """Files, killing, ports, tokens, the journal, the server itself.

    Every one of these is something the master token can do and an agent has no business
    doing to hand work to another agent — which is the whole argument for a second scope
    rather than sharing the key.
    """
    answer = agent.request(method, path, json=body)
    assert answer.status_code == 403, f"{method} {path} answered {answer.status_code}"
    # And it says what it *may* do, because a 403 with no way forward is how people end up
    # using the master token instead.
    assert "agent key may only" in answer.text


def test_the_refusal_names_the_routes_it_has(agent):
    answer = agent.post("/api/tmux/kill", json={"name": "x"})
    for said in ("/api/who", "/api/bell", "/api/relay", "/api/tmux/launch"):
        assert said in answer.text


def test_no_websocket_for_an_agent(agent):
    """The terminal is a WebSocket, and one of those is the ability to type anywhere.

    This is the single most important line in the scope: everything else it may do is bounded
    by a route, and a terminal is bounded by nothing.
    """
    with pytest.raises(Exception):
        with agent.websocket_connect(f"/ws/term?session=x&token={AGENT_TOKEN}"):
            pass


def test_a_wrong_token_is_not_an_agent(app_with_agent):
    client = TestClient(app_with_agent)
    client.headers.update({"authorization": "Bearer " + "z" * 64})
    assert client.get("/api/who").status_code == 401


def test_the_master_key_still_does_everything(app_with_agent):
    client = TestClient(app_with_agent)
    client.headers.update({"authorization": "Bearer " + "m" * 64})
    assert client.get("/api/who").status_code == 200
    assert client.get("/api/journal").status_code == 200


def test_the_list_of_what_an_agent_may_do_is_short():
    """A guard on the guard.

    The value of this scope is that it is small enough to hold in your head. If it grows, that
    should be a decision somebody makes on purpose, with this test in front of them.

    It has grown once: twelve to fourteen, for `GET` and `POST /api/runs`. The reasoning, since
    that is the point of stopping here — those two reach a noticeboard held in memory that says
    which orchestration is running and how far it has got. Posting to it cannot start, stop or
    reach an agent, cannot touch a file, and changes nothing if no browser is open. It buys the
    ability to *watch* what an agent-driven orchestration is doing, which is the opposite of a
    widening: an orchestration you can see is one you can stop.
    """
    assert len(AGENT_ROUTES) <= 14
    assert all(method in ("GET", "POST") for method, _ in AGENT_ROUTES)
    assert not any(path.startswith("/api/fs") or path.startswith("/api/devices")
                   for _, path in AGENT_ROUTES)

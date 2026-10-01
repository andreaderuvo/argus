"""One ring per turn: an agent that stops is news once, however many ways it is said.

Before this, a turn of Claude Code rang twice: its Stop hook said `done`, and its idle
notification said `asking` exactly sixty seconds later (read off a live server's bell list,
2026-09-30). And an agent with no hook — Gemini unwired, a Codex asking for approval — never
rang at all, although the sampler could see it stop. The rules, driven here without tmux:
the sampler's readings are written straight into the watch.
"""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app.main import agent_changed

TOKEN = "m" * 64


@pytest.fixture
def app(tmp_path):
    from app.config import Config
    from app.main import create_app

    return create_app(Config(token=TOKEN, roots=[tmp_path], listen="127.0.0.1:0"))


@pytest.fixture
def client(app):
    c = TestClient(app)
    c.headers.update({"authorization": f"Bearer {TOKEN}"})
    return c


def agent(app, session, state):
    """What the sampler would have concluded, and the change it would announce."""
    was = app.state.agents.state.get(session, ("", 0))[0] or None
    app.state.agents.state[session] = (state, time.time())
    if was != state:
        agent_changed(app, session, was, state, "claude")


def bells(client):
    return client.get("/api/bells?since=0").json()["bells"]


def test_the_idle_notification_after_a_turn_is_not_a_second_ring(app, client):
    agent(app, "api", "working")
    first = client.post("/api/bell", json={"session": "api", "why": "done"}).json()
    agent(app, "api", "waiting")                       # the sampler notices a moment later
    idle = client.post("/api/bell", json={"session": "api", "why": "asking",
                                          "text": "Claude is waiting for your input"}).json()
    assert idle["repeat"] is True and idle["seq"] == first["seq"]
    assert [b["why"] for b in bells(client)] == ["done"], "one turn, one bell"


def test_the_next_turn_rings_again(app, client):
    agent(app, "api", "working")
    client.post("/api/bell", json={"session": "api", "why": "done"})
    agent(app, "api", "waiting")
    agent(app, "api", "working")                       # you answered; it is at work again
    again = client.post("/api/bell", json={"session": "api", "why": "done"}).json()
    assert "repeat" not in again
    assert len(bells(client)) == 2


def test_a_permission_prompt_in_the_middle_of_a_turn_rings(app, client):
    agent(app, "api", "working")
    client.post("/api/bell", json={"session": "api", "why": "done"})
    agent(app, "api", "waiting")
    agent(app, "api", "working")
    asked = client.post("/api/bell", json={"session": "api", "why": "asking",
                                           "text": "Claude needs your permission to use Bash"}).json()
    assert "repeat" not in asked
    assert bells(client)[-1]["text"] == "Claude needs your permission to use Bash"


def test_an_agent_with_no_hook_rings_when_it_stops(app, client):
    agent(app, "gem", "working")
    agent(app, "gem", "waiting")
    said = bells(client)
    assert [(b["session"], b["why"], b.get("source")) for b in said] == [("gem", "asking", "watch")]


def test_a_first_reading_of_waiting_is_not_a_stop(app, client):
    """Argus starting up, or a session appearing, finds agents already waiting: that is the
    state of things, not something that just happened."""
    agent(app, "old", "waiting")
    assert bells(client) == []


def test_the_hook_after_the_sampler_is_the_same_turn(app, client):
    agent(app, "api", "working")
    agent(app, "api", "waiting")                       # the sampler got there first
    late = client.post("/api/bell", json={"session": "api", "why": "done"}).json()
    assert late["repeat"] is True
    assert len(bells(client)) == 1


def test_a_turn_too_short_for_the_sampler_still_rings_through_its_hook(app, client):
    """Seen as waiting throughout, so no new turn was ever opened — but a Stop hook is one per
    turn, and it is the stronger witness."""
    agent(app, "api", "working")
    client.post("/api/bell", json={"session": "api", "why": "done"})
    agent(app, "api", "waiting")
    quick = client.post("/api/bell", json={"session": "api", "why": "done"}).json()
    assert "repeat" not in quick


def test_a_session_that_is_not_an_agent_rings_every_time(client):
    for _ in range(3):
        client.post("/api/bell", json={"session": "build", "why": "done"})
    assert len(bells(client)) == 3


def test_failures_and_notes_are_never_folded(app, client):
    agent(app, "api", "working")
    client.post("/api/bell", json={"session": "api", "why": "done"})
    client.post("/api/bell", json={"session": "api", "why": "failed"})
    client.post("/api/bell", json={"session": "api", "why": "note", "text": "fyi"})
    assert [b["why"] for b in bells(client)] == ["done", "failed", "note"]


def test_a_running_server_keeps_watching_with_no_browser_open(app):
    """`main` sets `always`: that is what lets an agent that stops ring a phone through ntfy with
    every tab shut. The apps the tests build leave it off, and start no watcher at all."""
    with TestClient(app):
        assert app.state.agents.task is None
    app.state.agents.always = True
    app.state.agents.tick = lambda now=None: None      # no tmux here: the loop, not the reading
    with TestClient(app):
        assert app.state.agents.task is not None


def test_got_it_sets_a_wait_aside_until_the_agent_has_worked_again(app, client):
    app.state.agents.tick = lambda now=None: None      # no tmux: the readings are written by hand
    agent(app, "api", "working")
    agent(app, "api", "waiting")
    said = client.post("/api/tmux/seen", json={"sessions": ["api", "not-waiting"]}).json()
    assert said["seen"] == ["api"], "only a session that is waiting can be set aside"
    assert said["states"]["api"]["seen"] is True
    # It lasts for this wait only: the agent works and stops, and asks again.
    agent(app, "api", "working")
    agent(app, "api", "waiting")
    assert client.get("/api/tmux/states").json()["states"]["api"]["seen"] is False


def test_got_it_wants_a_list(client):
    assert client.post("/api/tmux/seen", json={"sessions": "api"}).status_code == 400

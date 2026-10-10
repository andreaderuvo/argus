"""A team's agents ending their turns is the director's business, not the person's.

A team that ran alone rang — and lit "Got it, all" — at every turn of every agent (2026-10-10).
Now, by default (`quiet_agents`), its agents' end-of-turn bells ring nothing and their waits
count as seen; a permission still rings; a team can ask for the old way (`quiet_agents: false`).
"""

from __future__ import annotations

import types

from fastapi.testclient import TestClient

from app import bells
from app.config import Config
from app.main import create_app

H = {"Authorization": "Bearer " + "m" * 64}


class Director:
    def __init__(self, quiet):
        self.team = {"name": "Kraken", "spec": {} if quiet is None else {"quiet_agents": quiet}}
        self.teams = {}

    def by_session(self, session):
        return (self.team, {"id": "trader"}) if session == "Kraken-trader" else (None, None)

    def tick(self):
        pass


def app_with(tmp_path, quiet):
    app = create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0"))
    app.state.teams = Director(quiet)
    return app


def test_quiet_by_default_and_when_asked():
    assert bells.quiet_team(types.SimpleNamespace(state=types.SimpleNamespace(teams=Director(None))), "Kraken-trader") == "Kraken"
    assert bells.quiet_team(types.SimpleNamespace(state=types.SimpleNamespace(teams=Director(True))), "Kraken-trader") == "Kraken"
    assert bells.quiet_team(types.SimpleNamespace(state=types.SimpleNamespace(teams=Director(False))), "Kraken-trader") is None
    assert bells.quiet_team(types.SimpleNamespace(state=types.SimpleNamespace(teams=Director(None))), "somebody-else") is None


def test_a_quiet_teams_turn_rings_nothing_but_a_permission_does(tmp_path):
    app = app_with(tmp_path, None)
    with TestClient(app) as c:
        said = c.post("/api/bell", json={"why": "done", "session": "Kraken-trader"}, headers=H).json()
        assert said == {"quiet": True, "team": "Kraken", "session": "Kraken-trader"}
        said = c.post("/api/bell", json={"why": "asking", "session": "Kraken-trader", "text": "Claude is waiting for your input"}, headers=H).json()
        assert said.get("quiet"), "idle is not a question"
        said = c.post("/api/bell", json={"why": "asking", "session": "Kraken-trader", "text": "Claude needs your permission to use Bash"}, headers=H).json()
        assert not said.get("quiet") and said.get("seq"), "a permission blocks the agent: it rings"
        # Anybody else rings as always.
        assert c.post("/api/bell", json={"why": "done", "session": "a-shell"}, headers=H).json().get("seq")


def test_a_team_that_asked_for_turns_rings_them(tmp_path):
    app = app_with(tmp_path, False)
    with TestClient(app) as c:
        assert c.post("/api/bell", json={"why": "done", "session": "Kraken-trader"}, headers=H).json().get("seq")


def test_its_waits_are_not_waiting_for_you(tmp_path):
    app = app_with(tmp_path, None)

    class Watch:
        task = object()                            # awake: no reading taken on the spot
        told = {}
        state = {}

        def states(self):
            return {"Kraken-trader": {"agent": "claude", "state": "waiting", "since": 1, "seen": False},
                    "lone": {"agent": "claude", "state": "waiting", "since": 1, "seen": False}}

        def tick(self):
            pass
    with TestClient(app) as c:
        app.state.agents = Watch()
        got = c.get("/api/tmux/states", headers=H).json()["states"]
    assert got["Kraken-trader"]["seen"] is True and got["Kraken-trader"]["team"] == "Kraken"
    assert got["lone"]["seen"] is False, "an agent outside a team still waits for you"

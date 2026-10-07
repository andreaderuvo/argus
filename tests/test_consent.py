"""What an agent may have done with the person's OK (app/consent.py): it requests, the person
taps Do it / No, Argus does it through its own routes with the full key."""

from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from app import consent
from app.config import Config
from app.main import create_app

MASTER = {"authorization": "Bearer " + "m" * 64}
AGENT = {"authorization": "Bearer " + "a" * 64}


def make(tmp_path, **kw):
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0", allow_write=True, **kw)
    cfg.agents = [{"name": "in-session", "token": "a" * 64}]
    cfg.todo_store = tmp_path / "todo.json"
    return create_app(cfg)


def answer(c, req, said):
    c.post(f"/api/ask/{req['question']}/answer", json={"answer": said}, headers=MASTER).raise_for_status()


def settle(c, ident, until=("done", "refused", "failed")):
    for _ in range(50):
        said = c.get(f"/api/agent/request/{ident}?wait=1", headers=AGENT).json()
        if said["state"] in until:
            return said
        time.sleep(0.1)
    return said


def test_the_list_of_what_may_be_asked_is_on_the_agent_key(tmp_path):
    with TestClient(make(tmp_path)) as c:
        said = c.get("/api/agent/actions", headers=AGENT).json()["actions"]
        assert {a["action"] for a in said} == set(consent.ACTIONS) and all(a["asks"] for a in said)


def test_asked_then_done_through_the_apps_own_routes(tmp_path):
    with TestClient(make(tmp_path)) as c:
        c.post("/api/todo", json={"note": "old thing"}, headers=AGENT).raise_for_status()
        n = c.get("/api/todo", headers=AGENT).json()["items"][0]["n"]
        req = c.post("/api/agent/request", json={"action": "todo_delete", "args": {"todo": f"#{n}"}, "why": "it is done",
                                                 "session": "claude-1"}, headers=AGENT).json()
        assert req["state"] == "asked" and req["text"] == f"take to-do #{n} off the list"
        asked = c.get("/api/asks", headers=MASTER).json()["asks"]
        assert asked[0]["options"] == ["Do it", "No"] and "claude-1 asks to take to-do" in asked[0]["text"]
        assert "it is done" in asked[0]["text"]
        answer(c, req, "Do it")
        assert settle(c, req["id"])["state"] == "done"
        assert c.get("/api/todo", headers=AGENT).json()["items"] == []


def test_a_no_is_a_no(tmp_path):
    with TestClient(make(tmp_path)) as c:
        c.post("/api/todo", json={"note": "keep me"}, headers=AGENT)
        req = c.post("/api/agent/request", json={"action": "todo_delete", "args": {"todo": "1"}}, headers=AGENT).json()
        answer(c, req, "No")
        assert settle(c, req["id"])["state"] == "refused"
        assert len(c.get("/api/todo", headers=AGENT).json()["items"]) == 1


def test_a_failure_after_the_yes_is_said(tmp_path):
    with TestClient(make(tmp_path)) as c:
        req = c.post("/api/agent/request", json={"action": "todo_delete", "args": {"todo": "99"}}, headers=AGENT).json()
        answer(c, req, "Do it")
        said = settle(c, req["id"])
        assert said["state"] == "failed" and said["error"]


def test_what_cannot_be_done_as_asked_is_refused_before_asking(tmp_path):
    with TestClient(make(tmp_path)) as c:
        for body, words in [({"action": "format_disk"}, "cannot be requested"),
                            ({"action": "team_pause", "args": {"team": "nope"}}, "no team called"),
                            ({"action": "kill_session", "args": {}}, "which session"),
                            ({"action": "start_team", "args": {"team": "no such team", "folder": str(tmp_path)}}, "no team called")]:
            said = c.post("/api/agent/request", json=body, headers=AGENT)
            assert said.status_code == 400 and words in said.text, (body, said.text)
        assert c.get("/api/asks", headers=MASTER).json()["asks"] == [], "nothing was put to the person"


def test_without_asking_when_the_config_says_so_but_never_for_no_questions_agents(tmp_path):
    with TestClient(make(tmp_path, agents_without_asking=["todo_delete", "start_agent"])) as c:
        c.post("/api/todo", json={"note": "x"}, headers=AGENT)
        req = c.post("/api/agent/request", json={"action": "todo_delete", "args": {"todo": "1"}, "wait": 5}, headers=AGENT).json()
        assert req["state"] == "done" and "question" not in req
        req = c.post("/api/agent/request", json={"action": "start_agent", "args": {
            "launcher": "Claude Code", "name": "loose", "options": {"permissions": "skip"}}}, headers=AGENT).json()
        assert req["state"] == "asked", "letting an agent loose is always asked"


def test_a_team_is_planned_from_its_name_with_an_agent_per_step(tmp_path, monkeypatch):
    app = make(tmp_path)
    agents = [{"name": "Claude Code", "agent": "claude", "available": True,
               "options": [{"id": "permissions", "choices": [{"value": "edits"}, {"value": "skip"}]}]},
              {"name": "Codex", "agent": "codex", "available": True,
               "options": [{"id": "permissions", "choices": [{"value": "workspace"}, {"value": "yolo"}]}]}]
    monkeypatch.setattr(consent.launch, "describe", lambda cfg, versions=False: agents)
    plan = consent.plan(app, "start_team", {"team": "Build and review", "folder": str(tmp_path), "goal": "tidy it", "desk": "Work"})
    body = plan["calls"][0][2]
    assert plan["calls"][0][:2] == ("POST", "/api/teams") and plan["desk"] == "Work" and not plan["danger"]
    assert body["template"] == "review" and body["goal"] == "tidy it" and body["path"] == str(tmp_path)
    launchers = [s["launcher"] for s in body["agents"].values()]
    assert launchers == ["Claude Code", "Codex"], "a different agent per step"
    assert [s["options"] for s in body["agents"].values()] == [{"permissions": "edits"}, {"permissions": "workspace"}]
    assert "in the desk Work" in plan["text"] and "executor → Claude Code" in plan["text"]
    with pytest.raises(ValueError, match="has no goal"):
        consent.plan(app, "start_team", {"team": "Build and review", "folder": str(tmp_path)})
    danger = consent.plan(app, "start_team", {"team": "review", "folder": str(tmp_path), "goal": "x", "permissions": "everything"})
    assert danger["danger"] and [s["options"] for s in danger["calls"][0][2]["agents"].values()] == [{"permissions": "skip"}, {"permissions": "yolo"}]


def test_a_proposed_team_is_found_by_name_in_its_own_folder(tmp_path, monkeypatch):
    from app.teams import Proposals, propose
    app = make(tmp_path)
    app.state.proposals = Proposals()
    folder = tmp_path / "kraken"
    folder.mkdir()
    said = propose(folder, "%% name: Kraken paper\n%% goal: paper-trade it\nflowchart LR\n a[executor] --> c{{\"true\"}}\n c -->|PASS| done\n", "x")
    app.state.proposals.add(str(folder), said, "x", time.time())
    monkeypatch.setattr(consent.launch, "describe", lambda cfg, versions=False: [{"name": "Claude Code", "agent": "claude", "available": True}])
    plan = consent.plan(app, "start_team", {"team": "kraken paper", "desk": "Trading"})
    body = plan["calls"][0][2]
    assert body["path"] == str(folder) and body["goal"] == "paper-trade it" and body["name"] == "Kraken paper"


def test_a_session_is_put_on_a_desk_without_asking(tmp_path):
    with TestClient(make(tmp_path)) as c:
        said = c.post("/api/desks", json={"name": "Trading", "session": "nope", "show": False}, headers=AGENT)
        assert said.status_code == 404 and "no session called nope" in said.text


def test_the_tables_name_every_action_and_every_tool():
    """The `argus` skill (what the agent reads) names every tool and every requestable action, so
    an action added without its line in the table fails here. The wiki's table is checked too when
    the wiki is cloned beside the repository (~/argus.wiki, as test_surface.py does)."""
    from pathlib import Path

    from tools import argus_mcp
    root = Path(__file__).resolve().parent.parent
    skill = (root / "plugin/skills/argus/SKILL.md").read_text()
    tools = {t["name"] for t in argus_mcp.TOOLS} - {"request_status", "argus"}
    missing = [x for x in [*consent.ACTIONS, *tools] if f"`{x}`" not in skill]
    assert not missing, f"not in plugin/skills/argus/SKILL.md: {missing}"
    wiki = Path.home() / "argus.wiki" / "What-an-agent-can-do.md"
    if wiki.exists():
        text = wiki.read_text()
        gone = [x for x in consent.ACTIONS if f"`{x}`" not in text]
        assert not gone, f"not in the wiki's What-an-agent-can-do: {gone}"


def test_what_an_agent_key_does_is_journaled_under_the_agents_name(tmp_path):
    from app import journal
    app = make(tmp_path)
    app.state.cfg.journal_store = tmp_path / "journal.jsonl"
    with TestClient(app) as c:
        c.post("/api/todo", json={"note": "x"}, headers=AGENT).raise_for_status()
    assert journal.who_from({"argus_agent": {"name": "in-session"}}) == "in-session (agent)"


def test_a_proposals_permissions_reach_the_start(tmp_path, monkeypatch):
    from app.teams import Proposals, propose
    app = make(tmp_path)
    app.state.proposals = Proposals()
    folder = tmp_path / "p"
    folder.mkdir()
    said = propose(folder, "name: Loose\ngoal: g\npermissions: everything\nsteps:\n  a: {role: executor}\nflow:\n  - a -> a if REDO\n", "x")
    app.state.proposals.add(str(folder), said, "x", time.time())
    monkeypatch.setattr(consent.launch, "describe", lambda cfg, versions=False: [
        {"name": "Claude Code", "agent": "claude", "available": True,
         "options": [{"id": "permissions", "choices": [{"value": "edits"}, {"value": "skip"}]}]}])
    plan = consent.plan(app, "start_team", {"team": "Loose"})
    assert plan["danger"] and "may do without asking: everything" in plan["text"]


def test_a_process_with_a_bare_environment_is_told_its_session(tmp_path, monkeypatch):
    """Codex starts its MCP servers with no TMUX_PANE: `team_done` could not say whose turn it was.
    Argus walks the process's parents to a pane's own pid — on its own tmux server only."""
    import os
    from app import tmux as T
    me = os.getpid()
    parent = T.parent_of(me)
    assert parent > 0
    monkeypatch.setattr(T, "pane_pids", lambda sock: {"trader": [parent], "other": [999999]})
    assert T.session_of_pid(None, me) == "trader"
    monkeypatch.setattr(T, "pane_pids", lambda sock: {"other": [999999]})
    assert T.session_of_pid(None, me) is None
    with TestClient(make(tmp_path)) as c:
        monkeypatch.setattr(T, "pane_pids", lambda sock: {"trader": [parent]})
        assert c.get(f"/api/tmux/whoami?pid={me}", headers=AGENT).json() == {"session": "trader"}


def test_the_client_asks_argus_when_its_environment_does_not_say(monkeypatch):
    from tools import argus_client as C
    monkeypatch.delenv("ARGUS_SESSION", raising=False)
    monkeypatch.delenv("TMUX_PANE", raising=False)
    a = C.Argus("http://127.0.0.1:1", "x")
    asked = []
    monkeypatch.setattr(a, "call", lambda m, p, b=None, timeout=60: asked.append(p) or {"session": "trader"})
    assert a.me() == "trader" and a.me() == "trader" and len(asked) == 1, "asked once, remembered"
    assert asked[0].startswith("/api/tmux/whoami?pid=")
    assert a.me("given") == "given"


def test_a_session_argus_starts_knows_its_name_and_finds_argus_say(monkeypatch):
    from app import launch
    ran = []
    monkeypatch.setattr(launch.tmux, "run", lambda argv: ran.append(argv))
    launch.start(launch.tmux.Socket(), "Kraken-trader", "/tmp", "codex")
    line = ran[0][-1]
    assert "export ARGUS_SESSION=" in line and "Kraken-trader" in line and str(launch.TOOLS) in line
    assert (launch.TOOLS / "argus-say").exists()

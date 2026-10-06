"""The team director, as a state machine on a graph: no tmux, no agents.

The test plays the agents — it appends their turns to the log the way the prompt tells them to —
and the checks, by writing their exit codes. What is asserted is what the director does in reply:
whom it prompts, when it runs which check, when two branches run at once, when a join lets the
team go on, when it stops, and what it asks the person.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time as _time
import types
from pathlib import Path

import pytest

from app import teams
from app.teams import TEMPLATES, Director, check_graph, fill_graph, parse_turns, suggest_check, suggest_template, turn_text

HAS_TMUX = shutil.which("tmux") is not None


class FakeIO:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.checks: dict[str, tuple] = {}          # session -> (command, folder, log, exit)
        self.check_order: list[str] = []
        self.rings: list[tuple] = []
        self.states: dict[str, tuple] = {}
        self.clock = 1000.0

    def send(self, session, text):
        self.sent.append((session, text))

    def state(self, session):
        return self.states.get(session)

    def run_check(self, team, command, folder, log, exit_file, session=None):
        self.checks[session] = (command, folder, Path(log), Path(exit_file))
        self.check_order.append(session)

    def ring(self, why, text, session):
        self.rings.append((why, text))

    def now(self):
        return self.clock

    def to(self):
        return [s for s, _ in self.sent]


@pytest.fixture
def setup(tmp_path):
    io = FakeIO()
    d = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    return d, io, tmp_path


def make(d, tmp, template, gate="goal", rounds=5, check="cargo test --release", folders=None):
    graph = fill_graph(TEMPLATES[template]["graph"], "t", folders or {}, default_check=check)
    return d.create(name="t", goal="make it faster without changing results", folder=str(tmp),
                    graph=graph, template=template, gate=gate, max_rounds=rounds)


def turn(team, who, body="did it", **fields):
    with open(team["log"], "a") as f:
        f.write(turn_text(who, body, round=team["round"], **fields))


def check_exits(io, session, code, output="ok"):
    _cmd, _folder, log, exit_file = io.checks[session]
    log.write_text(output)
    exit_file.write_text(f"{code}\n")


# ------------------------------------------------------------------ the templates as graphs

def test_an_optimise_round_goes_executor_check_reviewer_and_on(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    assert io.to() == ["t-executor"] and "make it faster" in io.sent[-1][1]
    assert "cat >>" in io.sent[-1][1] and "who=EXECUTOR" in io.sent[-1][1], "the prompt says how to answer"
    turn(team, "EXECUTOR", "vectorised the inner loop")
    d.tick()
    assert io.check_order == ["t-check"] and io.checks["t-check"][0] == "cargo test --release"
    check_exits(io, "t-check", 0, "test result: ok. 48 passed\nbench: 1.51s")
    d.tick()
    assert io.to()[-1] == "t-reviewer"
    assert "status=<OK|REDO|DONE|BLOCKED>" in io.sent[-1][1], "the judge is asked for a verdict"
    log = Path(team["log"]).read_text()
    assert "who=CHECK" in log and "status=PASS" in log and "48 passed" in log
    turn(team, "REVIEWER", "good, now the allocations", status="OK")
    d.tick()
    assert team["round"] == 2 and io.to()[-1] == "t-executor", "back to the executor is the next round"


def test_a_failing_check_goes_back_to_the_executor_without_a_review(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, "t-check", 101, "test cgdist::distance ... FAILED")
    d.tick()
    assert io.to()[-1] == "t-executor" and team["round"] == 2
    assert "FAILED" in io.sent[-1][1], "and is told the check failed"
    assert "t-reviewer" not in io.to()


def test_two_failed_checks_stop_and_continue_tries_again(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise", gate="auto")
    for _ in range(2):
        turn(team, "EXECUTOR")
        d.tick()
        check_exits(io, "t-check", 1)
        d.tick()
    assert team["status"] == "waiting-you" and "failed twice" in io.rings[-1][1]
    sent = len(io.sent)
    d.go(team["id"])
    assert len(io.sent) == sent + 1 and io.to()[-1] == "t-executor", "Continue goes where a failure leads"


def test_done_from_the_judge_ends_the_team(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, "t-check", 0)
    d.tick()
    turn(team, "REVIEWER", "31% faster, results identical", status="DONE")
    d.tick()
    assert team["status"] == "done" and io.rings[-1][0] == "done"
    assert "status=STOP" in Path(team["log"]).read_text()
    sent = len(io.sent)
    d.tick()
    assert len(io.sent) == sent, "a finished team sends nothing more"


def test_the_ask_gate_waits_for_a_press_at_each_new_round(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise", gate="ask")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, "t-check", 0)
    d.tick()
    turn(team, "REVIEWER", status="OK")
    d.tick()
    assert team["phase"] == "gate" and io.rings[-1][0] == "asking"
    sent = len(io.sent)
    d.tick()
    assert len(io.sent) == sent, "nothing moves at a gate"
    d.go(team["id"])
    assert io.to()[-1] == "t-executor" and team["round"] == 2


def test_rounds_run_out(setup):
    d, io, tmp = setup
    team = make(d, tmp, "review", rounds=2)
    for _ in range(2):
        turn(team, "EXECUTOR")
        d.tick()
        turn(team, "REVIEWER", status="REDO")
        d.tick()
    assert team["status"] == "done" and "rounds used" in team["history"][-1]["what"]


def test_blocked_asks_the_person_and_continue_goes_on_as_ok(setup):
    d, io, tmp = setup
    team = make(d, tmp, "review")
    turn(team, "EXECUTOR")
    d.tick()
    turn(team, "REVIEWER", "which licence?", status="BLOCKED")
    d.tick()
    assert team["status"] == "waiting-you"
    d.go(team["id"])
    assert io.to()[-1] == "t-executor" and team["status"] == "running"


def test_a_fix_team_ends_when_the_check_passes(setup):
    d, io, tmp = setup
    team = make(d, tmp, "fix", check="pytest -q tests/test_empty.py")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, "t-check", 1)
    d.tick()
    assert team["round"] == 2 and io.to()[-1] == "t-executor"
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, "t-check", 0)
    d.tick()
    assert team["status"] == "done"


def test_an_agent_that_stops_without_its_turn_is_reminded_then_the_person_asked(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    io.states["t-executor"] = ("waiting", io.clock)
    io.clock += teams.NUDGE_AFTER + 1
    d.tick()
    assert io.to()[-1] == "t-executor" and "without writing your turn" in io.sent[-1][1]
    io.clock += teams.GIVE_UP_AFTER
    d.tick()
    assert team["status"] == "waiting-you" and "has not written its turn" in io.rings[-1][1]
    d.go(team["id"])
    assert io.to()[-1] == "t-executor" and "who=EXECUTOR" in io.sent[-1][1], "Continue asks it again"


def test_pause_lets_the_turn_finish_and_starts_nothing_until_go(setup):
    d, io, tmp = setup
    team = make(d, tmp, "review")
    d.pause(team["id"])
    turn(team, "EXECUTOR")
    d.tick()
    assert team["phase"] == "gate" and "t-reviewer" not in io.to(), "recorded, not passed on"
    d.go(team["id"])
    assert io.to()[-1] == "t-reviewer"


def test_a_turn_still_being_written_is_not_taken(setup):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    with open(team["log"], "a") as f:
        f.write("\n@TURN who=EXECUTOR round=1\nhalf way\n")
    d.tick()
    assert not io.checks


def test_it_survives_a_restart(setup, tmp_path):
    d, io, tmp = setup
    team = make(d, tmp, "optimise")
    again = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    assert "executor" in again.teams[team["id"]]["running"]
    turn(again.teams[team["id"]], "EXECUTOR")
    again.tick()
    assert io.checks


# ------------------------------------------------------------------ more than two

def test_a_tournament_runs_two_branches_at_once_and_the_join_waits_for_both(setup):
    d, io, tmp = setup
    team = make(d, tmp, "tournament", folders={"executor-a": "/w/a", "executor-b": "/w/b"})
    assert io.to() == ["t-planner"]
    turn(team, "PLANNER", "A tries SIMD, B tries a better cache layout")
    d.tick()
    assert sorted(io.to()[1:]) == ["t-executor-a", "t-executor-b"], "both branches, together"
    turn(team, "EXECUTOR-A")
    d.tick()
    assert io.check_order == ["t-check-a"] and io.checks["t-check-a"][1] == "/w/a", "a's check runs in a's copy"
    check_exits(io, "t-check-a", 0)
    d.tick()
    assert "t-reviewer" not in io.to(), "the join waits for b"
    turn(team, "EXECUTOR-B")
    d.tick()
    assert io.checks["t-check-b"][1] == "/w/b"
    check_exits(io, "t-check-b", 0)
    d.tick()
    assert io.to()[-1] == "t-reviewer", "both arrived: the reviewer"
    assert "/w/a" in io.sent[-1][1] and "/w/b" in io.sent[-1][1], "and is told where each one's work is"
    turn(team, "REVIEWER", "B wins: 22% faster", status="REDO")
    d.tick()
    assert io.to()[-1] == "t-planner" and team["round"] == 2


def test_a_failed_branch_still_reaches_the_join_and_the_reviewer_hears_of_it(setup):
    d, io, tmp = setup
    team = make(d, tmp, "tournament")
    turn(team, "PLANNER")
    d.tick()
    turn(team, "EXECUTOR-A")
    turn(team, "EXECUTOR-B")
    d.tick()
    check_exits(io, "t-check-a", 1, "FAILED")
    check_exits(io, "t-check-b", 0)
    d.tick()
    assert io.to()[-1] == "t-reviewer"


def test_two_critics_in_parallel_then_the_writer_again(setup):
    d, io, tmp = setup
    team = make(d, tmp, "write")
    turn(team, "RESEARCHER")
    d.tick()
    turn(team, "WRITER")
    d.tick()
    assert sorted(io.to()[-2:]) == ["t-critic-method", "t-critic-style"]
    turn(team, "CRITIC-METHOD", status="OK")
    d.tick()
    assert io.to()[-1] != "t-writer", "the join waits for the second critic"
    turn(team, "CRITIC-STYLE", status="REDO")
    d.tick()
    assert io.to()[-1] == "t-writer" and team["round"] == 2


def test_a_graph_of_your_own(setup):
    """planner → coder → tests; FAIL back to the coder; PASS ends."""
    d, io, tmp = setup
    graph = {"nodes": [{"id": "planner", "kind": "agent", "role": "planner"},
                       {"id": "coder", "kind": "agent", "role": "executor"},
                       {"id": "tests", "kind": "check", "of": "coder", "command": "make test"},
                       {"id": "end", "kind": "end"}],
             "edges": [{"from": "planner", "to": "coder", "when": "always"},
                       {"from": "coder", "to": "tests", "when": "always"},
                       {"from": "tests", "to": "coder", "when": "FAIL"},
                       {"from": "tests", "to": "end", "when": "PASS"}],
             "start": ["planner"]}
    team = d.create(name="mine", goal="add a CSV export", folder=str(tmp), graph=fill_graph(graph, "m"), gate="goal")
    turn(team, "PLANNER")
    d.tick()
    turn(team, "CODER")
    d.tick()
    assert io.checks["m-tests"][0] == "make test"
    check_exits(io, "m-tests", 0)
    d.tick()
    assert team["status"] == "done"


@pytest.mark.parametrize("graph, says", [
    ({"nodes": [], "edges": [], "start": []}, "between 1 and"),
    ({"nodes": [{"id": "Bad Name", "kind": "agent"}], "edges": [], "start": ["Bad Name"]}, "cannot name a step"),
    ({"nodes": [{"id": "a", "kind": "agent"}, {"id": "a", "kind": "agent"}], "edges": [], "start": ["a"]}, "two steps"),
    ({"nodes": [{"id": "c", "kind": "check", "command": "x"}], "edges": [], "start": ["c"]}, "at least one agent"),
    ({"nodes": [{"id": "a", "kind": "agent"}], "edges": [{"from": "a", "to": "z", "when": "always"}], "start": ["a"]}, "not in the team"),
    ({"nodes": [{"id": "a", "kind": "agent"}], "edges": [{"from": "a", "to": "a", "when": "MAYBE"}], "start": ["a"]}, "condition"),
    ({"nodes": [{"id": "a", "kind": "agent"}, {"id": "j", "kind": "join"}], "edges": [], "start": ["a"]}, "waits for nothing"),
    ({"nodes": [{"id": "a", "kind": "agent"}], "edges": [], "start": []}, "to start from"),
    ({"nodes": [{"id": "a", "kind": "agent"}], "edges": [{"from": "a", "to": "a", "when": "always"}], "start": ["a"]}, "for ever"),
])
def test_what_cannot_be_a_team(graph, says):
    with pytest.raises(ValueError, match=says):
        check_graph(graph)


def test_every_template_is_a_valid_graph():
    for key, tpl in TEMPLATES.items():
        check_graph(tpl["graph"], needs_check=tpl["check"])


def test_the_log_parser():
    text = "x\n@TURN who=executor round=1\nline one\n@END at=1\n@TURN who=REVIEWER round=1 status=ok\nfine\n@END\n@TURN who=X\nopen"
    got = parse_turns(text)
    assert [(t.who, t.status, t.done) for t in got] == [("EXECUTOR", "", True), ("REVIEWER", "OK", True), ("X", "", False)]
    assert got[0].body == "line one"


def test_what_a_folder_and_a_goal_suggest(tmp_path):
    (tmp_path / "Cargo.toml").write_text("[package]\n")
    (tmp_path / "benchmarks").mkdir()
    (tmp_path / "benchmarks" / "run_benchmarks.sh").write_text("#!/bin/sh\n")
    assert suggest_check(str(tmp_path))[:2] == ["cargo test --release", "cargo test --release && ./benchmarks/run_benchmarks.sh --quick"]
    assert suggest_template("rendi cgdist più veloce") == "optimise"
    assert suggest_template("prova due idee in parallelo per velocizzarlo") == "tournament"
    assert suggest_template("fix the crash on empty input") == "fix"
    assert suggest_template("aggiungi l'export in CSV") == "feature"
    assert suggest_template("scrivi la bozza del paper") == "write"
    assert suggest_template("tidy the module") == "review"


# ------------------------------------------------------------------ the check, for real

@pytest.mark.skipif(not HAS_TMUX, reason="needs tmux")
@pytest.mark.parametrize("command, code", [("echo all good", 0), ("echo broken; exit 3", 3)])
def test_the_check_runs_in_its_own_session_and_its_exit_code_is_the_commands(tmp_path, command, code):
    """`$?` after a pipe is the pipe's last command — `tee`, always 0 — so a failing check would
    have passed. The code must be the command's, whatever the shell."""
    from app.main import TeamIO
    from app.tmux import Socket

    name = f"argus-t-teams-{os.getpid()}-{code}"
    sock = Socket.new(name)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    try:
        io = TeamIO(types.SimpleNamespace(state=types.SimpleNamespace(socket=sock)))
        log, exit_file = tmp_path / "check.log", tmp_path / "check.exit"
        io.run_check({"name": "t"}, command, str(tmp_path), log, exit_file, "t-check")
        for _ in range(100):
            if exit_file.exists() and exit_file.read_text().strip():
                break
            _time.sleep(0.1)
        assert int(exit_file.read_text().split()[0]) == code
        _time.sleep(0.3)
        assert ("all good" if code == 0 else "broken") in log.read_text()
    finally:
        subprocess.run(["tmux", "-L", name, "kill-server"], env=env, capture_output=True)


# ------------------------------------------------------------------ whole teams, through the API

ANSWERS = r'''#!/usr/bin/env python3
# A stand-in agent: reads what it is sent, and when a prompt arrives, does what it says about the
# log — appends its turn with the heredoc it was given — and an executor makes a change to check.
import os, re, sys
verdict = os.environ.get("VERDICT", "DONE")
buf = []
for line in sys.stdin:
    buf.append(line)
    if line.strip() != "ARGUS_TURN":
        continue
    text = "".join(buf)
    buf = []
    m = re.search(r"cat >> (\S+) <<'ARGUS_TURN'\n(.*?)\nARGUS_TURN", text, re.S)
    if not m:
        continue
    body = m.group(2).replace("<OK|REDO|DONE|BLOCKED>", verdict).replace("<what you did, in a few lines>", "did my part")
    if "who=EXECUTOR" in body:
        open("made-by-executor", "a").write("x\n")
    with open(m.group(1), "a") as f:
        f.write("\n" + body + "\n")
'''


def api_app(tmp_path, agent):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    name = f"argus-t-team-{os.getpid()}-{tmp_path.name[-6:]}"
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.allow_write = True
    cfg.tmux_socket = name
    cfg.launchers = [{"name": "Stand-in", "command": f"VERDICT=DONE {agent}"}]
    app = create_app(cfg)
    app.state.teams.home = tmp_path / "teams"
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    return app, c, name


def run_until_settled(app, team_id, seconds=40):
    for _ in range(int(seconds / 0.2)):
        app.state.teams.tick()
        if app.state.teams.teams[team_id]["status"] in ("done", "stopped", "waiting-you"):
            break
        _time.sleep(0.2)
    return app.state.teams.teams[team_id]


@pytest.mark.skipif(not HAS_TMUX, reason="needs tmux")
def test_a_whole_optimise_team_through_the_api(tmp_path, monkeypatch):
    agent = tmp_path / "agent"
    agent.write_text(ANSWERS)
    agent.chmod(0o755)
    project = tmp_path / "project"
    project.mkdir()
    app, c, name = api_app(tmp_path, agent)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    monkeypatch.setattr("app.launch.wait_until_settled", lambda *a, **k: True)
    try:
        r = c.post("/api/teams", json={
            "name": "speed", "goal": "make it faster", "template": "optimise", "path": str(project),
            "agents": {"executor": {"launcher": "Stand-in", "worktree": False}, "reviewer": {"launcher": "Stand-in"}},
            "check": "test -f made-by-executor", "gate": "goal", "max_rounds": 3})
        assert r.status_code == 200, r.text
        said = r.json()
        assert said["sessions"] == {"executor": "speed-executor", "reviewer": "speed-reviewer", "check": "speed-check"}
        team = run_until_settled(app, said["team"]["id"])
        assert team["status"] == "done", team["history"]
        log = (project / "TEAM.argus.md").read_text()
        assert "who=EXECUTOR" in log and "who=CHECK" in log and "status=PASS" in log and "status=DONE" in log
        listed = c.get("/api/teams").json()
        assert listed["teams"][0]["status"] == "done" and "tournament" in listed["templates"]
    finally:
        subprocess.run(["tmux", "-L", name, "kill-server"], env=env, capture_output=True)


@pytest.mark.skipif(not (HAS_TMUX and shutil.which("git")), reason="needs tmux and git")
def test_a_tournament_through_the_api_two_worktrees_two_checks_one_reviewer(tmp_path, monkeypatch):
    agent = tmp_path / "agent"
    agent.write_text(ANSWERS)
    agent.chmod(0o755)
    project = tmp_path / "project"
    project.mkdir()
    git = lambda *a: subprocess.run(["git", "-C", str(project), *a], capture_output=True, text=True, check=True)
    git("init", "-q")
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "start")
    app, c, name = api_app(tmp_path, agent)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    monkeypatch.setattr("app.launch.wait_until_settled", lambda *a, **k: True)
    try:
        r = c.post("/api/teams", json={
            "name": "race", "goal": "two ideas to make it faster", "template": "tournament", "path": str(project),
            "agents": {n: {"launcher": "Stand-in"} for n in ("planner", "executor-a", "executor-b", "reviewer")},
            "check": "test -f made-by-executor", "gate": "goal", "max_rounds": 3})
        assert r.status_code == 200, r.text
        said = r.json()
        assert set(said["worktrees"]) == {"executor-a", "executor-b"}, "each executor in its own copy"
        assert said["worktrees"]["executor-a"] != said["worktrees"]["executor-b"]
        team = run_until_settled(app, said["team"]["id"], seconds=60)
        assert team["status"] == "done", team["history"]
        for w in said["worktrees"].values():
            assert (Path(w) / "made-by-executor").exists(), "each executor worked in its own copy"
        log = (project / "TEAM.argus.md").read_text()
        assert "who=CHECK-A" in log and "who=CHECK-B" in log and "who=REVIEWER" in log
    finally:
        subprocess.run(["tmux", "-L", name, "kill-server"], env=env, capture_output=True)


def test_a_team_is_not_for_an_agents_key_nor_a_read_only_server(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.agents = [{"name": "in-session", "token": "a" * 64}]
    app = create_app(cfg)
    c = TestClient(app)
    body = {"template": "review", "path": str(tmp_path), "goal": "x"}
    assert c.post("/api/teams", json=body, headers={"authorization": "Bearer " + "a" * 64}).status_code == 403
    assert c.post("/api/teams", json=body, headers={"authorization": "Bearer " + "m" * 64}).status_code == 403

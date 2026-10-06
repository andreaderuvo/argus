"""The team director, as a state machine: no tmux, no agents.

The test plays the agents — it appends their turns to the log the way the prompt tells them to —
and the check, by writing its exit code. What is asserted is what the director does in reply:
whom it prompts, when it runs the check, when it stops, and what it asks the person.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app import teams
from app.teams import Director, parse_turns, suggest_check, suggest_template, turn_text


class FakeIO:
    def __init__(self):
        self.sent: list[tuple[str, str]] = []
        self.checks: list[tuple] = []
        self.rings: list[tuple] = []
        self.states: dict[str, tuple] = {}
        self.clock = 1000.0

    def send(self, session, text):
        self.sent.append((session, text))

    def state(self, session):
        return self.states.get(session)

    def run_check(self, team, command, folder, log, exit_file):
        self.checks.append((command, folder, Path(log), Path(exit_file)))

    def ring(self, why, text, session):
        self.rings.append((why, text))

    def now(self):
        return self.clock


@pytest.fixture
def setup(tmp_path):
    io = FakeIO()
    d = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    return d, io, tmp_path


def turn(team, who, body="did it", **fields):
    with open(team["log"], "a") as f:
        f.write(turn_text(who, body, round=team["round"], **fields))


def check_exits(io, code, output="ok"):
    _cmd, _folder, log, exit_file = io.checks[-1]
    log.write_text(output)
    exit_file.write_text(f"{code}\n")


def optimise(d, tmp_path, gate="goal", rounds=5):
    return d.create(name="faster", goal="make it faster without changing results", template="optimise",
                    folder=str(tmp_path), roles={"executor": "exe", "reviewer": "rev"},
                    check="cargo test --release", gate=gate, max_rounds=rounds)


def test_an_optimise_round_goes_executor_check_reviewer_and_on(setup):
    d, io, tmp = setup
    team = optimise(d, tmp)
    assert io.sent[-1][0] == "exe" and "make it faster" in io.sent[-1][1]
    assert "cat >>" in io.sent[-1][1] and "TEAM.argus.md" in io.sent[-1][1], "the prompt says how to answer"
    turn(team, "EXECUTOR", "vectorised the inner loop")
    d.tick()
    assert io.checks and io.checks[-1][0] == "cargo test --release", "after the executor: the check"
    check_exits(io, 0, "test result: ok. 48 passed\nbench: 1.51s")
    d.tick()
    assert io.sent[-1][0] == "rev", "after a passing check: the reviewer"
    assert "status=<OK|REDO|DONE|BLOCKED>" in io.sent[-1][1], "the judge is asked for a verdict"
    log = Path(team["log"]).read_text()
    assert "who=CHECK" in log and "status=PASS" in log and "48 passed" in log, "the check's result is in the log"
    turn(team, "REVIEWER", "good, now the allocations", status="OK")
    d.tick()
    assert team["round"] == 2 and io.sent[-1][0] == "exe", "round two, back to the executor"


def test_a_failing_check_goes_back_to_the_executor_without_a_review(setup):
    d, io, tmp = setup
    team = optimise(d, tmp)
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, 101, "test cgdist::distance ... FAILED")
    d.tick()
    assert io.sent[-1][0] == "exe" and team["round"] == 2
    assert "FAILED" in io.sent[-1][1], "and is told the check failed"
    assert not any(s == "rev" for s, _ in io.sent)


def test_two_failed_checks_in_a_row_stop_and_ask_the_person(setup):
    d, io, tmp = setup
    team = optimise(d, tmp, gate="auto")
    for _ in range(2):
        turn(team, "EXECUTOR")
        d.tick()
        check_exits(io, 1)
        d.tick()
    assert team["status"] == "waiting-you" and io.rings and "failed twice" in io.rings[-1][1]


def test_done_from_the_judge_ends_the_team(setup):
    d, io, tmp = setup
    team = optimise(d, tmp)
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, 0)
    d.tick()
    turn(team, "REVIEWER", "31% faster, results identical", status="DONE")
    d.tick()
    assert team["status"] == "done" and io.rings[-1][0] == "done"
    assert "status=STOP" in Path(team["log"]).read_text()
    sent = len(io.sent)
    d.tick()
    assert len(io.sent) == sent, "a finished team sends nothing more"


def test_the_ask_gate_waits_for_a_press_at_the_end_of_each_round(setup):
    d, io, tmp = setup
    team = optimise(d, tmp, gate="ask")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, 0)
    d.tick()
    turn(team, "REVIEWER", status="OK")
    d.tick()
    assert team["phase"] == "gate" and io.rings[-1][0] == "asking"
    sent = len(io.sent)
    d.tick()
    assert len(io.sent) == sent, "nothing moves at a gate"
    d.go(team["id"])
    assert io.sent[-1][0] == "exe" and team["round"] == 2


def test_rounds_run_out(setup):
    d, io, tmp = setup
    team = d.create(name="r", goal="review it", template="review", folder=str(tmp),
                    roles={"executor": "exe", "reviewer": "rev"}, gate="goal", max_rounds=2)
    for _ in range(2):
        turn(team, "EXECUTOR")
        d.tick()
        turn(team, "REVIEWER", status="REDO")
        d.tick()
    assert team["status"] == "done" and "rounds used" in team["history"][-1]["what"]


def test_blocked_asks_the_person(setup):
    d, io, tmp = setup
    team = d.create(name="r", goal="review it", template="review", folder=str(tmp),
                    roles={"executor": "exe", "reviewer": "rev"}, gate="goal")
    turn(team, "EXECUTOR")
    d.tick()
    turn(team, "REVIEWER", "which licence?", status="BLOCKED")
    d.tick()
    assert team["status"] == "waiting-you"


def test_a_fix_team_ends_when_the_check_passes(setup):
    d, io, tmp = setup
    team = d.create(name="fix", goal="fix the crash on empty input", template="fix", folder=str(tmp),
                    roles={"executor": "exe"}, check="pytest -q tests/test_empty.py", gate="goal")
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, 1)
    d.tick()
    assert team["round"] == 2 and io.sent[-1][0] == "exe"
    turn(team, "EXECUTOR")
    d.tick()
    check_exits(io, 0)
    d.tick()
    assert team["status"] == "done"


def test_an_agent_that_stops_without_writing_its_turn_is_reminded_then_the_person_is_asked(setup):
    d, io, tmp = setup
    team = optimise(d, tmp)
    io.states["exe"] = ("waiting", io.clock)
    io.clock += teams.NUDGE_AFTER + 1
    d.tick()
    assert io.sent[-1][0] == "exe" and "without writing your turn" in io.sent[-1][1]
    io.clock += teams.GIVE_UP_AFTER
    d.tick()
    assert team["status"] == "waiting-you" and "has not written its turn" in io.rings[-1][1]


def test_pause_lets_the_turn_finish_and_starts_nothing_until_go(setup):
    d, io, tmp = setup
    team = d.create(name="r", goal="review it", template="review", folder=str(tmp),
                    roles={"executor": "exe", "reviewer": "rev"}, gate="goal")
    d.pause(team["id"])
    turn(team, "EXECUTOR")
    d.tick()
    assert team["phase"] == "gate" and not any(s == "rev" for s, _ in io.sent), "recorded, not passed on"
    d.go(team["id"])
    assert io.sent[-1][0] == "rev"


def test_a_turn_still_being_written_is_not_taken(setup):
    d, io, tmp = setup
    team = optimise(d, tmp)
    with open(team["log"], "a") as f:
        f.write("\n@TURN who=EXECUTOR round=1\nhalf way\n")
    d.tick()
    assert not io.checks


def test_it_survives_a_restart(setup, tmp_path):
    d, io, tmp = setup
    team = optimise(d, tmp)
    again = Director(tmp_path / "teams.json", io, home=tmp_path / "teams")
    assert again.teams[team["id"]]["phase"] == "working"
    turn(again.teams[team["id"]], "EXECUTOR")
    again.tick()
    assert io.checks


def test_what_cannot_be_a_team(setup):
    d, io, tmp = setup
    with pytest.raises(ValueError, match="needs a check"):
        d.create(name="x", goal="g", template="optimise", folder=str(tmp), roles={"executor": "a", "reviewer": "b"})
    with pytest.raises(ValueError, match="no agent for"):
        d.create(name="x", goal="g", template="review", folder=str(tmp), roles={"executor": "a"})
    with pytest.raises(ValueError, match="goal"):
        d.create(name="x", goal=" ", template="review", folder=str(tmp), roles={"executor": "a", "reviewer": "b"})


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
    assert suggest_template("fix the crash on empty input") == "fix"
    assert suggest_template("scrivi la bozza del paper") == "write"
    assert suggest_template("add a CSV export") == "review"


# ------------------------------------------------------------------ the check, for real

import os
import shutil
import subprocess
import time as _time
import types

HAS_TMUX = shutil.which("tmux") is not None


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
        io.run_check({"check_session": "t-check"}, command, str(tmp_path), log, exit_file)
        for _ in range(100):
            if exit_file.exists() and exit_file.read_text().strip():
                break
            _time.sleep(0.1)
        assert int(exit_file.read_text().split()[0]) == code
        _time.sleep(0.3)
        assert ("all good" if code == 0 else "broken") in log.read_text()
    finally:
        subprocess.run(["tmux", "-L", name, "kill-server"], env=env, capture_output=True)


# ------------------------------------------------------------------ a whole team, through the API

ANSWERS = r'''#!/usr/bin/env python3
# A stand-in agent: reads what it is sent, and when a prompt arrives, does what it says about the
# log — appends its turn with the heredoc it was given — and makes a change worth checking.
import os, re, subprocess, sys
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


@pytest.mark.skipif(not HAS_TMUX, reason="needs tmux")
def test_a_whole_optimise_team_through_the_api(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    agent = tmp_path / "agent"
    agent.write_text(ANSWERS)
    agent.chmod(0o755)
    project = tmp_path / "project"
    project.mkdir()
    name = f"argus-t-team-{os.getpid()}"
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    cfg = Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0")
    cfg.allow_write = True
    cfg.tmux_socket = name
    cfg.launchers = [{"name": "Stand-in", "command": f"VERDICT=DONE {agent}"}]
    app = create_app(cfg)
    app.state.teams.home = tmp_path / "teams"
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    monkeypatch.setattr("app.launch.wait_until_settled", lambda *a, **k: True)
    try:
        r = c.post("/api/teams", json={
            "name": "speed", "goal": "make it faster", "template": "optimise", "path": str(project),
            "roles": {"executor": {"launcher": "Stand-in"}, "reviewer": {"launcher": "Stand-in"}},
            "check": "test -f made-by-executor", "gate": "goal", "max_rounds": 3})
        assert r.status_code == 200, r.text
        said = r.json()
        assert said["sessions"] == {"executor": "speed-executor", "reviewer": "speed-reviewer"}
        team_id = said["team"]["id"]
        for _ in range(150):
            app.state.teams.tick()
            if app.state.teams.teams[team_id]["status"] in ("done", "stopped", "waiting-you"):
                break
            _time.sleep(0.2)
        team = app.state.teams.teams[team_id]
        assert team["status"] == "done", team["history"]
        log = (project / "TEAM.argus.md").read_text()
        assert "who=EXECUTOR" in log and "who=CHECK" in log and "status=PASS" in log and "status=DONE" in log
        assert (project / "made-by-executor").exists(), "the executor worked in the project"
        listed = c.get("/api/teams").json()
        assert listed["teams"][0]["status"] == "done" and "optimise" in listed["templates"]
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
    body = {"template": "review", "path": str(tmp_path), "goal": "x", "roles": {}}
    assert c.post("/api/teams", json=body, headers={"authorization": "Bearer " + "a" * 64}).status_code == 403
    assert c.post("/api/teams", json=body, headers={"authorization": "Bearer " + "m" * 64}).status_code == 403

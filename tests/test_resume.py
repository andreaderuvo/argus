"""Bringing agents back after their tmux server has gone.

The rule under test is the one that keeps this from being a nuisance: lost means *the server
went away*, not *the session is not there*. A session closed on a server that is still up was
closed on purpose and must never be offered back. Then: the command that is rebuilt carries the
conversation and the flags and nothing else, and a real tmux server on a socket of its own
(never the default one) is killed and its agent brought back.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time

import pytest
from fastapi.testclient import TestClient

from app import resume
from app.resume import Ledger, command_for, flags_of
from app.tmux import Socket

HAS_TMUX = shutil.which("tmux") is not None
CONV = "0123abcd-1111-2222-3333-444455556666"


def rec(agent="claude", cwd="/srv/api", conversation=CONV, flags=()):
    return {"agent": agent, "cwd": cwd, "flags": list(flags), "conversation": conversation, "seen": time.time()}


# ------------------------------------------------------------------ what counts as lost

def test_a_session_closed_on_a_server_still_up_is_not_lost(tmp_path):
    led = Ledger(tmp_path / "seen.json")
    led.observe("100:1", "boot-a", {"api": rec(), "docs": rec()}, {"api", "docs"})
    found = led.observe("100:1", "boot-a", {"api": rec()}, {"api"})      # someone typed exit in docs
    assert found == [] and led.lost() == []
    assert "docs" not in led.data["sessions"]


def test_everything_a_dead_server_held_is_lost(tmp_path):
    led = Ledger(tmp_path / "seen.json")
    led.observe("100:1", "boot-a", {"api": rec(), "docs": rec(agent="codex")}, {"api", "docs", "shell"})
    found = led.observe(None, "boot-b", {}, set())                      # rebooted; no tmux yet
    assert sorted(found) == ["api", "docs"], "a plain shell held no agent, so nothing to bring back"
    assert {x["name"] for x in led.lost()} == {"api", "docs"}
    # And it is on disk: the reason to keep a register at all is surviving the reboot.
    assert {x["name"] for x in Ledger(tmp_path / "seen.json").lost()} == {"api", "docs"}


def test_a_new_server_counts_as_the_old_one_gone(tmp_path):
    led = Ledger(None)
    led.observe("100:1", "b", {"api": rec()}, {"api"})
    assert led.observe("200:9", "b", {}, {"other"}) == ["api"]


def test_a_lost_session_that_is_running_again_is_not_offered(tmp_path):
    led = Ledger(None)
    led.observe("100:1", "b", {"api": rec()}, {"api"})
    led.observe(None, "b", {}, set())
    led.observe("200:9", "b", {"api": rec()}, {"api"})                  # brought back by hand
    assert led.lost() == []


def test_a_conversation_once_known_is_not_forgotten_between_readings():
    led = Ledger(None)
    led.observe("1:1", "b", {"api": rec()}, {"api"})
    led.observe("1:1", "b", {"api": rec(conversation=None)}, {"api"})
    assert led.data["sessions"]["api"]["conversation"] == CONV


def test_forgetting(tmp_path):
    led = Ledger(None)
    led.observe("1:1", "b", {"api": rec()}, {"api"})
    led.observe(None, "b", {}, set())
    assert led.forget(["api", "nope"]) == ["api"] and led.lost() == []


# ------------------------------------------------------------------ the command it rebuilds

def test_claude_comes_back_in_its_conversation_with_its_flags():
    line, how = command_for(rec(flags=["--dangerously-skip-permissions", "--model", "opus"]))
    assert how == "resume"
    assert line == f"claude --resume {CONV} --dangerously-skip-permissions --model opus"


def test_codex_comes_back_in_its_conversation():
    assert command_for(rec(agent="codex", flags=["--full-auto"])) == (f"codex resume --full-auto {CONV}", "resume")


def test_an_unknown_conversation_is_a_new_one_and_says_so():
    assert command_for(rec(conversation=None)) == ("claude", "fresh")
    assert command_for(rec(agent="gemini", conversation=None)) == ("gemini", "fresh")


def test_only_flags_worth_keeping_survive():
    old = ["--continue", "--dangerously-skip-permissions", "-p", "write the report", "--resume", "x", "--model=sonnet"]
    assert flags_of("claude", old) == ["--dangerously-skip-permissions", "--model=sonnet"]


def test_a_recorded_line_cannot_smuggle_a_command():
    assert command_for(rec(conversation="x; rm -rf ~"))[1] == "fresh"
    with pytest.raises(ValueError):
        command_for(rec(agent="claude; reboot"))
    line, _ = command_for(rec(flags=["--model", "a b;c"]))
    assert "'a b;c'" in line


# ------------------------------------------------------------------ the API

@pytest.fixture
def client(tmp_path):
    from app.config import Config
    from app.main import create_app

    app = create_app(Config(token="m" * 64, roots=[tmp_path], listen="127.0.0.1:0"))
    c = TestClient(app)
    c.headers.update({"authorization": "Bearer " + "m" * 64})
    c.app_ = app
    return c


def test_only_a_name_on_the_lost_list_can_be_brought_back(client):
    said = client.post("/api/resume", json={"names": ["anything"]}).json()
    assert said["started"] == [] and said["skipped"][0]["why"] == "not on the lost list"
    assert client.post("/api/resume", json={"names": "x"}).status_code == 400


def test_a_hook_tells_the_server_which_conversation(client):
    client.post("/api/bell", json={"session": "api", "why": "done", "conversation": CONV.upper()})
    client.post("/api/bell", json={"session": "docs", "why": "done", "conversation": "not-a-uuid"})
    told = client.app_.state.bells["conversations"]
    assert told == {"api": CONV}


# ------------------------------------------------------------------ against a real tmux server

FAKE = """#!/usr/bin/env python3
import time
time.sleep(600)
"""


@pytest.mark.skipif(not HAS_TMUX, reason="needs tmux")
def test_a_killed_server_and_its_agent_brought_back(tmp_path, client):
    agent = tmp_path / "claude"
    agent.write_text(FAKE)
    agent.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    name = f"argus-t-resume-{os.getpid()}"
    assert name.startswith("argus-t-")
    sock = Socket.new(name)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    tm = lambda *a: subprocess.run(["tmux", "-L", name, *a], env=env, capture_output=True, text=True)
    led = Ledger(tmp_path / "seen.json")
    try:
        tm("-f", "/dev/null", "new-session", "-d", "-s", "api", "-c", str(work), "-x", "80", "-y", "20",
           f"{agent} --dangerously-skip-permissions")
        tm("new-session", "-d", "-s", "plain", "-x", "80", "-y", "20")
        # The agent is seen once its process is there under the pane: a moment after new-session.
        for _ in range(50):
            answered, server, now, alive = resume.read_now(sock, frozenset({"claude"}), {"api": CONV})
            if "api" in now:
                break
            time.sleep(0.1)
        assert answered and server and alive == {"api", "plain"}
        assert now["api"]["cwd"] == str(work) and now["api"]["conversation"] == CONV
        assert now["api"]["flags"] == ["--dangerously-skip-permissions"]
        led.observe(server, "b", now, alive)

        tm("kill-server")
        answered, server, now, alive = resume.read_now(sock, frozenset({"claude"}), {})
        assert answered and server is None, "a server that is not there answers, and says so"
        assert led.observe(server, "b", now, alive) == ["api"]

        # Bring it back through the API, on this socket.
        client.app_.state.socket = sock
        client.app_.state.resume = led
        said = client.post("/api/resume", json={"names": ["api"]}).json()
        assert said["started"] == [{"name": "api", "how": "resume"}], said
        started = tm("list-panes", "-t", "api", "-F", "#{pane_start_command}\t#{pane_current_path}").stdout
        assert f"claude --resume {CONV} --dangerously-skip-permissions" in started
        assert str(work) in started
        assert said["lost"] == []
    finally:
        tm("kill-server")


def test_an_agent_restarted_keeps_its_session_folder_and_conversation(tmp_path, client):
    """'Restart an agent without losing the past, on the updated version' (2026-11-02): the process in
    the pane ends and `claude --resume <id>` starts in its place — same session, same folder."""
    import types
    from app import bells
    agent = tmp_path / "claude"
    agent.write_text(FAKE)
    agent.chmod(0o755)
    work = tmp_path / "work"
    work.mkdir()
    name = f"argus-t-restart-{os.getpid()}"
    sock = Socket.new(name)
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    tm = lambda *a: subprocess.run(["tmux", "-L", name, *a], env=env, capture_output=True, text=True)
    try:
        tm("-f", "/dev/null", "new-session", "-d", "-s", "api", "-c", str(work), "-x", "80", "-y", "20",
           f"{agent} --dangerously-skip-permissions")
        tm("new-session", "-d", "-s", "plain", "-x", "80", "-y", "20")
        app = client.app_
        app.state.socket = sock
        app.state.agents.names = frozenset({"claude"})
        before = tm("list-panes", "-t", "api", "-F", "#{pane_pid}").stdout.strip()

        # Which conversation is not known yet: asked, not done.
        said = client.post("/api/tmux/restart-agent", json={"session": "api"}).json()
        assert said["ask"] == "fresh" and said["command"].startswith("claude ")
        assert tm("list-panes", "-t", "api", "-F", "#{pane_pid}").stdout.strip() == before, "nothing restarted"

        bells.store(types.SimpleNamespace(app=app))["conversations"]["api"] = CONV
        import time as _t
        app.state.__dict__["stale_agents"] = [_t.monotonic(), {"api": "claude", "other": "codex"}]     # read as old a moment ago
        said = client.post("/api/tmux/restart-agent", json={"session": "api"}).json()
        assert said["restarted"] == "api" and said["how"] == "resume", said
        # Off the old ones at once — the badge came back until the list's next reading (2026-11-23).
        assert app.state.__dict__["stale_agents"][1] == {"other": "codex"}
        started = tm("list-panes", "-t", "api", "-F", "#{pane_start_command}\t#{pane_current_path}\t#{pane_pid}").stdout
        assert f"claude --resume {CONV} --dangerously-skip-permissions" in started, started
        assert str(work) in started and before not in started.split("\t")[-1], "a new process, in the same folder"
        assert set(tm("list-sessions", "-F", "#{session_name}").stdout.split()) == {"api", "plain"}, "the same session"

        assert client.post("/api/tmux/restart-agent", json={"session": "plain"}).status_code == 400, "no agent there"
        assert client.post("/api/tmux/restart-agent", json={"session": "nope"}).status_code == 404
    finally:
        tm("kill-server")


def test_a_reading_older_than_a_bring_back_does_not_lose_it_again(tmp_path):
    """The register reads tmux in a thread; a reading begun while the server was down, folded in
    after Bring back, called the session it had just brought back lost again (CI, 2026-11-02)."""
    led = Ledger(tmp_path / "seen.json")
    led.observe("srv-1", "b", {"api": {"agent": "claude", "cwd": "/w", "conversation": CONV, "seen": 1.0}}, {"api"}, read_at=0.5)
    began = time.time()
    led.observe(None, "b", {}, set(), read_at=began - 1)       # the server is down: api is lost
    assert [x["name"] for x in led.lost()] == ["api"]
    # Brought back, as /api/resume does it: off the lost list, on the register, seen now.
    rec = led.data["lost"].pop("api")
    led.data["sessions"]["api"] = {**rec, "seen": time.time()}
    led.observe(None, "b", {}, set(), read_at=began)           # a reading begun before that
    assert led.lost() == [], "not lost again"
    led.observe("srv-2", "b", {"api": {**rec, "seen": time.time()}}, {"api"}, read_at=time.time())
    assert led.lost() == [] and "api" in led.data["sessions"]


def test_claude_says_its_conversation_in_its_own_file(tmp_path):
    """~/.claude/sessions/<pid>.json names the conversation with no hook at all ("which conversation it is in is
    not known", 2026-11-19); only for the process that started when the file says, never a recycled pid."""
    import json as _json
    from app.resume import claude_conversation
    pid = os.getpid()
    start = open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[19]
    sessions = tmp_path / ".claude" / "sessions"
    sessions.mkdir(parents=True)
    conv = "1a8bfd12-26d1-4c32-8488-4b6300216cc5"
    (sessions / f"{pid}.json").write_text(_json.dumps({"pid": pid, "sessionId": conv, "procStart": start}))
    assert claude_conversation(pid, str(tmp_path)) == conv
    (sessions / f"{pid}.json").write_text(_json.dumps({"pid": pid, "sessionId": conv, "procStart": "1"}))
    assert claude_conversation(pid, str(tmp_path)) is None, "another process with the same pid"
    (sessions / f"{pid}.json").write_text(_json.dumps({"pid": pid, "sessionId": "not-an-id"}))
    assert claude_conversation(pid, str(tmp_path)) is None
    assert claude_conversation(pid + 999999, str(tmp_path)) is None


def test_a_codex_is_matched_to_the_rollout_it_began_when_it_started(tmp_path):
    """Codex holds no file open between turns: its conversation is the rollout named after the second it started,
    in its folder (2026-11-23: a Codex shown as "not known", another given a neighbour's id by the hooks)."""
    import datetime
    from app.resume import codex_started
    pid = os.getpid()
    ticks = int(open(f"/proc/{pid}/stat").read().rsplit(")", 1)[1].split()[19])
    boot = next(float(l.split()[1]) for l in open("/proc/stat") if l.startswith("btime "))
    began = datetime.datetime.fromtimestamp(boot + ticks / os.sysconf("SC_CLK_TCK"))
    folder = tmp_path / ".codex" / "sessions" / f"{began:%Y/%m/%d}"
    folder.mkdir(parents=True)
    mine, other, elsewhere = ("01a110bb-7bba-70d1-b8c9-dbc206f2c3fd", "01a0fba6-5b7a-77d2-9a1d-89e9db8af575",
                              "01a1f2fd-569c-7951-b6ba-43eeb9a40c82")
    def rollout(at, uuid, cwd):
        (folder / f"rollout-{at:%Y-%m-%dT%H-%M-%S}-{uuid}.jsonl").write_text(
            '{"type":"session_meta","payload":{"id":"%s","cwd":"%s"}}\n' % (uuid, cwd))
    rollout(began + datetime.timedelta(seconds=1), mine, "/work/paper")
    rollout(began + datetime.timedelta(minutes=5), other, "/work/paper")        # begun later: another Codex
    rollout(began, elsewhere, "/work/elsewhere")                                # same second, another folder
    assert codex_started(pid, "/work/paper", str(tmp_path)) == mine
    assert codex_started(pid, "/work/nowhere", str(tmp_path)) is None

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
        answered, server, now, alive = resume.read_now(sock, frozenset({"claude"}), {"api": CONV})
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

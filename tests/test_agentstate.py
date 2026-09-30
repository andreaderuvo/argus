"""Working or waiting, worked out without a hook.

The rules are pure functions and tested as such; then the sampler is run against a real tmux
server on a socket of its own (never the default one), with two fake agents: one that keeps
drawing like a spinner, and one that says something and goes quiet like an agent waiting for
you. No test reads a pane's screen.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time

import pytest

from app import agentstate
from app.agentstate import Watch, agent_in, agent_under, decide, launcher_words, moving, parse_ps
from app.tmux import Socket

HAS_TMUX = shutil.which("tmux") is not None
NAMES = agentstate.KNOWN


# ------------------------------------------------------------------ which process is an agent

def test_an_agent_is_known_by_its_program_or_by_what_an_interpreter_runs():
    assert agent_in(["/home/me/.local/bin/claude"], NAMES) == "claude"
    assert agent_in(["codex", "--full-auto"], NAMES) == "codex"
    assert agent_in(["node", "/usr/lib/node_modules/@google/gemini-cli/bin/gemini"], NAMES) == "gemini"
    assert agent_in(["python3", "/opt/aider/aider.py"], NAMES) == "aider"
    assert agent_in(["node", "/srv/app/server.js"], NAMES) is None
    assert agent_in(["bash"], NAMES) is None
    assert agent_in([], NAMES) is None


def test_your_launchers_count_as_agents_too():
    words = launcher_words(["conda activate review && my-agent --model opus", "claude", "", "sudo -E thing"])
    assert "my-agent" in words and "claude" in words and "thing" in words
    assert not words & {"conda", "sudo", "bash"}, "a wrapper is not the agent"


def test_the_agent_is_found_anywhere_under_the_pane():
    tree = parse_ps("  10     1 -bash\n  11    10 /bin/sh -c claude\n  12    11 /usr/bin/claude\n"
                    "  20     1 -bash\n  21    20 vim notes.md\nrubbish\n")
    assert agent_under(10, tree, NAMES) == "claude"
    assert agent_under(20, tree, NAMES) is None, "vim in a shell is not an agent"
    assert agent_under(999, tree, NAMES) is None


# ------------------------------------------------------------------ moving or still

def test_a_spinner_is_working_and_one_lone_redraw_is_not():
    assert moving([100, 101, 102, 103]) is True           # advancing every second
    assert moving([100, 100, 101, 101]) is False          # the ten-second redraw of an idle agent
    assert moving([100, 100, 100, 100]) is False
    assert moving([100, 101, 101, 102]) is True


def test_a_window_too_new_for_a_history_goes_by_recency():
    now = 1000.0
    assert decide([999], now) == "working"
    assert decide([990], now) == "waiting"
    assert decide([], now) == "waiting"
    assert decide([990, 991, 992, 993], now) == "working", "a history wins over recency"


# ------------------------------------------------------------------ the sampler's bookkeeping

class Scripted(Watch):
    """A Watch whose tmux readings come from a script instead of a server."""

    def __init__(self, frames, agents):
        super().__init__(Socket.new("argus-t-unused"))
        self.frames, self.fixed_agents = list(frames), agents

    def read_windows(self):
        return self.frames.pop(0)

    def read_agents(self):
        return dict(self.fixed_agents)


def test_states_change_with_the_activity_and_say_since_when():
    frames = [{"@1": ("work", 100 + i), "@2": ("work", 50)} for i in range(5)]   # @1 spinning, @2 still
    frames += [{"@1": ("work", 104), "@2": ("work", 50)} for _ in range(4)]      # @1 stops too
    w = Scripted(frames, {"@1": "claude"})
    for t in range(5):
        w.tick(now=200 + t)
    assert w.states()["work"]["state"] == "working"
    for t in range(5, 9):
        w.tick(now=200 + t)
    got = w.states()["work"]
    assert got == {"agent": "claude", "state": "waiting", "since": got["since"]}
    assert 205 <= got["since"] <= 208, "since is when it changed, not when it was last read"


def test_a_session_is_waiting_if_any_of_its_agents_is():
    frames = [{"@1": ("pair", 100 + i), "@2": ("pair", 80)} for i in range(5)]
    w = Scripted(frames, {"@1": "claude", "@2": "codex"})
    for t in range(5):
        w.tick(now=300 + t)
    assert w.states()["pair"]["state"] == "waiting"


def test_a_session_without_an_agent_has_no_state_and_a_gone_one_is_forgotten():
    w = Scripted([{"@1": ("shell", 100)}] * 3 + [{}], {})
    for t in range(3):
        w.tick(now=400 + t)
    assert w.states() == {}
    w2 = Scripted([{"@1": ("gone", 100 + i)} for i in range(4)] + [{}], {"@1": "claude"})
    for t in range(4):
        w2.tick(now=500 + t)
    assert "gone" in w2.states()
    w2.fixed_agents = {}
    w2.tick(now=505)
    assert w2.states() == {}


# ------------------------------------------------------------------ against real tmux

SPINNER = """#!/usr/bin/env python3
import sys, time
while True:
    for c in '|/-\\\\':
        sys.stdout.write('\\r' + c + ' thinking'); sys.stdout.flush(); time.sleep(0.2)
"""
QUIET = """#!/usr/bin/env python3
import sys, time
print('Which do you want: memory or disk?'); sys.stdout.flush()
time.sleep(600)
"""


@pytest.mark.skipif(not HAS_TMUX, reason="needs tmux")
def test_against_a_real_tmux_a_spinning_agent_works_and_a_quiet_one_waits(tmp_path):
    for name, body in (("claude", SPINNER), ("codex", QUIET)):
        path = tmp_path / name
        path.write_text(body)
        path.chmod(0o755)
    sock_name = f"argus-t-agents-{os.getpid()}"
    assert sock_name.startswith("argus-t-")
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    tm = lambda *a: subprocess.run(["tmux", "-L", sock_name, *a], env=env, capture_output=True, text=True)
    try:
        tm("-f", "/dev/null", "new-session", "-d", "-s", "busy", "-x", "80", "-y", "20", str(tmp_path / "claude"))
        tm("new-session", "-d", "-s", "asking", "-x", "80", "-y", "20", str(tmp_path / "codex"))
        tm("new-session", "-d", "-s", "plain", "-x", "80", "-y", "20")
        watch = Watch(Socket.new(sock_name))
        for _ in range(6):
            watch.tick()
            time.sleep(1.0)
        got = watch.states()
        assert got.get("busy", {}).get("agent") == "claude"
        assert got["busy"]["state"] == "working", got
        assert got.get("asking", {}).get("agent") == "codex"
        assert got["asking"]["state"] == "waiting", got
        assert "plain" not in got, "a bare shell is not an agent"
    finally:
        tm("kill-server")

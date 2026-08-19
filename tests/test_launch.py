"""Starting an agent: the list, the shell line, and the two things that were wrong first.

The tmux tests here drive a **throwaway socket of their own** and never the default one. That
is not tidiness: a crashing tmux server takes every session on its socket down with it, and the
default socket is where somebody's afternoon is.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import time
from dataclasses import dataclass, field

import pytest

from app import launch, tmux

HAS_TMUX = shutil.which("tmux") is not None


@dataclass
class FakeConfig:
    launchers: list = field(default_factory=list)


def test_the_shipped_list_is_what_you_get_when_nothing_is_configured():
    names = [one.name for one in launch.configured(FakeConfig())]
    assert "Claude Code" in names and "A shell" in names


def test_your_list_replaces_it_rather_than_adding_to_it():
    mine = launch.configured(FakeConfig(launchers=[{"name": "Mine", "command": "echo hi"}]))
    assert [one.name for one in mine] == ["Mine"]


def test_a_launcher_without_a_name_is_not_one():
    assert launch.configured(FakeConfig(launchers=[{"command": "echo"}])) == []


def test_named_only_answers_for_names_that_are_there():
    cfg = FakeConfig(launchers=[{"name": "Mine", "command": "echo"}])
    assert launch.named(cfg, "Mine").command == "echo"
    # The whole safety of the endpoint rests on this returning nothing for anything else.
    assert launch.named(cfg, "Mine; rm -rf /") is None
    assert launch.named(cfg, "echo") is None


def test_available_says_true_false_or_it_cannot_tell():
    assert launch.Launcher("sh", "sh").available is True
    assert launch.Launcher("nope", "argus-no-such-binary-anywhere").available is False
    # A shell line is not a program: claiming to have checked the PATH for it would be a guess
    # dressed as a fact, so the answer is "unknown" and the UI leaves it alone.
    assert launch.Launcher("conda", "conda activate x && claude").available is None
    assert launch.Launcher("shell", "").available is True


def test_the_wrapped_line_keeps_the_pane_after_the_agent_exits():
    line = launch.wrap("claude")
    assert line.startswith("claude;")
    # Without this the session dies with the command and takes its own scrollback with it —
    # what you would find is a window marked gone where the answer used to be.
    assert "exec" in line and "SHELL" in line
    assert launch.wrap("   ") is None


def test_quoting_survives_a_command_with_quotes_in_it():
    assert launch.shell_quote("it's") == "'it'\\''s'"


@pytest.mark.parametrize("bad", ["", "-x", "a..b", "with space", "x" * 90, "ends/", "x.lock"])
def test_branch_names_that_git_would_refuse_or_a_shell_would_misread(bad):
    with pytest.raises(ValueError):
        launch.check_branch(bad)


@pytest.mark.parametrize("good", ["feature/one", "fix-2", "a_b.c", "WIP/x/y"])
def test_branch_names_that_are_fine(good):
    assert launch.check_branch(good) == good


# --------------------------------------------------------------- with a real tmux

@pytest.fixture
def sock():
    """A socket nobody else is on, killed afterwards whatever happens."""
    spot = tmux.Socket(f"argus-test-{os.getpid()}")
    yield spot
    subprocess.run(["tmux", *spot.args(), "kill-server"], capture_output=True)


@pytest.mark.skipif(not HAS_TMUX, reason="no tmux here")
def test_a_pane_is_addressed_by_id_and_the_target_that_looks_right_is_not(sock):
    """`=name` is a session target and silently resolves to *nothing* as a pane target.

    This is the bug this test exists for: tmux answers success with an empty line, so a
    readiness check built on it read stillness where it was reading nothing at all, and
    reported ready before the thing had drawn its first character.
    """
    subprocess.run(["tmux", *sock.args(), "new-session", "-d", "-s", "one", "sleep", "30"],
                   check=True, capture_output=True)
    empty = subprocess.run(["tmux", *sock.args(), "display-message", "-p", "-t", "=one", "#{pane_id}"],
                           capture_output=True, text=True)
    assert empty.stdout.strip() == "", "if tmux ever starts accepting =name here, simplify launch.py"
    assert launch.pane_of(sock, "one").startswith("%")
    assert launch._pulse(sock, "one") is not None


@pytest.mark.skipif(not HAS_TMUX, reason="no tmux here")
def test_it_waits_for_a_launcher_that_starts_slowly_and_pauses_in_the_middle(sock, tmp_path):
    """The shape of every agent's startup: say something, think, say something else.

    A stillness window shorter than the thinking pause ends the wait in the middle of the
    starting up, which is precisely when a prompt must not be typed. Measured at 0.8s once:
    it fired during the pause.
    """
    script = tmp_path / "slow"
    script.write_text("#!/bin/sh\nprintf 'banner\\n'\nsleep 1\nprintf 'looking\\n'\n"
                      "sleep 1.2\nprintf '> '\nread x\n")
    script.chmod(0o755)

    launch.start(sock, "slow", str(tmp_path), str(script))
    began = time.monotonic()
    settled = launch.wait_until_settled(sock, "slow", timeout=20)
    took = time.monotonic() - began
    assert settled is True
    # It cannot have settled before the script's last write, which is at about 2.2s of its own
    # life plus however long a login shell takes to start.
    assert took > 2.2, f"settled after {took:.2f}s, which is inside the startup"


@pytest.mark.skipif(not HAS_TMUX, reason="no tmux here")
def test_the_prompt_arrives_exactly_as_written_and_the_return_is_separate(sock, tmp_path):
    """Braces and arrows intact, and the newline only because the return was asked for.

    `{folder}` and `-->` are the two things a prompt is most likely to contain and the two most
    likely to be eaten on the way — by a shell, by an escape, by a double-escape.
    """
    got = tmp_path / "read"
    script = tmp_path / "reader"
    script.write_text(f"#!/bin/sh\nprintf 'ready\\n'\ncat > {got}\n")
    script.chmod(0o755)

    launch.start(sock, "reader", str(tmp_path), str(script))
    assert launch.wait_until_settled(sock, "reader", timeout=20)
    launch.seed(sock, "reader", "review {folder} --> tell me what is wrong", True, pause=0.3)
    for _ in range(40):
        if got.exists() and got.read_text():
            break
        time.sleep(0.15)
    assert got.read_text() == "review {folder} --> tell me what is wrong\n"


@pytest.mark.skipif(not HAS_TMUX, reason="no tmux here")
def test_typing_into_a_session_that_is_not_there_says_so(sock):
    with pytest.raises(tmux.TmuxError):
        launch.seed(sock, "never-existed", "hello", False)

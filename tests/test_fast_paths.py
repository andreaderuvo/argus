"""The server-side costs of the optimisation pass (2026-10-14), held: each of these was measured
slow, and each test fails if it comes back."""

from __future__ import annotations

import shutil

import pytest
import subprocess
import time
from pathlib import Path

from app import system, tmux


@pytest.mark.skipif(not shutil.which("tmux"), reason="needs tmux")
def test_the_session_list_is_one_tmux_call(monkeypatch):
    calls = []
    real = subprocess.run

    def counting(argv, *a, **k):
        if argv and argv[0] == "tmux":
            calls.append(argv)
        return real(argv, *a, **k)

    monkeypatch.setattr(tmux.subprocess, "run", counting)
    tmux.list_sessions(tmux.Socket("argus-test-no-such-server-fast"))
    assert len(calls) == 1, calls
    assert calls[0].count(";") == 2, "sessions, notes and window activity in one invocation"


def test_cpu_percent_does_not_wait_twice(monkeypatch):
    """It used to sleep 120 ms on every reading; now only when there is no recent reading."""
    monkeypatch.setattr(system, "_last_stat", None)
    monkeypatch.setattr(system, "_last_pct", None)
    t = time.monotonic()
    first = system.cpu_now()
    assert time.monotonic() - t >= 0.1, "the first one has to wait for a second reading"
    t = time.monotonic()
    again = system.cpu_now()
    assert time.monotonic() - t < 0.05 and again == first, "the same instant: the same answer, no wait"
    time.sleep(0.15)
    t = time.monotonic()
    system.cpu_now()
    assert time.monotonic() - t < 0.05, "a later one starts from the previous reading"


def test_a_snapshot_reads_the_process_table_once():
    roots = [Path.home()]
    system.snapshot(roots)
    time.sleep(0.15)
    t = time.monotonic()
    system.snapshot(roots)
    assert time.monotonic() - t < 0.1


@pytest.mark.parametrize("stdout,stderr,want", [
    # A session ended between the commands of the one call: tmux answered the first, then failed.
    ("S\twriter\t1\t0\t1700000000\t1700000001\n", "can't find session: checker", ["writer"]),
    # The server holding no session for a moment as it ends.
    ("", "no sessions", []),
    ("", "no server running on /tmp/tmux-1/x", []),
])
def test_a_session_list_caught_mid_change_is_still_a_list(monkeypatch, stdout, stderr, want):
    """Found by CI (2026-10-17): a page counting sessions while a team restarted got a 502."""
    from app import tmux

    monkeypatch.setattr(tmux.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a[0], 1, stdout, stderr))
    assert [s["name"] for s in tmux.list_sessions(tmux.Socket.new("x"))] == want


def test_a_real_failure_is_still_said(monkeypatch):
    from app import tmux

    monkeypatch.setattr(tmux.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a[0], 1, "", "unknown option -- Z"))
    with pytest.raises(tmux.TmuxError):
        tmux.list_sessions(tmux.Socket.new("x"))

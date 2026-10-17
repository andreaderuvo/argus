"""copy_modes: every session's copy mode in one tmux call, on a throwaway socket."""

from __future__ import annotations

import shutil

import pytest
import os
import subprocess
import uuid

from app import tmux


@pytest.mark.skipif(not shutil.which("tmux"), reason="needs tmux")
def test_one_call_answers_for_every_session():
    sock = tmux.Socket(f"argus-test-cm-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    run = lambda *a: subprocess.run(["tmux", *sock.args(), *a], capture_output=True, text=True, timeout=10)  # noqa: E731
    try:
        for name in ("history", "live"):
            assert run("new-session", "-d", "-s", name, "-x", "80", "-y", "24").returncode == 0
        run("send-keys", "-t", "history", "seq 200", "Enter")
        run("copy-mode", "-t", "history")
        said = tmux.copy_modes(sock, ["history", "live", "not-there"])
        assert said["history"]["in_mode"] is True and said["history"].get("gone") is None
        assert said["live"] == {"in_mode": False, "position": 0, "alternate": False}
        assert said["not-there"]["gone"] is True
    finally:
        run("kill-server")


@pytest.mark.skipif(not shutil.which("tmux"), reason="needs tmux")
def test_where_every_session_is_in_one_call(tmp_path):
    from app import paths
    sock = tmux.Socket(f"argus-test-cw-{os.getpid()}-{uuid.uuid4().hex[:6]}")
    run = lambda *a: subprocess.run(["tmux", *sock.args(), *a], capture_output=True, text=True, timeout=10)  # noqa: E731
    (tmp_path / "one").mkdir()
    (tmp_path / "two").mkdir()
    try:
        run("new-session", "-d", "-s", "one", "-c", str(tmp_path / "one"))
        run("new-session", "-d", "-s", "two", "-c", str(tmp_path / "two"))
        many = paths.pane_wheres(sock, ["one", "two", "absent"])
        assert many["absent"] is None
        for name in ("one", "two"):
            single = paths.pane_where(sock, name)
            assert many[name]["cwd"] == single["cwd"] == str(tmp_path / name)
            assert many[name] == single, "the same answer as asking one by one"
    finally:
        run("kill-server")

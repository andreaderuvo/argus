"""copy_modes: every session's copy mode in one tmux call, on a throwaway socket."""

from __future__ import annotations

import os
import subprocess
import uuid

from app import tmux


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

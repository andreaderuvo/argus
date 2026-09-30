"""Labels on processes: a word of your own on what that `java` is.

The one thing that must never happen is a note landing on the wrong process. PIDs are
recycled, so a label is keyed by pid *and* start time, and these tests spend most of their
effort there.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys

import pytest
from fastapi.testclient import TestClient

from app import labels
from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"
H = {"Authorization": f"Bearer {TOKEN}"}


# ------------------------------------------------------------------ identity

def test_the_start_time_is_read_after_the_last_parenthesis():
    """The command name is field 2, in parentheses, and may hold spaces and parentheses of its
    own. Splitting the whole line would read the wrong field for exactly those processes."""
    fields = " ".join(str(n) for n in range(3, 30))          # fields 3..29, value = its number
    assert labels.parse_start(f"123 (python3) {fields}") == 22
    assert labels.parse_start(f"123 (tmux: server) {fields}") == 22
    assert labels.parse_start(f"123 (weird) name)) {fields}") == 22
    assert labels.parse_start("123 (short) R 1 2") is None
    assert labels.parse_start("garbage") is None


def test_a_running_process_has_an_identity_and_a_gone_one_has_none():
    me = labels.identity(os.getpid())
    assert me and me.startswith(f"{os.getpid()}@")
    assert labels.identity(os.getpid()) == me, "stable for the same process"
    assert labels.identity(2 ** 22 + 12345) is None


def test_a_recycled_pid_does_not_inherit_the_label():
    """Same number, different process: the stored start time no longer matches."""
    doc = {"4242@1000": {"label": "old job", "command": "", "at": 0}}
    assert labels.living(doc, alive=lambda pid: "4242@1000") == doc
    assert labels.living(doc, alive=lambda pid: "4242@9999") == {}
    assert labels.living(doc, alive=lambda pid: None) == {}


# ------------------------------------------------------------------ the store

def test_labels_are_one_short_line(tmp_path):
    assert labels.clean_label("  two\nlines\tand\x1b[31m colour ") == "two lines and [31m colour"
    assert len(labels.clean_label("x" * 500)) == labels.MAX_LABEL
    assert labels.clean_label(None) == ""


def test_put_keeps_it_for_that_process_and_an_empty_label_clears_it(tmp_path):
    store = tmp_path / "labels.json"
    assert labels.put(store, os.getpid(), "the test runner", "pytest") == {"pid": os.getpid(), "label": "the test runner"}
    assert labels.by_pid(labels.current(store)) == {os.getpid(): "the test runner"}
    assert oct(store.stat().st_mode & 0o777) == "0o600", "it sits beside the token; same rules"
    labels.put(store, os.getpid(), "")
    assert labels.by_pid(labels.current(store)) == {}


def test_no_label_for_a_process_that_is_not_running(tmp_path):
    assert labels.put(tmp_path / "labels.json", 2 ** 22 + 12345, "ghost") is None
    assert not (tmp_path / "labels.json").exists()


def test_a_label_goes_when_its_process_ends(tmp_path):
    store = tmp_path / "labels.json"
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        labels.put(store, child.pid, "short-lived")
        assert labels.by_pid(labels.current(store)) == {child.pid: "short-lived"}
    finally:
        child.kill()
        child.wait()
    assert labels.by_pid(labels.current(store)) == {}
    assert json.loads(store.read_text()) == {}, "and it is written out of the file, not kept forever"


def test_a_damaged_file_reads_as_no_labels(tmp_path):
    store = tmp_path / "labels.json"
    for text in ("{not json", "[]", '{"nokey": {"label": "x"}}', '{"1@2": "not a dict"}'):
        store.write_text(text)
        assert labels.load(store) == {}


def test_attach_always_gives_a_label_field():
    rows = [{"pid": 7}, {"pid": 8}, {"pid": None}, {}]
    labels.attach(rows, {7: "seven"})
    assert [r["label"] for r in rows] == ["seven", "", "", ""]


# ------------------------------------------------------------------ the API

@pytest.fixture
def client(tmp_path):
    (tmp_path / "root").mkdir()
    app = create_app(Config(token=TOKEN, roots=[tmp_path / "root"], tmux_socket="argus-test-suite",
                            check_releases=False))
    app.state.labels = tmp_path / "labels.json"
    return TestClient(app)


def test_the_api_sets_lists_and_clears(client):
    pid = os.getpid()
    r = client.post("/api/labels", json={"pid": pid, "label": "this very test"}, headers=H)
    assert r.status_code == 200 and r.json() == {"pid": pid, "label": "this very test"}
    assert client.get("/api/labels", headers=H).json() == {"labels": [{"pid": pid, "label": "this very test"}]}
    client.post("/api/labels", json={"pid": pid, "label": ""}, headers=H)
    assert client.get("/api/labels", headers=H).json() == {"labels": []}


def test_the_api_refuses_what_is_not_a_running_process(client):
    assert client.post("/api/labels", json={"pid": 2 ** 22 + 12345, "label": "x"}, headers=H).status_code == 404
    assert client.post("/api/labels", json={"pid": "abc", "label": "x"}, headers=H).status_code == 400
    assert client.post("/api/labels", json={"label": "x"}, headers=H).status_code == 400
    assert client.post("/api/labels", json={"pid": -1, "label": "x"}, headers=H).status_code == 400


def test_the_api_needs_the_token(client):
    assert client.get("/api/labels").status_code == 401
    assert client.post("/api/labels", json={"pid": os.getpid(), "label": "x"}).status_code == 401


def test_without_a_store_labels_are_read_as_none_and_not_written(tmp_path):
    (tmp_path / "root").mkdir()
    c = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"], check_releases=False)))
    assert c.get("/api/labels", headers=H).json() == {"labels": []}
    assert c.post("/api/labels", json={"pid": os.getpid(), "label": "x"}, headers=H).status_code == 503


def test_system_and_ports_carry_the_label(client, monkeypatch):
    """The two screens that show processes get the label in the rows they already read."""
    from app import ports, system
    pid = os.getpid()
    client.post("/api/labels", json={"pid": pid, "label": "the big one"}, headers=H)
    monkeypatch.setattr(system, "snapshot", lambda roots, brief=False: {
        "processes": [{"pid": pid, "name": "python3", "rss": 1, "cpu": 0.0, "command": "python3 -m pytest"},
                      {"pid": 1, "name": "systemd", "rss": 1, "cpu": 0.0, "command": ""}]})
    procs = client.get("/api/system", headers=H).json()["processes"]
    assert [p["label"] for p in procs] == ["the big one", ""]
    monkeypatch.setattr(ports, "listening", lambda own=None: [
        {"port": 8888, "pid": pid, "process": "python3", "command": "jupyter", "address": "127.0.0.1",
         "loopback": True, "mine": True}])
    assert client.get("/api/ports", headers=H).json()["ports"][0]["label"] == "the big one"


def test_an_agent_token_cannot_write_labels(tmp_path):
    """Labels are the person's notes; the agent routes are a closed list and this is not on it."""
    from app import auth
    assert ("POST", "/api/labels") not in auth.AGENT_ROUTES

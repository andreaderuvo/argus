"""Applying a tmux configuration.

Sourcing a config runs it, and a file that ends the server ends every session with it.
So the rule these tests hold to is: the real socket is never touched by a file that has
not survived a throwaway one first.
"""

import pytest
from fastapi.testclient import TestClient

from app import main as app_main
from app import tmux
from app.config import Config
from app.main import create_app
from app.tmux import Socket

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def conf(tmp_path, monkeypatch):
    path = tmp_path / ".tmux.conf"
    path.write_text("set -g mouse on\n")
    monkeypatch.setattr(tmux, "conf_path", lambda: str(path))
    return path


@pytest.fixture
def client(tmp_path, conf):
    (tmp_path / "root").mkdir()
    return TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"], tmux_socket="argus-test")))


def apply(client, **body):
    return client.post("/api/tmux/source", json=body, headers={"Authorization": f"Bearer {TOKEN}"})


def test_a_file_that_passes_the_test_server_is_sourced(client, conf, monkeypatch):
    used = []
    monkeypatch.setattr(tmux, "check_conf", lambda path: None)
    monkeypatch.setattr(tmux, "source_conf", lambda sock, path: used.append((sock, path)) or "")

    r = apply(client)
    assert r.status_code == 200
    assert used and used[0][1] == str(conf)
    assert used[0][0].spec == "argus-test", "it must go to the configured socket, not the default one"


def test_a_file_the_test_server_refuses_never_reaches_the_real_one(client, monkeypatch):
    """This is the whole point: the throwaway server takes the damage."""
    monkeypatch.setattr(tmux, "check_conf", lambda path: "unknown command: nonsense")
    monkeypatch.setattr(tmux, "source_conf", lambda sock, path: pytest.fail("must not be sourced"))

    r = apply(client)
    assert r.status_code == 400
    assert "unknown command" in r.json()["error"]


def test_the_check_can_be_overridden_on_purpose(client, monkeypatch):
    """Someone who knows better — a config whose side effects must not run twice — can
    say so, and then it is on them."""
    monkeypatch.setattr(tmux, "check_conf", lambda path: pytest.fail("must not be tested"))
    monkeypatch.setattr(tmux, "source_conf", lambda sock, path: "")
    assert apply(client, force=True).status_code == 200


def test_a_missing_file_is_a_clear_404(client, conf, monkeypatch):
    conf.unlink()
    r = apply(client)
    assert r.status_code == 404
    assert str(conf) in r.json()["error"]


def test_what_tmux_complains_about_comes_back(client, monkeypatch):
    monkeypatch.setattr(tmux, "check_conf", lambda path: None)

    def refuse(sock, path):
        raise tmux.TmuxError("/home/x/.tmux.conf:12: unknown option")

    monkeypatch.setattr(tmux, "source_conf", refuse)
    r = apply(client)
    assert r.status_code == 502
    assert ":12:" in r.json()["error"], "the line number is the useful part"


def test_applying_needs_the_token(client):
    assert client.post("/api/tmux/source", json={}).status_code == 401


def test_the_test_server_is_never_the_default_socket(monkeypatch):
    """A check that ran on the default socket could take the user's sessions down — the
    exact accident this is here to prevent."""
    seen = []

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: seen.append(argv) or Done())
    tmux.check_conf("/tmp/whatever.conf")
    assert seen, "it has to actually run something"
    for argv in seen:
        assert "-L" in argv and argv[argv.index("-L") + 1] == tmux.CHECK_SOCKET


def test_the_check_kills_its_server_afterwards(monkeypatch):
    seen = []

    class Done:
        returncode = 0
        stdout = ""
        stderr = ""

    monkeypatch.setattr(tmux.subprocess, "run", lambda argv, **kw: seen.append(argv) or Done())
    tmux.check_conf("/tmp/whatever.conf")
    assert seen[-1][-1] == "kill-server", "a scratch server left running is a leak"


def test_the_line_number_tmux_prints_is_not_lost():
    """tmux writes "file:12: unknown command" to stdout, not stderr. Reading the wrong
    stream turns a precise complaint into a blank "it refused"."""
    class OnStdout:
        returncode = 1
        stdout = "/home/x/.tmux.conf:12: unknown command: nonsense\nand a second line"
        stderr = ""

    assert tmux.complaint(OnStdout()) == "/home/x/.tmux.conf:12: unknown command: nonsense"


def test_stderr_still_wins_when_there_is_something_on_it():
    class Both:
        returncode = 1
        stdout = "noise"
        stderr = "the real problem"

    assert tmux.complaint(Both()) == "the real problem"


def test_the_named_places_are_where_tmux_looks(monkeypatch, tmp_path):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert tmux.conf_path() == str(tmp_path / ".tmux.conf"), "the default when nothing exists"

    (tmp_path / ".config" / "tmux").mkdir(parents=True)
    (tmp_path / ".config" / "tmux" / "tmux.conf").write_text("")
    assert tmux.conf_path() == str(tmp_path / ".config" / "tmux" / "tmux.conf")

    (tmp_path / ".tmux.conf").write_text("")
    assert tmux.conf_path() == str(tmp_path / ".tmux.conf"), "the home file wins, as in tmux"

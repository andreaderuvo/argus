"""The Python client: the parts that are worth a file rather than a `requests` call."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))
import argus_client                                              # noqa: E402
from argus_client import Argus, ArgusError, TooFast, credentials  # noqa: E402


@pytest.fixture
def config(tmp_path, monkeypatch):
    def write(text: str):
        p = tmp_path / "config.yaml"
        p.write_text(text, encoding="utf-8")
        monkeypatch.setenv("ARGUS_CONFIG", str(p))
        monkeypatch.delenv("ARGUS_TOKEN", raising=False)
        return p
    return write


def test_it_reads_where_and_which_key(config):
    config("listen: 127.0.0.1:8099\ntoken: mmmm\n")
    assert credentials() == ("http://127.0.0.1:8099", "mmmm")


def test_the_agent_key_wins_over_the_master_one(config):
    """A script that only needs the five verbs should hold the key that only does them."""
    config("listen: 127.0.0.1:8099\ntoken: mmmm\nagents:\n  - name: in-session\n    token: aaaa\n")
    assert credentials()[1] == "aaaa"


def test_listening_everywhere_is_not_an_address_to_call(config):
    """0.0.0.0 is somewhere to listen, not somewhere to connect: loopback reaches it."""
    config("listen: 0.0.0.0:8090\ntoken: mmmm\n")
    assert credentials()[0] == "http://127.0.0.1:8090"


def test_no_token_says_which_file_it_looked_in(config):
    p = config("listen: 127.0.0.1:8099\n")
    with pytest.raises(ArgusError) as caught:
        credentials()
    assert str(p) in str(caught.value)


def test_the_environment_overrides_the_config(config, monkeypatch):
    config("listen: 127.0.0.1:8099\ntoken: mmmm\n")
    monkeypatch.setenv("ARGUS_TOKEN", "from-the-environment")
    assert credentials()[1] == "from-the-environment"


def test_a_brake_is_its_own_kind_of_failure(monkeypatch):
    """429 is not an error, it is "you are going faster than the config allows" — and a caller
    doing a deliberate fan-out wants to wait or raise the cap, not give up like on a 400."""
    import urllib.error

    def refuse(*a, **k):
        raise urllib.error.HTTPError("u", 429, "too fast", {}, None)

    monkeypatch.setattr(argus_client.urllib.request, "urlopen", refuse)
    argus = Argus(base="http://x", token="t")
    with pytest.raises(TooFast):
        argus.who()
    # And it is still an ArgusError, so `except ArgusError` keeps catching everything.
    assert issubclass(TooFast, ArgusError)


def test_an_unreachable_machine_says_so_rather_than_raising_oserror(monkeypatch):
    def refuse(*a, **k):
        raise OSError("connection refused")

    monkeypatch.setattr(argus_client.urllib.request, "urlopen", refuse)
    with pytest.raises(ArgusError) as caught:
        Argus(base="http://x", token="t").who()
    assert "could not reach" in str(caught.value)


def test_wait_for_returns_what_arrived_and_what_did_not(tmp_path, monkeypatch):
    there, missing = tmp_path / "there.md", tmp_path / "missing.md"
    there.write_text("done", encoding="utf-8")
    argus = Argus(base="http://x", token="t")
    # No bells: the file is the fact, and one that is already there needs no stream at all.
    monkeypatch.setattr(Argus, "bells", lambda *a, **k: iter(()))
    got, left = argus.wait_for([there, missing], until=argus_client.time.monotonic() + 0.2)
    assert got == [there] and left == [missing]


def test_an_empty_file_does_not_count_as_arrived(tmp_path, monkeypatch):
    """An agent that has created the file and not written it yet has not finished."""
    empty = tmp_path / "empty.md"
    empty.touch()
    monkeypatch.setattr(Argus, "bells", lambda *a, **k: iter(()))
    got, left = Argus(base="http://x", token="t").wait_for(
        [empty], until=argus_client.time.monotonic() + 0.2)
    assert got == [] and left == [empty]

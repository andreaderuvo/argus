"""The record of what was done here — and, more to the point, of what was refused.

This exists to answer one question: *has somebody been in here.* That shapes what goes in it.
A successful read is not interesting and there are thousands of them; a refusal is interesting
and there should be almost none. So reads are dropped, changes are kept, and every rejection is
kept whatever method it used — because a scanner sends GETs.
"""

from __future__ import annotations

import json
import time

from fastapi.testclient import TestClient

from app import journal
from app.config import Config
from app.main import create_app

MASTER = "master-0123456789abcdef0123456789"
WATCH = "watch-0123456789abcdef0123456789ab"


def running(tmp_path, **extra):
    cfg = Config(token=MASTER, roots=[tmp_path], allow_write=True, **extra)
    cfg.devices_store = tmp_path / "devices.json"
    cfg.journal_store = tmp_path / "journal.jsonl"
    client = TestClient(create_app(cfg))
    client.app.state.devices = cfg.devices_store
    client.app.state.journal = cfg.journal_store
    journal._last_refusal.clear()
    return client, cfg.journal_store


def lines(store):
    return journal.read(store, 500)


def master(client, method, path, **kw):
    return client.request(method, path, headers={"Authorization": f"Bearer {MASTER}"}, **kw)


# ------------------------------------------------------------------ what goes in, and not

def test_reads_are_not_recorded(tmp_path):
    """Listing a folder every four seconds while you scroll is most of the traffic and none of
    the interesting part. A file full of it is a file nobody opens."""
    client, store = running(tmp_path)
    for _ in range(5):
        master(client, "GET", f"/api/files?path={tmp_path}")
        master(client, "GET", "/api/tmux/sessions")
    assert lines(store) == []


def test_a_change_is_recorded_with_who_and_where(tmp_path):
    client, store = running(tmp_path)
    master(client, "POST", "/api/fs/mkdir", json={"path": str(tmp_path), "name": "new"})

    kept = lines(store)
    assert len(kept) == 1
    assert kept[0]["did"] == "POST /api/fs/mkdir"
    assert kept[0]["status"] == 200
    assert kept[0]["who"] == "the config token"
    assert kept[0]["from"]
    assert not kept[0].get("refused")


def test_a_refusal_is_recorded_whatever_method_it_used(tmp_path):
    """The whole point: a break-in looks like a run of 401s, and a scanner sends GETs."""
    client, store = running(tmp_path)
    client.get("/api/config", headers={"Authorization": "Bearer wrong"})

    kept = lines(store)
    assert len(kept) == 1
    assert kept[0]["refused"] is True
    assert kept[0]["status"] == 401
    # Nothing is known about who it was, and the record must not imply otherwise.
    assert kept[0]["who"] == "someone"


def test_a_device_is_named_in_its_own_entries(tmp_path):
    """This is the reason the journal became worth writing: before per-device tokens, every
    line would have said "the token did it"."""
    from app import devices

    client, store = running(tmp_path)
    made = master(client, "POST", "/api/devices", json={"name": "phone"}).json()
    client.post("/api/fs/mkdir", json={"path": str(tmp_path), "name": "fromphone"},
                headers={"Authorization": f"Bearer {made['token']}"})

    said = [e for e in lines(store) if e["did"].endswith("mkdir")]
    assert said and said[0]["who"] == "phone"


def test_a_board_is_named_as_a_board(tmp_path):
    client, store = running(tmp_path, watchers=[
        {"name": "panoptes", "token": WATCH, "may_run": False, "may_stop_argus": False}])
    # A watcher asking for a door it does not have is a refusal, and worth seeing.
    client.get("/api/files?path=/tmp", headers={"Authorization": f"Bearer {WATCH}"})
    assert any(e["status"] == 403 for e in lines(store))


# -------------------------------------------------------------------------- flood control

def test_a_burst_of_refusals_is_collapsed_but_fully_counted(tmp_path):
    """A scanner can produce thousands a minute, and a journal that rotates its own history
    away while being flooded is worse than none. Collapsing is fine; undercounting is not —
    the number is the whole signal."""
    client, store = running(tmp_path)
    for _ in range(12):
        client.get("/api/config", headers={"Authorization": "Bearer wrong"})

    # One line so far, standing for one attempt; the other eleven are still held.
    assert len(lines(store)) == 1

    # Once the burst has gone quiet the rest is written out, and the totals add up.
    journal.flush_swallowed(store, time.time() + journal.QUIET_FOR + 1)
    knocks = sum(e.get("times", 1) for e in lines(store) if e.get("refused"))
    assert knocks == 12, [dict(e) for e in lines(store)]


def test_the_summary_line_is_not_counted_as_an_attempt(tmp_path):
    """It stands for the swallowed ones and nothing more. One field, one meaning — it was two
    with overlapping senses, and twelve knocks were reported as thirteen."""
    client, store = running(tmp_path)
    for _ in range(4):
        client.get("/api/config", headers={"Authorization": "Bearer wrong"})
    journal.flush_swallowed(store, time.time() + journal.QUIET_FOR + 1)

    summary = [e for e in lines(store) if e.get("summary")]
    assert len(summary) == 1
    assert summary[0]["times"] == 3          # not 4, and not 1


def test_two_addresses_are_not_collapsed_into_each_other(tmp_path):
    """Collapsing is per address. Two machines knocking is a different picture from one."""
    journal._last_refusal.clear()
    store = tmp_path / "j.jsonl"
    for peer in ("10.0.0.1", "10.0.0.2"):
        journal.record(store, {"method": "GET", "path": "/api/x", "client": (peer, 1),
                               "headers": []}, 401, 1)
    assert {e["from"] for e in lines(store)} == {"10.0.0.1", "10.0.0.2"}


# ------------------------------------------------------------------------- who may read it

def test_only_the_master_may_read_it(tmp_path):
    """A record a stolen device can read is a record that tells whoever took it what you can
    see."""
    client, _ = running(tmp_path)
    made = master(client, "POST", "/api/devices", json={"name": "phone"}).json()
    assert client.get("/api/journal",
                      headers={"Authorization": f"Bearer {made['token']}"}).status_code == 403
    assert master(client, "GET", "/api/journal").status_code == 200


def test_the_count_at_the_top_is_attempts_not_lines(tmp_path):
    client, store = running(tmp_path)
    for _ in range(6):
        client.get("/api/config", headers={"Authorization": "Bearer wrong"})
    journal.flush_swallowed(store, time.time() + journal.QUIET_FOR + 1)
    assert master(client, "GET", "/api/journal").json()["refused"] == 6


# ----------------------------------------------------------------------------- the file

def test_the_file_is_only_readable_by_its_owner(tmp_path):
    client, store = running(tmp_path)
    master(client, "POST", "/api/fs/mkdir", json={"path": str(tmp_path), "name": "x"})
    assert store.stat().st_mode & 0o077 == 0


def test_a_forwarded_address_is_kept_as_a_claim_not_a_fact(tmp_path):
    """Behind a proxy the peer is always loopback and the real client is in a header — and a
    header is whatever the sender wrote."""
    store = tmp_path / "j.jsonl"
    journal.record(store, {
        "method": "POST", "path": "/api/x", "client": ("127.0.0.1", 1),
        "headers": [(b"x-forwarded-for", b"203.0.113.9, 10.0.0.1")],
    }, 200, 1)
    entry = lines(store)[0]
    assert entry["from"] == "127.0.0.1"
    assert entry["via"] == "203.0.113.9"


def test_a_journal_that_cannot_be_written_does_not_break_the_action(tmp_path):
    """A read-only config directory is a reason to lose the record, not to fail the thing being
    recorded."""
    client, _ = running(tmp_path)
    client.app.state.journal = tmp_path / "nope" / "deeper" / "j.jsonl"
    (tmp_path / "nope").mkdir()
    (tmp_path / "nope").chmod(0o500)
    try:
        assert master(client, "POST", "/api/fs/mkdir",
                      json={"path": str(tmp_path), "name": "still-works"}).status_code == 200
        assert (tmp_path / "still-works").is_dir()
    finally:
        (tmp_path / "nope").chmod(0o700)


def test_it_does_not_grow_without_bound(tmp_path):
    store = tmp_path / "j.jsonl"
    store.write_text("".join(json.dumps({"at": 1, "did": f"x{i}"}) + "\n"
                            for i in range(journal.TRIM_AT + 500)), encoding="utf-8")
    journal.trim(store)
    assert len(store.read_text(encoding="utf-8").splitlines()) == journal.KEEP

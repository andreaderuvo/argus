"""One token per device, and the revocation that is the whole point of them.

Until now there was a single token. Losing a phone therefore cost you every device at once,
because the only remedy was rotating the one secret everything shared — and nothing recorded
which device had done anything.

The tests that matter here are about the boundary: a device may do the work, and may not
manage devices. That asymmetry is what stops a lost phone being used to lock its owner out.
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import devices
from app.config import Config
from app.main import create_app

MASTER = "master-0123456789abcdef0123456789"


def running(tmp_path):
    cfg = Config(token=MASTER, roots=[tmp_path])
    cfg.devices_store = tmp_path / "devices.json"
    client = TestClient(create_app(cfg))
    client.app.state.devices = cfg.devices_store
    return client, cfg.devices_store


def as_master(client, method, path, **kw):
    return client.request(method, path, headers={"Authorization": f"Bearer {MASTER}"}, **kw)


def mint(client, name="phone"):
    said = as_master(client, "POST", "/api/devices", json={"name": name})
    assert said.status_code == 200, said.text
    return said.json()["token"], said.json()["device"]["id"]


# ------------------------------------------------------------------- what is stored

def test_the_plain_token_is_never_written_down(tmp_path):
    """It is shown once and then only a hash is kept, the way GitHub shows a personal access
    token. Losing the file must not hand anyone a working key."""
    client, store = running(tmp_path)
    token, _ = mint(client)

    on_disk = store.read_text(encoding="utf-8")
    assert token not in on_disk
    assert devices.fingerprint(token) in on_disk
    # And the browser is never told it again either.
    listed = as_master(client, "GET", "/api/devices").json()
    assert token not in json.dumps(listed)
    assert "hash" not in json.dumps(listed)


def test_the_file_is_only_readable_by_its_owner(tmp_path):
    client, store = running(tmp_path)
    mint(client)
    assert store.stat().st_mode & 0o077 == 0


# ------------------------------------------------------------------ what a device may do

def test_a_device_token_does_the_work(tmp_path):
    client, _ = running(tmp_path)
    token, _ = mint(client)
    mine = {"Authorization": f"Bearer {token}"}

    for path in ("/api/config", "/api/tmux/sessions", "/api/overview", f"/api/files?path={tmp_path}"):
        assert client.get(path, headers=mine).status_code == 200, path


def test_a_device_may_not_make_or_break_devices(tmp_path):
    """The asymmetry that makes this worth having: a phone that is lost cannot mint itself a
    second key, and cannot revoke the laptop out of spite."""
    client, _ = running(tmp_path)
    token, other = mint(client, "laptop")
    mine = {"Authorization": f"Bearer {token}"}

    assert client.get("/api/devices", headers=mine).status_code == 403
    assert client.post("/api/devices", json={"name": "another"}, headers=mine).status_code == 403
    assert client.delete(f"/api/devices/{other}", headers=mine).status_code == 403


def test_revoking_takes_effect_at_once(tmp_path):
    """Without restarting anything: the file is re-read on every attempt, which is the only
    reason revocation is a feature rather than a note in the documentation."""
    client, _ = running(tmp_path)
    token, ident = mint(client)
    mine = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/config", headers=mine).status_code == 200

    assert as_master(client, "DELETE", f"/api/devices/{ident}").json()["revoked"] == "phone"
    assert client.get("/api/config", headers=mine).status_code == 401


def test_revoking_one_leaves_the_others(tmp_path):
    """The whole point. Losing a phone used to mean rotating for the laptop too."""
    client, _ = running(tmp_path)
    phone, phone_id = mint(client, "phone")
    laptop, _ = mint(client, "laptop")

    as_master(client, "DELETE", f"/api/devices/{phone_id}")
    assert client.get("/api/config", headers={"Authorization": f"Bearer {phone}"}).status_code == 401
    assert client.get("/api/config", headers={"Authorization": f"Bearer {laptop}"}).status_code == 200
    # And the master key is untouched by any of it.
    assert as_master(client, "GET", "/api/config").status_code == 200


def test_a_token_that_was_never_minted_is_refused(tmp_path):
    client, _ = running(tmp_path)
    mint(client)
    for wrong in ("", "x" * 64, MASTER[:-1] + "0", devices.fingerprint("phone")):
        assert client.get("/api/config", headers={"Authorization": f"Bearer {wrong}"}).status_code == 401


# ------------------------------------------------------------------------- housekeeping

def test_two_devices_cannot_share_a_name(tmp_path):
    """A list where two rows say "phone" is a list you cannot revoke from with confidence."""
    client, _ = running(tmp_path)
    mint(client, "phone")
    assert as_master(client, "POST", "/api/devices", json={"name": "Phone"}).status_code == 400


def test_a_device_needs_a_name(tmp_path):
    client, _ = running(tmp_path)
    for empty in ("", "   ", "\n"):
        assert as_master(client, "POST", "/api/devices", json={"name": empty}).status_code == 400


def test_there_is_a_ceiling(tmp_path):
    client, store = running(tmp_path)
    devices.save(store, [
        {"id": f"{i:04x}", "name": f"d{i}", "hash": devices.fingerprint(str(i)),
         "added": float(i), "last_seen": 0.0}
        for i in range(devices.MAX_DEVICES)
    ])
    assert as_master(client, "POST", "/api/devices", json={"name": "one more"}).status_code == 400


def test_last_seen_is_recorded_but_not_on_every_request(tmp_path):
    """The field answers "yesterday or today", so writing it per request would be a write per
    request for no added truth."""
    client, store = running(tmp_path)
    token, ident = mint(client)
    mine = {"Authorization": f"Bearer {token}"}

    client.get("/api/config", headers=mine)
    first = next(d for d in devices.load(store) if d["id"] == ident)["last_seen"]
    assert first > 0

    client.get("/api/config", headers=mine)
    again = next(d for d in devices.load(store) if d["id"] == ident)["last_seen"]
    assert again == first, "wrote twice inside the throttle window"

    # Far enough back and it writes again.
    stale = devices.load(store)
    for d in stale:
        d["last_seen"] = time.time() - devices.SEEN_EVERY - 5
    devices.save(store, stale)
    client.get("/api/config", headers=mine)
    assert next(d for d in devices.load(store) if d["id"] == ident)["last_seen"] > first


def test_a_broken_device_file_costs_the_list_and_nothing_else(tmp_path):
    """A directory people can reach is a directory with a broken file in it eventually, and
    the one failure this must not have is locking every device out at once."""
    client, store = running(tmp_path)
    store.write_text("{ not json", encoding="utf-8")
    assert devices.load(store) == []
    assert as_master(client, "GET", "/api/config").status_code == 200
    assert as_master(client, "GET", "/api/devices").json() == []


def test_no_devices_at_all_changes_nothing(tmp_path):
    """Every existing installation has none, and must go on working exactly as before."""
    client, _ = running(tmp_path)
    assert as_master(client, "GET", "/api/config").status_code == 200
    assert client.get("/api/config", headers={"Authorization": "Bearer nope"}).status_code == 401

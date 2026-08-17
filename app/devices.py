"""A token per device, so one can be taken back without taking back all of them.

There has only ever been one token here. That makes losing a phone expensive: rotating shuts
out the laptop, the tablet and the other phone at the same time, and nothing anywhere records
which of them did what. It is the gap this closes, and it is the one improvement in this area
that needs neither HTTPS nor a login form.

Three decisions worth stating, because each of them could reasonably have gone the other way.

**Kept beside the config, not in it.** The config is hand-written and full of comments, and a
YAML round-trip loses every one of them. So devices live in their own file, which the program
owns and may rewrite freely.

**Only the hash is stored.** A device token is 256 bits of randomness, so the file holds
`sha256` of it and the plain form is shown exactly once, when it is created — the way GitHub
shows a personal access token and Tailscale shows an auth key. Losing the file then does not
hand anyone a working key. There is deliberately no bcrypt or argon2: those exist to make
*guessable* secrets expensive to attack, and a 256-bit random string is not guessable. A slow
hash here would only make every request slower.

**The config token stays the master.** It alone may add and revoke devices; a device token can
do everything else. That asymmetry is the point: a phone that is lost cannot be used to lock
its owner out of their own machine.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import time
from pathlib import Path

# Long enough that nobody will ever guess one, short enough to fit in a QR code beside a URL.
TOKEN_BYTES = 32
MAX_DEVICES = 32
NAME_LIMIT = 40
# `last_seen` is written no more often than this. Every request would mean a write per
# request, and the value of that field is "yesterday or today", not "which second".
SEEN_EVERY = 60.0


def default_store(config_path: Path) -> Path:
    return config_path.parent / "devices.json"


class DeviceError(Exception):
    """The request cannot be carried out as asked."""


def fingerprint(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def tidy_name(raw: str) -> str:
    """A label for a person to read, so anything printable is fine — but on one line, and
    short enough to sit in a list beside a date."""
    name = " ".join(str(raw or "").split())[:NAME_LIMIT]
    if not name:
        raise DeviceError("a device needs a name — 'phone' or 'laptop' is enough")
    return name


def load(store: Path) -> list[dict]:
    """Whatever is on disk, as a list. Never raises: a device file that has been corrupted
    should cost you the device list, not the ability to start."""
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    kept = []
    for one in data:
        if not isinstance(one, dict):
            continue
        if not (one.get("id") and one.get("hash")):
            continue
        kept.append({
            "id": str(one["id"]),
            "name": str(one.get("name") or "device")[:NAME_LIMIT],
            "hash": str(one["hash"]),
            "added": float(one.get("added") or 0),
            "last_seen": float(one.get("last_seen") or 0),
        })
    return kept


def save(store: Path, devices: list[dict]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Written to one side and moved into place: a half-written device file would lock every
    # device out at once, which is the one failure this feature must not have.
    beside = store.with_suffix(".part")
    beside.write_text(json.dumps(devices, indent=1), encoding="utf-8")
    beside.chmod(0o600)
    os.replace(beside, store)


def public(devices: list[dict]) -> list[dict]:
    """What a browser is told: everything except the thing that would let it in."""
    return [
        {"id": d["id"], "name": d["name"], "added": d["added"], "last_seen": d["last_seen"]}
        for d in sorted(devices, key=lambda d: d["added"])
    ]


def add(store: Path, name: str) -> tuple[dict, str]:
    """Mint one. Returns the entry and the plain token, which is the only time it exists."""
    devices = load(store)
    if len(devices) >= MAX_DEVICES:
        raise DeviceError(f"there are already {MAX_DEVICES} devices — revoke one first")
    label = tidy_name(name)
    if any(d["name"].lower() == label.lower() for d in devices):
        raise DeviceError(f"there is already a device called {label!r}")

    token = secrets.token_hex(TOKEN_BYTES)
    entry = {
        "id": secrets.token_hex(8),
        "name": label,
        "hash": fingerprint(token),
        "added": time.time(),
        "last_seen": 0.0,
    }
    save(store, [*devices, entry])
    return entry, token


def rename(store: Path, device_id: str, name: str) -> dict:
    """A name is a label for a person, and the person changes their mind: "phone" becomes "old
    phone" the day a new one arrives, and a list you cannot correct is a list you stop trusting
    when it matters."""
    label = tidy_name(name)
    kept = load(store)
    found = next((d for d in kept if d["id"] == device_id), None)
    if not found:
        raise DeviceError("no device with that id")
    if any(d["name"].lower() == label.lower() and d["id"] != device_id for d in kept):
        raise DeviceError(f"there is already a device called {label!r}")
    found["name"] = label
    save(store, kept)
    return found


def revoke(store: Path, device_id: str) -> dict:
    devices = load(store)
    keeping = [d for d in devices if d["id"] != device_id]
    if len(keeping) == len(devices):
        raise DeviceError("no device with that id")
    gone = next(d for d in devices if d["id"] == device_id)
    save(store, keeping)
    return gone


def matching(devices: list[dict], presented: str) -> dict | None:
    """The device a token belongs to, if any.

    Every candidate is compared even after a match, so how long this takes says nothing about
    which device it was or whether it was the first one in the file.
    """
    if not presented:
        return None
    seen = fingerprint(presented)
    found = None
    for device in devices:
        if hmac.compare_digest(seen, device["hash"]):
            found = device
    return found


def touch(store: Path, device: dict, now: float | None = None) -> bool:
    """Record that this device was used, at most once a minute. Says whether it wrote."""
    when = time.time() if now is None else now
    if when - device.get("last_seen", 0) < SEEN_EVERY:
        return False
    devices = load(store)
    for one in devices:
        if one["id"] == device["id"]:
            one["last_seen"] = when
            device["last_seen"] = when
            save(store, devices)
            return True
    return False

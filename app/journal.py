"""What was done here, by which key, and when.

Until devices had their own tokens there was nothing to write down: one secret, one line per
action saying "the token did it". Now that a phone and a laptop are told apart, the question
"who stopped Argus at half past six" has an answer worth keeping.

Three things this deliberately is not:

**Not a request log.** Successful reads are not recorded. Listing a folder every four seconds
while you scroll is the overwhelming majority of the traffic and none of the interesting part.
What goes in is what *changed* something, and every attempt that was *refused* — because the
question this exists to answer is "has somebody been in here", and the answer to that is
usually a 401 from an address you do not recognise, not a successful write.

**Not per-handler.** It is written by middleware, so a route added next month is recorded
without anybody remembering to add a line to it. Instrumenting twenty handlers by hand is a
feature that decays the first time someone is in a hurry.

**Not tamper-proof.** Anything holding the master token can delete the file, and a shell on the
machine certainly can. It answers "what happened" for a person looking back, which is the
question that actually comes up; it is not evidence.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

# One line per action, and the file is trimmed when it gets long. A year of ordinary use is a
# few thousand lines, so this is generous — it exists so the file cannot grow without bound if
# something goes into a loop.
KEEP = 5000
TRIM_AT = 7000
# Bodies are never read here — a path is only recorded when a handler offers one.
NOTE_LIMIT = 200

# A port scanner can produce thousands of refusals a minute, and a journal that rotates the
# interesting history away while being flooded is worse than none. So refusals from one address
# are collapsed: one line at most this often, carrying how many were swallowed.
QUIET_FOR = 10.0
_last_refusal: dict[tuple, list] = {}


def default_store(config_path: Path) -> Path:
    return config_path.parent / "journal.jsonl"


def who_from(scope: dict) -> str:
    """The key that did it, in the words a person would use reading the list back."""
    if scope.get("argus_master"):
        return "the config token"
    device = scope.get("argus_device")
    if device:
        return device.get("name") or "a device"
    watcher = scope.get("argus_watcher")
    if watcher:
        return f"{watcher.get('name') or 'a board'} (board)"
    return "unknown"


def write(store: Path, entry: dict) -> None:
    """Append one line. Never raises: a read-only config directory is a reason to lose the
    record, not to fail the action that was being recorded."""
    try:
        store.parent.mkdir(parents=True, exist_ok=True)
        fresh = not store.exists()
        with store.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, separators=(",", ":")) + "\n")
        if fresh:
            store.chmod(0o600)
        trim(store)
    except OSError:
        pass


def note(scope: dict, what: str) -> None:
    """For a handler whose interesting part is in the body rather than the path.

    `POST /api/fs/delete` says nothing on its own; the path it deleted is what somebody looking
    back wants. A handler leaves it here and the middleware picks it up.
    """
    scope["argus_note"] = str(what)[:NOTE_LIMIT]


def where_from(scope: dict) -> tuple[str, str]:
    """The address the connection came from, and what a proxy in front claims.

    Both, kept apart on purpose. Behind a reverse proxy the peer is always 127.0.0.1 and the
    real client is in a header — but a header is whatever the sender wrote, so it is recorded
    as a claim rather than as a fact. Reading a journal and not knowing which of the two you
    are looking at is worse than seeing both.
    """
    client = scope.get("client") or ()
    peer = client[0] if client else "?"
    said = ""
    for key, value in scope.get("headers") or []:
        if key.lower() == b"x-forwarded-for":
            said = value.decode("latin-1").split(",")[0].strip()[:64]
            break
    return peer, said


def refused(status: int) -> bool:
    return status in (401, 403)


def record(store: Path, scope: dict, status: int, took_ms: int) -> None:
    peer, claimed = where_from(scope)
    entry = {
        "at": round(time.time(), 1),
        "who": who_from(scope),
        "did": f'{scope.get("method", "?")} {scope.get("path", "?")}',
        "status": status,
        "ms": took_ms,
        "from": peer,
    }
    if claimed and claimed != peer:
        entry["via"] = claimed          # what a proxy says; a header, so a claim
    if scope.get("argus_note"):
        entry["what"] = scope["argus_note"]

    now = time.time()
    # Whatever was swallowed and has gone quiet gets its own line first, so a burst that stops
    # is still counted. Riding only on the next attempt from the same address loses the tail —
    # and for a record whose job is to say how hard somebody knocked, undercounting is the
    # wrong way to be wrong.
    flush_swallowed(store, now)

    if refused(status):
        key = (peer, status, scope.get("path", ""))
        seen = _last_refusal.get(key)
        if seen and now - seen[0] < QUIET_FOR:
            seen[1] += 1
            return
        entry["refused"] = True
        # One field, one meaning: how many attempts this line stands for. It was two fields
        # with overlapping senses, and a summary line ended up counted as an attempt of its
        # own — 12 knocks reported as 13, which for a record about being knocked on is the
        # kind of wrong that makes you stop trusting the number.
        entry["times"] = 1 + (seen[1] if seen else 0)
        _last_refusal[key] = [now, 0]
        # Nothing about a refusal is known except where it came from: there is no `who`.
        entry["who"] = "someone"

    write(store, entry)


def flush_swallowed(store: Path, now: float | None = None) -> int:
    """Write out the refusals collapsed into a counter once their burst has ended.

    Called on the way past by anything else being recorded, which in practice is often: the
    page polls. Returns how many lines it wrote, which is what makes it testable.
    """
    when = time.time() if now is None else now
    wrote = 0
    for key, seen in list(_last_refusal.items()):
        at, swallowed = seen
        if when - at < QUIET_FOR:
            continue
        if swallowed:
            peer, status, path = key
            write(store, {
                "at": round(at, 1),
                "who": "someone",
                "did": path,
                "status": status,
                "ms": 0,
                "from": peer,
                "refused": True,
                # Exactly the swallowed ones: this line is a summary, not an attempt.
                "times": swallowed,
                "summary": True,
            })
            wrote += 1
        del _last_refusal[key]
    return wrote


def trim(store: Path) -> None:
    """Keep the last KEEP lines, rewritten beside and moved into place."""
    try:
        if store.stat().st_size < 200 * TRIM_AT:
            # Cheap guard: only count lines when the file is plausibly long enough to matter.
            with store.open(encoding="utf-8") as f:
                lines = f.readlines()
            if len(lines) <= TRIM_AT:
                return
        else:
            with store.open(encoding="utf-8") as f:
                lines = f.readlines()
        beside = store.with_suffix(".part")
        beside.write_text("".join(lines[-KEEP:]), encoding="utf-8")
        beside.chmod(0o600)
        os.replace(beside, store)
    except (OSError, ValueError):
        pass


def clear(store: Path, older_than: float | None = None) -> int:
    """Throw away the whole thing, or everything before a cutoff. Returns how many lines went.

    A journal you cannot empty fills with the noise of ordinary use and stops being read, and
    one that empties itself on a schedule loses the week you needed. So it is an act: you say
    when, and it happens.

    Emptying it is itself recorded — by the middleware, which sees the request like any other
    change, and by the count this returns. A record that can be wiped without trace is not
    much of a record; a record that says "somebody cleared me, at this hour, from this
    address" still answers the question it exists for.
    """
    try:
        with store.open(encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return 0

    if older_than is None:
        kept: list[str] = []
    else:
        cutoff = time.time() - older_than
        kept = []
        for line in lines:
            try:
                one = json.loads(line)
            except ValueError:
                continue                      # a line nothing can read is not worth keeping
            if float(one.get("at") or 0) >= cutoff:
                kept.append(line)

    gone = len(lines) - len(kept)
    if not gone:
        return 0
    try:
        beside = store.with_suffix(".part")
        beside.write_text("".join(kept), encoding="utf-8")
        beside.chmod(0o600)
        os.replace(beside, store)
    except OSError:
        return 0
    return gone


def read(store: Path, limit: int = 200) -> list[dict]:
    """The most recent first, which is the order anybody reads this in."""
    try:
        with store.open(encoding="utf-8") as f:
            lines = f.readlines()
    except OSError:
        return []
    out = []
    for line in reversed(lines[-limit * 2:]):
        try:
            one = json.loads(line)
        except ValueError:
            continue
        if isinstance(one, dict):
            out.append(one)
        if len(out) >= limit:
            break
    return out

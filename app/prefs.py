"""What the browser remembers, kept on the machine instead.

Sixty keys used to live only in `localStorage`: the desks and where every window sits, the
prompt library, the placeholder sets, the keyboard shortcuts, which viewer each extension gets.
That made two things impossible, and they are the two people actually ask for.

**A desk made at the desk did not exist on the phone.** The whole promise of this app is
reaching the same machine from anywhere, and the arrangement you made for a job — three
terminals and the report — was the one thing that stayed behind.

**And nothing outside the browser could read any of it.** An agent can start three agents in
three worktrees and cannot lay out a desk to watch them in; a script cannot read the prompt
library it is meant to send from. The API governed the machine and not the workspace.

## How it merges, and why not the obvious way

The obvious way is: whoever saves last wins the whole document. That loses a desk made on the
phone the moment the laptop saves an older copy of everything, which is precisely the case this
exists for.

So the browser sends **only the keys it changed** since it loaded, and the server merges them
into whatever it has now. Two devices editing different things — the phone starring a prompt,
the laptop moving a window — both keep their change, with no locking and no clock. Two devices
editing the *same* key still resolve last-write-wins, and there is no honest way around that
without asking a person which one they meant.

The version is a counter, returned with every read and bumped on every write. A `PUT` of the
whole document must present the version it is replacing, so an import cannot silently overwrite
work done in the meantime; a `PATCH` of individual keys does not need one, because that is the
whole point of sending keys.
"""

from __future__ import annotations

import json
from pathlib import Path

# The document is mostly small — a few kilobytes — but the prompt library and forty windows'
# geometry are in it, and somebody will paste a book into a prompt one day.
MAX_BYTES = 4 * 1024 * 1024


def default_store(config_path: Path) -> Path:
    return config_path.parent / "prefs.json"


def load(store: Path | None) -> tuple[int, dict]:
    """The version and the document. A missing or broken file is version 0 and nothing, never
    an exception: a browser that cannot read its preferences should start empty rather than
    not start."""
    if store is None:
        return 0, {}
    try:
        raw = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return 0, {}
    if not isinstance(raw, dict):
        return 0, {}
    doc = raw.get("prefs")
    if not isinstance(doc, dict):
        return 0, {}
    try:
        version = int(raw.get("version", 0))
    except (TypeError, ValueError):
        version = 0
    return version, doc


def save(store: Path, version: int, doc: dict) -> None:
    body = json.dumps({"version": version, "prefs": doc}, indent=1)
    if len(body.encode()) > MAX_BYTES:
        raise ValueError(f"that is larger than {MAX_BYTES} bytes")
    store.parent.mkdir(parents=True, exist_ok=True)
    # Beside the target and renamed, like everything else here: a crash mid-write must not
    # leave a truncated document where a working one was. This one holds a person's whole
    # workspace, so that matters more than usual.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(body, encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def merge(doc: dict, changes: dict) -> dict:
    """Changed keys over the document, and *only* top level.

    Not a deep merge, deliberately. `workspaces` is a list of desks and `winGeom` is a map of
    every window's box: merging inside them would mean deciding what a "changed desk" is, and
    guessing wrong there loses a window rather than a preference. A key is the unit because a
    key is what the browser knows it touched.

    A key set to `null` is a key removed, which is how a browser says "I have stopped keeping
    this" — otherwise nothing could ever be forgotten.
    """
    out = dict(doc)
    for name, value in changes.items():
        if value is None:
            out.pop(name, None)
        else:
            out[name] = value
    return out

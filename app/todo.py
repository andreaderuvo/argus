"""A short list of things to do, kept next to the config.

Not in the browser's storage, and that is the whole decision. Prompts and desks live in the
browser because they are about *this screen* — where your windows are, what you like typed. A
list of things to do is about the work, and the work is what you look at from the desk in the
morning and from a phone on the train. A note written on one and invisible on the other would
be worse than no list at all.

Deliberately three fields. Every to-do list grows tags, priorities, projects and recurrence
until it is a second job; this one is a date, a line of text and one of three states, because
the thing it competes with is a sticky note on a monitor.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

STATES = ("open", "doing", "done")
MAX_NOTE = 500
# Enough for a working list, small enough that the file stays something a person can read and
# fix in an editor. Past it, the oldest *done* one goes — never an open one.
KEEP = 500


def clean_one(raw) -> dict | None:
    if not isinstance(raw, dict):
        return None
    note = str(raw.get("note", "")).strip()[:MAX_NOTE]
    if not note:
        return None
    state = str(raw.get("status", "open"))
    return {
        "id": str(raw.get("id") or uuid.uuid4().hex[:12]),
        "at": float(raw.get("at") or time.time()),
        "note": note,
        "status": state if state in STATES else "open",
        # When it stopped being open, so "done today" can be told from "done in March" without
        # keeping a second history.
        "moved": float(raw.get("moved") or raw.get("at") or time.time()),
        # A number you can say — "work on #3" — given once and never reused, so it means the same
        # thing tomorrow. 0 until `number()` gives one to an item from before numbers existed.
        "n": int(raw.get("n") or 0),
        # Which session last moved it, when an agent did: "done by pippo-claude".
        "by": str(raw.get("by") or "")[:60],
    }


def default_store(config_path: Path) -> Path:
    return config_path.parent / "todo.json"


def load(store: Path | None) -> list[dict]:
    """Whatever is on disk, cleaned. Never raises: a broken list is an empty one, not a
    broken screen — and the file is left alone so it can be looked at."""
    if store is None:
        return []
    try:
        raw = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(raw, list):
        return []
    out = [one for one in (clean_one(x) for x in raw) if one]
    return number(out)


def number(items: list[dict]) -> list[dict]:
    """Give every item without a number the next one, oldest first, so a list written before
    numbers existed reads #1 for the first thing ever written down."""
    top = max((x["n"] for x in items), default=0)
    for one in sorted((x for x in items if not x["n"]), key=lambda x: x["at"]):
        top += 1
        one["n"] = top
    return items


def find(items: list[dict], ident: str) -> str | None:
    """The id of the item `ident` names: its id, or its number as "#3" or "3"."""
    said = str(ident).strip()
    if said.lstrip("#").isdigit():
        n = int(said.lstrip("#"))
        return next((x["id"] for x in items if x["n"] == n), None)
    return said if any(x["id"] == said for x in items) else None


def save(store: Path, items: list[dict]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Beside the target and renamed, like the favourites: a crash mid-write must not leave a
    # truncated list where a working one was.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(json.dumps(items, indent=1), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def trim(items: list[dict]) -> list[dict]:
    """Past the cap, the oldest finished one goes. An open one is never dropped: a list that
    silently forgets something you have not done is not a list you can rely on."""
    if len(items) <= KEEP:
        return items
    done = sorted((x for x in items if x["status"] == "done"), key=lambda x: x["moved"])
    drop = {id(x) for x in done[: len(items) - KEEP]}
    return [x for x in items if id(x) not in drop]


def add(items: list[dict], note: str, status: str = "open") -> tuple[list[dict], dict]:
    made = clean_one({"note": note, "status": status})
    if not made:
        raise ValueError("a note needs some words in it")
    made["n"] = max((x["n"] for x in number(items)), default=0) + 1
    # Newest first is the order they are read in, and the order they are written in.
    return trim([made, *items]), made


def change(items: list[dict], ident: str, note: str | None, status: str | None,
           by: str = "") -> tuple[list[dict], dict | None]:
    ident = find(items, ident) or ident
    out, found = [], None
    for one in items:
        if one["id"] != ident:
            out.append(one)
            continue
        edited = dict(one)
        if note is not None:
            fresh = note.strip()[:MAX_NOTE]
            if not fresh:
                raise ValueError("a note needs some words in it")
            edited["note"] = fresh
        if status is not None:
            if status not in STATES:
                raise ValueError(f"status must be one of {', '.join(STATES)}")
            if status != edited["status"]:
                edited["moved"] = time.time()
                edited["by"] = by[:60]
            edited["status"] = status
        found = edited
        out.append(edited)
    return out, found


def remove(items: list[dict], ident: str) -> tuple[list[dict], bool]:
    ident = find(items, ident) or ident
    left = [x for x in items if x["id"] != ident]
    return left, len(left) != len(items)

"""A short list of things to do, kept next to the config.

Not in the browser's storage, and that is the whole decision. Prompts and desks live in the
browser because they are about *this screen* — where your windows are, what you like typed. A
list of things to do is about the work, and the work is what you look at from the desk in the
morning and from a phone on the train. A note written on one and invisible on the other would
be worse than no list at all.

Deliberately few fields. Every to-do list grows tags, priorities, projects and recurrence
until it is a second job; this one is a line of text, one of three states, and — asked for on
2026-10-17 — a deadline with a reminder, because "Argus should remind me" is the one thing a
sticky note on a monitor cannot do. The reminder is a bell (and so ntfy on the phone); a calendar
of your own is offered from the page, not reached from here: no accounts, no mail server.
"""

from __future__ import annotations

import json
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

STATES = ("open", "doing", "done")
MAX_NOTE = 500
# Enough for a working list, small enough that the file stays something a person can read and
# fix in an editor. Past it, the oldest *done* one goes — never an open one.
KEEP = 500
# A deadline: a day, or a day and a time, in the machine's local time ("2026-10-20", "2026-10-20T15:00").
DUE = re.compile(r"\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?")
# How long before the deadline to ring, in minutes. None: no reminder.
REMINDS = (0, 15, 60, 1440, 10080)
# A deadline with no time is a day: its reminder is for the morning of it (or before), not midnight.
MORNING = 9


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
        "due": clean_due(raw.get("due")),
        "remind": clean_remind(raw.get("remind")),
        # When its reminder rang, so it rings once; cleared when the deadline or the reminder moves.
        "reminded": float(raw.get("reminded") or 0),
    }


def clean_due(raw) -> str:
    said = str(raw or "").strip()
    if not said:
        return ""
    if not DUE.fullmatch(said):
        raise ValueError("a deadline is a day (2026-10-20), or a day and a time (2026-10-20T15:00)")
    try:
        datetime.fromisoformat(said)
    except ValueError as e:
        raise ValueError(f"{said} is not a day on the calendar") from e
    return said


def clean_remind(raw) -> int | None:
    if raw is None or raw == "" or raw is False:
        return None
    try:
        minutes = int(raw)
    except (TypeError, ValueError) as e:
        raise ValueError("remind is minutes before the deadline: 0, 15, 60, 1440 or 10080") from e
    if minutes not in REMINDS:
        raise ValueError("remind is minutes before the deadline: 0, 15, 60, 1440 or 10080")
    return minutes


def due_at(one: dict) -> float | None:
    """The deadline as a moment: the time given, or the end of the day for a day alone."""
    if not one.get("due"):
        return None
    when = datetime.fromisoformat(one["due"])
    if "T" not in one["due"]:
        when = when.replace(hour=23, minute=59)
    return when.timestamp()


def ring_at(one: dict) -> float | None:
    """When its reminder rings: the deadline minus `remind` — for a day alone, counted from nine
    in the morning of it, so "on the day" is the morning and "a day before" the morning before."""
    if not one.get("due") or one.get("remind") is None:
        return None
    when = datetime.fromisoformat(one["due"])
    if "T" not in one["due"]:
        when = when.replace(hour=MORNING, minute=0)
    return when.timestamp() - one["remind"] * 60


def reminders_due(items: list[dict], now: float | None = None) -> list[dict]:
    """The ones whose reminder should ring now: not done, not rung yet, and its moment passed."""
    now = time.time() if now is None else now
    out = []
    for one in items:
        at = ring_at(one)
        if at is not None and one["status"] != "done" and not one.get("reminded") and now >= at:
            out.append(one)
    return out


def loads_quietly(raw) -> dict | None:
    """clean_one for the file: an item whose deadline does not read is kept, without it."""
    try:
        return clean_one(raw)
    except ValueError:
        if isinstance(raw, dict):
            return clean_one({**raw, "due": "", "remind": None})
        return None


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
    out = [one for one in (loads_quietly(x) for x in raw) if one]
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


def add(items: list[dict], note: str, status: str = "open", due: str = "", remind=None) -> tuple[list[dict], dict]:
    made = clean_one({"note": note, "status": status, "due": due, "remind": remind})
    if not made:
        raise ValueError("a note needs some words in it")
    made["n"] = max((x["n"] for x in number(items)), default=0) + 1
    # Newest first is the order they are read in, and the order they are written in.
    return trim([made, *items]), made


UNSET = object()


def change(items: list[dict], ident: str, note: str | None, status: str | None,
           by: str = "", due=UNSET, remind=UNSET) -> tuple[list[dict], dict | None]:
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
        if due is not UNSET:
            edited["due"] = clean_due(due)
            edited["reminded"] = 0
        if remind is not UNSET:
            edited["remind"] = clean_remind(remind)
            edited["reminded"] = 0
        if not edited["due"]:
            edited["remind"] = None
        found = edited
        out.append(edited)
    return out, found


def remove(items: list[dict], ident: str) -> tuple[list[dict], bool]:
    ident = find(items, ident) or ident
    left = [x for x in items if x["id"] != ident]
    return left, len(left) != len(items)


def mark_reminded(items: list[dict], ids: set[str], now: float | None = None) -> list[dict]:
    now = time.time() if now is None else now
    for one in items:
        if one["id"] in ids:
            one["reminded"] = now
    return items


def reminder_words(one: dict) -> str:
    """What the bell says: the to-do, and when it is due, in words."""
    when = datetime.fromisoformat(one["due"])
    day = when.strftime("%a %d %b")
    at = f" {when.strftime('%H:%M')}" if "T" in one["due"] else ""
    late = due_at(one) is not None and time.time() > due_at(one)
    return f"#{one['n']} {one['note']} — {'was due' if late else 'due'} {day}{at}"

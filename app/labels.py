"""A word of your own on a process: what that `java` using 2 GB actually is.

Kept on the server, beside the config, like the pinned folders — a note written on the phone
should be there on the desk.

A label belongs to **one process**, not to a number. PIDs are recycled: the label written on
pid 4242 must not turn up on whatever the kernel hands 4242 to next week. So a process is
known by its pid *and the moment it started* (field 22 of /proc/<pid>/stat, in clock ticks
since boot), and a label whose process has gone is dropped the next time the store is read.
When the job ends, its note ends with it — which is also what keeps the file small.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

# Enough for "cgDist rerun of the Listeria batch, ask Marco before killing", not a document.
MAX_LABEL = 80


def default_store(config_path: Path) -> Path:
    return config_path.parent / "labels.json"


def parse_start(stat: str) -> int | None:
    """Field 22 (starttime) of /proc/<pid>/stat.

    The command name, field 2, is in parentheses and may itself contain spaces and
    parentheses — `(tmux: server)`, `(Web Content)` — so the fields are counted from after
    the *last* `)`, never by splitting the whole line."""
    close = stat.rfind(")")
    if close < 0:
        return None
    rest = stat[close + 1:].split()
    # rest[0] is field 3 (state); starttime is field 22, so rest[19].
    try:
        return int(rest[19])
    except (IndexError, ValueError):
        return None


def identity(pid: int) -> str | None:
    """`pid@starttime`, or None for a process that is not there (or cannot be read)."""
    try:
        stat = Path(f"/proc/{int(pid)}/stat").read_text(encoding="utf-8", errors="replace")
    except (OSError, ValueError):
        return None
    start = parse_start(stat)
    return f"{int(pid)}@{start}" if start is not None else None


def clean_label(text) -> str:
    """One line of ordinary text: control characters out, whitespace folded, capped."""
    raw = "".join(ch if ch.isprintable() else " " for ch in str(text or ""))
    return " ".join(raw.split())[:MAX_LABEL]


def load(store: Path | None) -> dict[str, dict]:
    """Every stored label, keyed by identity — including the dead ones; see `living`."""
    if not store:
        return {}
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(data, dict):
        return {}
    out = {}
    for key, value in data.items():
        if isinstance(key, str) and "@" in key and isinstance(value, dict):
            label = clean_label(value.get("label"))
            if label:
                out[key] = {"label": label, "command": str(value.get("command", ""))[:300],
                            "at": float(value.get("at", 0) or 0)}
    return out


def save(store: Path, doc: dict[str, dict]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Beside the target and renamed over it: a crash mid-write leaves the old file, never half
    # of a new one.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def living(doc: dict[str, dict], alive=identity) -> dict[str, dict]:
    """Only the labels whose process is still the same process."""
    out = {}
    for key, value in doc.items():
        pid = key.split("@", 1)[0]
        if pid.isdigit() and alive(int(pid)) == key:
            out[key] = value
    return out


def current(store: Path | None) -> dict[str, dict]:
    """The living labels — and the dead ones written out of the file while we are at it."""
    doc = load(store)
    alive = living(doc)
    if store and len(alive) != len(doc):
        try:
            save(store, alive)
        except OSError:
            pass
    return alive


def by_pid(labels: dict[str, dict]) -> dict[int, str]:
    return {int(key.split("@", 1)[0]): value["label"] for key, value in labels.items()}


def put(store: Path, pid: int, label, command: str = "") -> dict | None:
    """Label a process, or clear its label with an empty one. None when there is no such
    process — a label for something that is not running is a note about nothing."""
    key = identity(pid)
    if key is None:
        return None
    doc = current(store)
    text = clean_label(label)
    if text:
        doc[key] = {"label": text, "command": command[:300], "at": time.time()}
    else:
        doc.pop(key, None)
    save(store, doc)
    return {"pid": int(pid), "label": text}


def attach(rows: list[dict], labels: dict[int, str]) -> list[dict]:
    """Give every row that has a pid its label ("" when it has none). Rows without a pid —
    the invented ones of a demo, a port nobody can be seen holding — get "" as well, so the
    field is always there and a reader never has to ask whether it exists."""
    for row in rows:
        pid = row.get("pid")
        row["label"] = labels.get(pid, "") if isinstance(pid, int) else ""
    return rows

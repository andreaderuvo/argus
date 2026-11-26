"""A copy of what it takes to bring the agents back, kept somewhere else.

The register (resume.py) brings agents back after a reboot or a tmux server that died: the conversations are
still on the disk. A disk that breaks, or a machine that is gone, takes the conversations with it, and the
register and the desks too ("if the machine dies I lose every tmux and the agents' histories", 2026-11-26).

So, every few minutes, into each folder chosen in Settings → Backup:

    <place>/manifest.json   which sessions held which agent, in which folder, on which conversation
    <place>/home/…          each of those conversations, at its path under the home folder
                            (~/.claude/projects/<folder>/<id>.jsonl and its <id>/ folder, ~/.codex/sessions/…)
    <place>/argus/…         the desks and preferences, notes, to-dos, favourites, labels
    <place>/README.txt      what this is, in words

Never a secret: not the config (it holds the token), not device, sync or computer keys. A conversation only
grows, so a copy that is a prefix of it is carried on from where it stopped rather than written again; anything
else is copied whole, through a part file. Nothing in a backup is ever deleted by it.

Restoring copies conversations back where they are missing or shorter (never over a longer one), the desks,
notes and to-dos only where there are none, and puts the sessions on the register's lost list — the Sessions
screen then offers them back, each on its own conversation, exactly as after a reboot.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import time
from pathlib import Path

EVERY = float(os.environ.get("ARGUS_BACKUP_EVERY", "600"))     # seconds between two copies
CHECK = 4096                                                   # bytes compared before carrying a copy on
STATE = ("prefs.json", "agents-seen.json", "todo.json", "favourites.json", "labels.json")
README = """This folder is a backup made by Argus.

It holds what it takes to bring your agents back on this machine or another one: which session ran which
agent, in which folder, on which conversation (manifest.json); the conversations themselves (home/); and your
desks, notes and to-dos (argus/). No password, token or key is in it.

To use it: in Argus, Settings -> Backup -> Bring the agents back from a backup, and choose this folder.
Argus puts the conversations back and the Sessions screen offers every agent again, on its own conversation.
"""


def settings_path(config_path: Path) -> Path:
    return config_path.parent / "backup.json"


def load(path: Path | None) -> dict:
    out = {"places": [], "last": None}
    if path and path.exists():
        try:
            said = json.loads(path.read_text())
            if isinstance(said, dict):
                out["places"] = [p for p in said.get("places") or [] if isinstance(p, str)]
                out["last"] = said.get("last") if isinstance(said.get("last"), dict) else None
        except (OSError, ValueError):
            pass
    return out


def save(path: Path, data: dict) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, indent=1))
    os.replace(tmp, path)


def check_place(place: str) -> str:
    """An absolute folder that exists or can be made. Returned normalised; ValueError in words otherwise."""
    if not isinstance(place, str) or not place.strip():
        raise ValueError("a folder is needed")
    p = Path(os.path.expanduser(place.strip()))
    if not p.is_absolute():
        raise ValueError(f"{place}: write the whole path, from /")
    p = Path(os.path.normpath(p))
    probe = p
    while not probe.exists():
        if probe.parent == probe:
            raise ValueError(f"{place}: no part of it exists")
        probe = probe.parent
    if not probe.is_dir():
        raise ValueError(f"{probe} is a file, not a folder")
    if not os.access(probe, os.W_OK):
        raise ValueError(f"{probe}: Argus may not write there")
    return str(p)


def conversation_files(home: Path, record: dict) -> list[Path]:
    """The files that hold one agent's conversation, under `home`."""
    conv = str(record.get("conversation") or "")
    if not conv or "/" in conv or ".." in conv:
        return []
    agent = record.get("agent")
    found: list[Path] = []
    if agent == "claude":
        for f in (home / ".claude" / "projects").glob(f"*/{conv}.jsonl"):
            found.append(f)
            side = f.with_suffix("")                     # <id>/: its subagents and the tool results kept aside
            if side.is_dir():
                found.extend(x for x in side.rglob("*") if x.is_file() and not x.is_symlink())
    elif agent == "codex":
        found.extend((home / ".codex" / "sessions").glob(f"*/*/*/rollout-*-{conv}.jsonl"))
    return [f for f in found if f.is_file() and not f.is_symlink()]


def copy_one(src: Path, dst: Path) -> int:
    """`src` to `dst`, carrying on from where an earlier copy stopped when that copy is a prefix of it.
    Returns the bytes written (0: already the same)."""
    st = src.stat()
    try:
        have = dst.stat()
    except FileNotFoundError:
        have = None
    if have and have.st_size == st.st_size and int(have.st_mtime) >= int(st.st_mtime):
        return 0
    dst.parent.mkdir(parents=True, exist_ok=True)
    if have and 0 < have.st_size < st.st_size:
        start = max(0, have.st_size - CHECK)
        with open(src, "rb") as a, open(dst, "rb") as b:
            a.seek(start)
            b.seek(start)
            same = a.read(have.st_size - start) == b.read()
        if same:
            with open(src, "rb") as a, open(dst, "ab") as b:
                a.seek(have.st_size)
                written = 0
                while chunk := a.read(1 << 20):
                    b.write(chunk)
                    written += len(chunk)
            os.utime(dst, (st.st_atime, st.st_mtime))
            return written
    part = dst.with_name(dst.name + ".part")
    shutil.copyfile(src, part)
    os.utime(part, (st.st_atime, st.st_mtime))
    os.replace(part, dst)
    return st.st_size


def sessions_of(ledger_data: dict) -> dict[str, dict]:
    """Every session worth bringing back: the lost ones not brought back yet, and the running ones."""
    out = {n: {k: v for k, v in rec.items() if k != "lost_at"} for n, rec in (ledger_data.get("lost") or {}).items()}
    out.update(ledger_data.get("sessions") or {})
    return {n: rec for n, rec in out.items() if isinstance(rec, dict) and rec.get("agent")}


def run(places: list[str], home: Path, ledger_data: dict, config_dir: Path, notes_dir: Path | None) -> dict:
    """One copy into every place. Returns what was done, place by place, in words a page can show."""
    sessions = sessions_of(ledger_data)
    convs: list[Path] = []
    for rec in sessions.values():
        convs.extend(conversation_files(home, rec))
    state = [config_dir / name for name in STATE if (config_dir / name).is_file()]
    notes = []
    if notes_dir and Path(notes_dir).is_dir():
        notes = [f for f in Path(notes_dir).rglob("*") if f.is_file() and not f.is_symlink()
                 and ".trash" not in f.relative_to(notes_dir).parts]
    size = sum(f.stat().st_size for f in convs)
    report = {"at": time.time(), "sessions": len(sessions), "conversations": len(convs), "bytes": size, "places": []}
    for place in places:
        root = Path(place)
        one = {"place": place, "ok": False, "written": 0}
        try:
            root.mkdir(parents=True, exist_ok=True)
            written = 0
            rels = []
            for f in convs:
                rel = f.relative_to(home)
                rels.append(str(rel))
                written += copy_one(f, root / "home" / rel)
            for f in state:
                written += copy_one(f, root / "argus" / f.name)
            for f in notes:
                written += copy_one(f, root / "argus" / "notes" / f.relative_to(notes_dir))
            manifest = {"made": report["at"], "host": socket.gethostname(), "home": str(home),
                        "sessions": sessions, "conversations": sorted(set(rels))}
            tmp = root / "manifest.json.part"
            tmp.write_text(json.dumps(manifest, indent=1))
            os.replace(tmp, root / "manifest.json")
            if not (root / "README.txt").exists():
                (root / "README.txt").write_text(README)
            one.update(ok=True, written=written)
        except OSError as e:
            one["error"] = f"{e.strerror or e}: {e.filename or place}"
        report["places"].append(one)
    return report


def look(place: str) -> dict:
    """What a backup holds, for the page to show before anything is restored."""
    root = Path(place)
    try:
        manifest = json.loads((root / "manifest.json").read_text())
    except FileNotFoundError:
        raise ValueError(f"{place}: no Argus backup here (no manifest.json)") from None
    except (OSError, ValueError) as e:
        raise ValueError(f"{place}: the backup cannot be read ({e})") from None
    sessions = manifest.get("sessions") or {}
    return {"place": place, "made": manifest.get("made"), "host": manifest.get("host"), "home": manifest.get("home"),
            "sessions": [{"name": n, "agent": r.get("agent"), "cwd": r.get("cwd"),
                          "conversation": r.get("conversation")} for n, r in sorted(sessions.items())]}


def restore(place: str, home: Path, ledger, alive: set[str], config_dir: Path, notes_dir: Path | None) -> dict:
    """Conversations back where missing or shorter, Argus's own files where there are none, and the sessions
    offered back on the Sessions screen. Never overwrites anything longer or already there."""
    root = Path(place)
    manifest = json.loads((root / "manifest.json").read_text())
    back = 0
    for rel in manifest.get("conversations") or []:
        if rel.startswith("/") or ".." in Path(rel).parts:
            continue
        src, dst = root / "home" / rel, home / rel
        if not src.is_file():
            continue
        if dst.exists() and dst.stat().st_size >= src.stat().st_size:
            continue
        back += 1
        copy_one(src, dst)
    # Their side folders (subagents, tool results), file by file, the same rule.
    for side in (root / "home" / ".claude" / "projects").glob("*/*/"):
        for src in side.rglob("*"):
            if src.is_file():
                dst = home / src.relative_to(root / "home")
                if not dst.exists():
                    copy_one(src, dst)
    kept = []
    for name in STATE:
        src, dst = root / "argus" / name, config_dir / name
        if name == "agents-seen.json" or not src.is_file() or dst.exists():
            continue
        copy_one(src, dst)
        kept.append(name)
    if notes_dir and (root / "argus" / "notes").is_dir():
        for src in (root / "argus" / "notes").rglob("*"):
            dst = Path(notes_dir) / src.relative_to(root / "argus" / "notes")
            if src.is_file() and not dst.exists():
                copy_one(src, dst)
    offered = []
    now = time.time()
    for name, rec in (manifest.get("sessions") or {}).items():
        if name in alive or not isinstance(rec, dict) or not rec.get("agent"):
            continue
        ledger.data["lost"][name] = {**rec, "lost_at": now, "from_backup": place}
        offered.append(name)
    ledger.save()
    return {"conversations": back, "kept": kept, "offered": sorted(offered)}

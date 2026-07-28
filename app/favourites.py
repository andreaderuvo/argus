"""Pinned files and folders.

Kept on the server, next to the config, rather than in each browser's storage: the whole
point of the app is reaching the same machine from the desk and from a phone, and a
shortcut that exists on only one of them is half a feature.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


def load(store: Path) -> list[str]:
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(data, list):
        return []
    # Deduplicate while keeping the order they were pinned in.
    return list(dict.fromkeys(str(x) for x in data if isinstance(x, str) and x.startswith("/")))


def save(store: Path, paths: list[str]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Write beside the target and rename: a crash mid-write must not leave a truncated
    # list where a valid one used to be.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(json.dumps(paths, indent=1), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def toggle(paths: list[str], path: str) -> tuple[list[str], bool]:
    """Returns the new list and whether `path` is pinned afterwards."""
    if path in paths:
        return [p for p in paths if p != path], False
    return [*paths, path], True


def describe(paths: list[str]) -> list[dict]:
    """Decorate each pin for the UI. A pin whose target has gone is reported as missing
    rather than dropped: the user pinned it, so removing it is their call."""
    out = []
    for p in paths:
        target = Path(p)
        try:
            exists = target.exists()
            is_dir = target.is_dir()
        except OSError:
            exists, is_dir = False, False
        out.append({
            "path": p,
            "name": target.name or p,
            "type": "directory" if is_dir else "file",
            "missing": not exists,
        })
    return out


def default_store(config_path: Path) -> Path:
    return config_path.parent / "favourites.json"


def relocate(store: Path, old: str, new: str) -> list[str]:
    """Follow a rename or a move, so pinning something does not mean never touching it."""
    paths = load(store)
    updated = [new if p == old else (new + p[len(old):] if p.startswith(old + os.sep) else p) for p in paths]
    if updated != paths:
        save(store, updated)
    return updated

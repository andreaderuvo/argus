"""Pinned files and folders.

Kept on the server, next to the config, rather than in each browser's storage: the whole
point of the app is reaching the same machine from the desk and from a phone, and a
shortcut that exists on only one of them is half a feature.
"""

from __future__ import annotations

import json
import os
from pathlib import Path


# The browser appears in three places and they are not the same tool: a sidebar you keep
# open all day, the main panes, and a window you opened for one job. One shared list of
# shortcuts across all three is a list that suits none of them.
GROUPS = ("main", "sidebar", "windows")


def clean(items) -> list[str]:
    if not isinstance(items, list):
        return []
    # Deduplicate while keeping the order they were pinned in.
    return list(dict.fromkeys(str(x) for x in items if isinstance(x, str) and x.startswith("/")))


def load(store: Path) -> dict[str, list[str]]:
    """Always a full map, whatever is on disk — including the flat list this used to be,
    which is copied into every group so nothing appears to have been lost."""
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {g: [] for g in GROUPS}

    if isinstance(data, list):
        shared = clean(data)
        return {g: list(shared) for g in GROUPS}
    if not isinstance(data, dict):
        return {g: [] for g in GROUPS}
    return {g: clean(data.get(g)) for g in GROUPS}


def group_of(name: str | None) -> str:
    return name if name in GROUPS else "main"


def save(store: Path, paths: dict[str, list[str]]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    # Write beside the target and rename: a crash mid-write must not leave a truncated
    # list where a valid one used to be.
    tmp = store.with_suffix(".json.part")
    tmp.write_text(json.dumps(paths, indent=1), encoding="utf-8")
    tmp.chmod(0o600)
    tmp.replace(store)


def toggle(paths: dict[str, list[str]], group: str, path: str) -> tuple[dict[str, list[str]], bool]:
    """Returns the new map and whether `path` is pinned in that group afterwards."""
    group = group_of(group)
    current = paths.get(group, [])
    pinned = path not in current
    updated = dict(paths)
    updated[group] = [*current, path] if pinned else [p for p in current if p != path]
    return updated, pinned


def describe_all(paths: dict[str, list[str]]) -> dict[str, list[dict]]:
    return {g: describe(paths.get(g, [])) for g in GROUPS}


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


def relocate(store: Path, old: str, new: str) -> dict[str, list[str]]:
    """Follow a rename or a move, so pinning something does not mean never touching it."""
    paths = load(store)
    moved = lambda p: new if p == old else (new + p[len(old):] if p.startswith(old + os.sep) else p)
    updated = {g: [moved(p) for p in items] for g, items in paths.items()}
    if updated != paths:
        save(store, updated)
    return updated

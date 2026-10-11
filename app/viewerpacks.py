"""Viewers and editors anybody can mount for the files they care about.

A pack is a folder with a `viewer.json`:

    {"name": "diff", "title": "Diff", "files": ["*.diff", "*.patch"],
     "entry": "index.html", "edits": false, "binary": false}

Argus ships some in `static/viewers/`; anyone adds theirs to `<config>/viewers/<name>/`, and a
pack of theirs with a built-in's name replaces it — the way a language file does.

A pack is somebody else's code, so it never runs in the page that holds the token. It runs in a
frame sandboxed without `allow-same-origin` (an opaque origin: no cookies, no storage of ours, no
reading the page around it), under a CSP that lets it load from this server and nowhere else and
connect to nothing at all. The page hands it the file over `postMessage` and does the saving
itself, through `/api/fs/write` — the jail, `allow_write` and the journal decide as they do for
the ordinary editor. What a pack can learn is the file it was opened on; what it can change is
that file, and only when it says `edits` and the server allows writing.
"""

from __future__ import annotations

import fnmatch
import json
import re
from pathlib import Path

NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,39}$")
MANIFEST = "viewer.json"

# The frame's rules. `sandbox allow-scripts` repeats the iframe's attribute in the header, so a
# pack opened on its own (its address typed into a tab) is still in a box. Nothing may be
# fetched from another host, and nothing at all by fetch/XHR/WebSocket: a pack has no business
# talking to anybody, and that is also what keeps a file it was shown from leaving the machine.
CSP = ("sandbox allow-scripts allow-downloads; default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; "
       "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; "
       "media-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'none'; "
       "frame-src 'none'; form-action 'none'; base-uri 'none'")


class BadPack(Exception):
    """Not a viewer.json we can use."""


def read_manifest(folder: Path) -> dict:
    try:
        raw = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except OSError as e:
        raise BadPack(f"no {MANIFEST} in {folder.name}") from e
    except ValueError as e:
        raise BadPack(f"{MANIFEST} is not JSON: {e}") from e
    if not isinstance(raw, dict):
        raise BadPack(f"{MANIFEST} is not an object")
    name = str(raw.get("name") or folder.name).strip().lower()
    if not NAME.match(name):
        raise BadPack("a name is lower-case letters, digits and dashes, up to 40")
    if name != folder.name:
        raise BadPack(f"the folder is {folder.name!r} and the name {name!r}: they must be the same")
    files = raw.get("files") or []
    if isinstance(files, str):
        files = [files]
    if not isinstance(files, list) or not all(isinstance(f, str) and f.strip() for f in files):
        raise BadPack("`files` is a list of patterns, like [\"*.diff\", \"*.patch\"]")
    entry = str(raw.get("entry") or "index.html")
    if entry.startswith("/") or ".." in Path(entry).parts:
        raise BadPack("`entry` is a file inside the pack")
    if not (folder / entry).is_file():
        raise BadPack(f"`entry` {entry} is not in the pack")
    # Its own words in other languages, {"it": {"Side by side": "Affiancato"}}: handed to the
    # frame for the page's language, since a pack cannot fetch a catalogue.
    words = {}
    for code, table in (raw.get("words") or {}).items() if isinstance(raw.get("words"), dict) else ():
        if isinstance(table, dict) and re.match(r"^[a-z]{2}(-[a-z]{2})?$", str(code)):
            words[str(code)] = {str(k)[:200]: str(v)[:400] for k, v in list(table.items())[:300]}
    return {
        "words": words,
        "name": name,
        "title": str(raw.get("title") or name).strip()[:40],
        "description": str(raw.get("description") or "").strip()[:200],
        "files": [f.strip().lower() for f in files][:40],
        "entry": entry,
        "edits": bool(raw.get("edits")),
        "binary": bool(raw.get("binary")),
    }


def available(builtin: Path, user: Path) -> tuple[list[dict], list[dict]]:
    """Every pack that reads, and the ones that do not with the reason — a pack you are writing
    should say why it is not in the list, not just be missing from it. Yours first, so a pattern
    both claim goes to yours."""
    found: dict[str, dict] = {}
    broken: list[dict] = []
    for source, folder in (("builtin", builtin), ("yours", user)):
        if not folder.is_dir():
            continue
        for one in sorted(p for p in folder.iterdir() if p.is_dir()):
            try:
                pack = read_manifest(one)
            except BadPack as e:
                broken.append({"folder": one.name, "source": source, "error": str(e)})
                continue
            pack["source"] = source
            found[pack["name"]] = pack           # yours, read second, replaces a built-in
    packs = sorted(found.values(), key=lambda p: (p["source"] != "yours", p["name"]))
    return packs, broken


def for_file(packs: list[dict], leaf: str) -> dict | None:
    """The first pack whose patterns take this file name."""
    leaf = leaf.lower()
    for pack in packs:
        if any(fnmatch.fnmatchcase(leaf, pat) for pat in pack["files"]):
            return pack
    return None


def locate(builtin: Path, user: Path, name: str, rel: str) -> Path | None:
    """A file of a pack, never outside it: resolved, then checked to be under the pack's own
    folder (a link out of it is refused like a `..`)."""
    if not NAME.match(name or ""):
        return None
    for root in (user, builtin):
        folder = root / name
        if not (folder / MANIFEST).is_file():
            continue
        base = folder.resolve()
        target = (folder / (rel or "index.html")).resolve()
        if target.is_relative_to(base) and target.is_file():
            return target
        return None
    return None

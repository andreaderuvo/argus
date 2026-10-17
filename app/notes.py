"""Notes: one folder of Argus's own, every note a file in it.

A scratch pad that was a window per paste — paste, save, a path — became a place: every note
listed, the latest first, opened and written in place, saved as you type. Plain files on purpose,
so an agent can be handed a path and read it (or write it: the list notices), and so nothing about
them is locked inside Argus.

The folder is `notes` beside the config, or `notes_dir`. It is Argus's, like the labels and the
favourites, so writing in it does not need `allow_write`: it touches nothing of yours but itself.
A name is one plain file name, never a path; a delete moves the note into `.trash` inside the
folder, never straight to nothing.
"""

from __future__ import annotations

import os
import re
import time
from pathlib import Path

from fastapi import APIRouter, Request

from .errors import ApiError

router = APIRouter(tags=["Notes"])

# A note is text somebody typed or pasted. Bigger than this is a file, and belongs in a folder.
MAX_NOTE = 4 * 1024 * 1024
SUFFIXES = {".md", ".txt"}
NAME = re.compile(r"[^/\\\0]{1,120}")
TITLE_CHARS = 80


def default_dir(config_path: Path) -> Path:
    return config_path.parent / "notes"


def folder(request: Request) -> Path:
    where = getattr(request.app.state, "notes", None)
    if not where:
        raise ApiError(404, "this Argus keeps no notes (no notes_dir and no config folder)")
    where = Path(where)
    where.mkdir(parents=True, exist_ok=True)
    return where


def checked(name: str) -> str:
    """One file name, of a note: no folders, nothing hidden, a suffix a text editor would take."""
    name = (name or "").strip()
    if not NAME.fullmatch(name) or name in {".", ".."} or name.startswith("."):
        raise ApiError(400, "a note's name is one file name: no / and not starting with a dot")
    if Path(name).suffix.lower() not in SUFFIXES:
        name += ".md"
    return name


def _path(request: Request, name: str) -> Path:
    where = folder(request)
    path = where / checked(name)
    # A link placed in the folder by hand must not make it a door to somewhere else.
    if path.is_symlink():
        raise ApiError(403, f"{path.name} is a link; notes are plain files")
    return path


def title_of(text: str) -> str:
    """The first line that says something, without its Markdown marks: what the list shows."""
    for line in text.splitlines():
        line = re.sub(r"^\s*(#+|[-*+>]|\d+\.)\s*", "", line).strip()
        if line:
            return line[:TITLE_CHARS]
    return ""


def describe(path: Path) -> dict:
    st = path.stat()
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            head = f.read(2048)
    except OSError:
        head = ""
    return {"name": path.name, "path": str(path), "size": st.st_size, "mtime": st.st_mtime,
            "title": title_of(head)}


@router.get("/api/notes", summary="Every note, the latest first")
def list_notes(request: Request) -> dict:
    where = folder(request)
    notes = []
    for entry in os.scandir(where):
        if entry.name.startswith(".") or not entry.is_file(follow_symlinks=False):
            continue
        if Path(entry.name).suffix.lower() not in SUFFIXES:
            continue
        try:
            notes.append(describe(Path(entry.path)))
        except OSError:
            continue                      # gone between the listing and the look
    notes.sort(key=lambda n: n["mtime"], reverse=True)
    return {"dir": str(where), "notes": notes}


@router.get("/api/notes/note", summary="One note's text")
def read_note(request: Request, name: str) -> dict:
    path = _path(request, name)
    if not path.is_file():
        raise ApiError(404, f"no note called {path.name}")
    if path.stat().st_size > MAX_NOTE:
        raise ApiError(413, f"{path.name} is bigger than a note ({MAX_NOTE // (1024 * 1024)} MB)")
    return {**describe(path), "text": path.read_text(encoding="utf-8", errors="replace")}


def _write(path: Path, text: str) -> None:
    part = path.with_name(f".{path.name}.part")
    part.write_text(text, encoding="utf-8")
    os.replace(part, path)


@router.put("/api/notes/note", summary="Write a note (made if it is not there)")
async def write_note(request: Request, body: dict) -> dict:
    """`base` is the `mtime` the page last read: when the file has changed since — an agent wrote
    in it — nothing is written and the answer is `{conflict: true, note}`, the note as it is now,
    so nothing is overwritten unseen. A 200: it is an ordinary turn of events, not a mistake (and
    the browser harness counts every 4xx as one). `base: null` writes whatever is there."""
    path = _path(request, str(body.get("name") or ""))
    text = str(body.get("text") or "")
    if len(text.encode("utf-8")) > MAX_NOTE:
        raise ApiError(413, f"bigger than a note ({MAX_NOTE // (1024 * 1024)} MB)")
    base = body.get("base")
    if base is not None and path.exists() and abs(path.stat().st_mtime - float(base)) > 1e-3:
        return {"conflict": True, "note": read_note(request, path.name)}
    _write(path, text)
    return describe(path)


def next_name(where: Path, stem: str = "note") -> str:
    for n in range(1, 100000):
        name = f"{stem}-{n}.md"
        if not os.path.lexists(where / name):
            return name
    raise ApiError(409, "there is no free note name left")


@router.post("/api/notes", summary="A new note")
async def new_note(request: Request, body: dict | None = None) -> dict:
    """`name` if given (refused when taken), else the first free `note-N.md`; `text` its first
    words — a paste becomes a note in one call."""
    body = body or {}
    where = folder(request)
    name = checked(str(body["name"])) if body.get("name") else next_name(where)
    path = where / name
    if os.path.lexists(path):
        raise ApiError(409, f"{name} already exists")
    _write(path, str(body.get("text") or ""))
    return describe(path)


@router.post("/api/notes/append", summary="Add text at the end of a note (made if it is not there)")
async def append_note(request: Request, body: dict) -> dict:
    """What an agent does most: put a finding at the bottom of a note without reading it first. A
    blank line before it unless the note is empty or already ends with one."""
    path = _path(request, str(body.get("name") or ""))
    text = str(body.get("text") or "")
    if not text.strip():
        raise ApiError(400, "nothing to add")
    old = path.read_text(encoding="utf-8", errors="replace") if path.exists() else ""
    sep = "" if not old or old.endswith("\n\n") else "\n" if old.endswith("\n") else "\n\n"
    new = old + sep + text + ("" if text.endswith("\n") else "\n")
    if len(new.encode("utf-8")) > MAX_NOTE:
        raise ApiError(413, f"the note would be bigger than a note ({MAX_NOTE // (1024 * 1024)} MB)")
    _write(path, new)
    return describe(path)


@router.post("/api/notes/rename", summary="Give a note another name")
async def rename_note(request: Request, body: dict) -> dict:
    path = _path(request, str(body.get("name") or ""))
    to = _path(request, str(body.get("to") or ""))
    if not path.is_file():
        raise ApiError(404, f"no note called {path.name}")
    if to == path:
        return describe(path)
    if os.path.lexists(to):
        raise ApiError(409, f"{to.name} already exists")
    os.rename(path, to)
    return describe(to)


@router.delete("/api/notes/note", summary="Put a note in the notes' trash")
def delete_note(request: Request, name: str) -> dict:
    path = _path(request, name)
    if not path.is_file():
        raise ApiError(404, f"no note called {path.name}")
    trash = path.parent / ".trash"
    trash.mkdir(exist_ok=True)
    kept = trash / f"{time.strftime('%Y%m%d-%H%M%S')}-{path.name}"
    os.rename(path, kept)
    return {"deleted": path.name, "kept": str(kept)}

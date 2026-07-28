"""Mutating file operations: mkdir, rename, move, copy, delete.

Everything here is off unless `allow_write` is set, because the rest of the app is a
read-only viewer and that is a safe thing to leave running on a network. Every path —
source *and* destination — goes through the jail, and nothing ever overwrites silently.
"""

from __future__ import annotations

import asyncio
import contextlib
import shutil
from pathlib import Path

from fastapi import APIRouter, File, Form, Request, UploadFile
from pydantic import BaseModel

UPLOAD_CHUNK = 1 << 20

from .errors import ApiError
from .safepath import Denied, NotFound, PathError

router = APIRouter()


class NameBody(BaseModel):
    path: str
    name: str


class DestBody(BaseModel):
    path: str
    dest: str


class DeleteBody(BaseModel):
    path: str
    recursive: bool = False


def _writable(request: Request) -> None:
    if not request.app.state.cfg.allow_write:
        raise ApiError(403, "this server is read-only — start it with --allow-write to change that")


def _resolve(request: Request, path: str) -> Path:
    try:
        return request.app.state.jail.resolve(path)
    except NotFound:
        raise ApiError(404, "not found") from None
    except (Denied, PathError):
        raise ApiError(403, "outside the configured roots") from None


def _not_a_root(request: Request, p: Path) -> None:
    """A configured root is the floor of the jail: renaming or deleting it would leave
    the server pointing at nothing."""
    if p in request.app.state.jail.roots:
        raise ApiError(400, "that is a configured root — rename or remove it in the config")


def safe_name(name: str) -> str:
    """A single path component and nothing else: no separators, no traversal."""
    name = name.strip()
    if not name or name in (".", "..") or "/" in name or "\0" in name:
        raise ApiError(400, "that is not a usable file name")
    return name


def _free(target: Path) -> Path:
    if target.exists() or target.is_symlink():
        raise ApiError(409, f"{target.name} already exists here")
    return target


def _directory(p: Path) -> Path:
    if not p.is_dir():
        raise ApiError(400, "the destination is not a directory")
    return p


def _not_into_itself(src: Path, dst_dir: Path) -> None:
    if src == dst_dir or src in dst_dir.parents:
        raise ApiError(400, "a folder cannot be moved inside itself")


def _done(p: Path) -> dict:
    return {"ok": True, "path": str(p)}


@router.post("/api/fs/mkdir")
async def mkdir(request: Request, body: NameBody) -> dict:
    _writable(request)
    parent = _directory(_resolve(request, body.path))
    target = _free(parent / safe_name(body.name))
    try:
        target.mkdir()
    except OSError as e:
        raise ApiError(500, f"could not create the folder: {e.strerror}") from e
    return _done(target)


@router.post("/api/fs/rename")
async def rename(request: Request, body: NameBody) -> dict:
    _writable(request)
    src = _resolve(request, body.path)
    _not_a_root(request, src)
    target = _free(src.parent / safe_name(body.name))
    try:
        src.rename(target)
    except OSError as e:
        raise ApiError(500, f"could not rename: {e.strerror}") from e
    return _done(target)


@router.post("/api/fs/move")
async def move(request: Request, body: DestBody) -> dict:
    _writable(request)
    src = _resolve(request, body.path)
    _not_a_root(request, src)
    dst_dir = _directory(_resolve(request, body.dest))
    _not_into_itself(src, dst_dir)
    target = _free(dst_dir / src.name)
    try:
        shutil.move(str(src), str(target))
    except OSError as e:
        raise ApiError(500, f"could not move: {e.strerror}") from e
    return _done(target)


@router.post("/api/fs/copy")
async def copy(request: Request, body: DestBody) -> dict:
    _writable(request)
    src = _resolve(request, body.path)
    dst_dir = _directory(_resolve(request, body.dest))
    _not_into_itself(src, dst_dir)
    target = _free(dst_dir / src.name)
    try:
        if src.is_dir():
            # symlinks=True: copy links as links, so a link pointing out of the jail is
            # not silently turned into a real copy of whatever it pointed at.
            shutil.copytree(src, target, symlinks=True)
        else:
            shutil.copy2(src, target, follow_symlinks=False)
    except OSError as e:
        raise ApiError(500, f"could not copy: {e.strerror}") from e
    return _done(target)


@router.post("/api/fs/upload")
async def upload(
    request: Request,
    path: str = Form(...),
    files: list[UploadFile] = File(...),
) -> dict:
    """Receive files into a directory.

    Each one is streamed to a dotted part-file and renamed into place only once it is
    complete, so an interrupted upload never leaves a truncated file wearing the real
    name — which for a 40 GB fastq is the difference between "retry" and "silent
    corruption three steps down the pipeline".
    """
    _writable(request)
    dest = _directory(_resolve(request, path))
    limit = request.app.state.cfg.max_upload_bytes
    written = []

    for item in files:
        name = safe_name(Path(item.filename or "").name)
        target = _free(dest / name)
        part = dest / f".{name}.argus-part"
        size = 0
        try:
            with part.open("wb") as fh:
                while chunk := await item.read(UPLOAD_CHUNK):
                    size += len(chunk)
                    if limit and size > limit:
                        raise ApiError(413, f"{name} is larger than max_upload_bytes ({limit})")
                    # Writing is blocking; keep it off the event loop.
                    await asyncio.to_thread(fh.write, chunk)
            part.rename(target)
        except ApiError:
            with contextlib.suppress(OSError):
                part.unlink()
            raise
        except OSError as e:
            with contextlib.suppress(OSError):
                part.unlink()
            raise ApiError(500, f"could not write {name}: {e.strerror}") from e
        written.append({"path": str(target), "size": size})

    return {"ok": True, "files": written}


@router.post("/api/fs/delete")
async def delete(request: Request, body: DeleteBody) -> dict:
    _writable(request)
    src = _resolve(request, body.path)
    _not_a_root(request, src)
    try:
        if src.is_dir() and not src.is_symlink():
            if any(src.iterdir()) and not body.recursive:
                raise ApiError(409, "the folder is not empty — confirm to delete its contents")
            shutil.rmtree(src) if body.recursive else src.rmdir()
        else:
            src.unlink()
    except OSError as e:
        raise ApiError(500, f"could not delete: {e.strerror}") from e
    return {"ok": True, "path": str(src), "deleted": True}

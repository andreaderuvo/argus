"""Mutating file operations: mkdir, rename, move, copy, delete.

Everything here is off unless `allow_write` is set, because the rest of the app is a
read-only viewer and that is a safe thing to leave running on a network. Every path —
source *and* destination — goes through the jail, and nothing ever overwrites silently.
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import re
import shutil
import stat
import time
from pathlib import Path
from urllib.parse import urlsplit

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


class WriteBody(BaseModel):
    path: str
    content: str
    # What the editor believed the file was when it loaded it. A job writing to the same
    # file while someone reads it on a phone is the normal case here, not a rare one.
    mtime: int | None = None
    # Add to the end instead of replacing. For a file two writers share — the bridge two
    # agents pass work through — read-modify-write is not good enough: the window between
    # the read and the write is exactly where the other one's turn gets lost. An append is
    # one `write(2)` on a file opened `O_APPEND`, which the kernel does not interleave.
    append: bool = False


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


# A pasted screenshot has no name of its own — the clipboard offers "image.png" every
# time — so the server picks the next one that is free.
MAX_SEQUENCE = 9999


def next_free(folder: Path, base: str, suffix: str) -> Path:
    """`screenshot-1.png`, then `-2`, and so on. Never an existing file: the caller has
    just been told it may not overwrite anything."""
    for n in range(1, MAX_SEQUENCE + 1):
        candidate = folder / f"{base}-{n}{suffix}"
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    raise ApiError(409, f"there are already {MAX_SEQUENCE} files called {base}-N{suffix}")


def safe_suffix(name: str) -> str:
    """The extension of whatever arrived, or .png — a clipboard image is a PNG unless it
    says otherwise, and a suffix is not a place to accept arbitrary text."""
    suffix = Path(name or "").suffix.lower()
    return suffix if re.fullmatch(r"\.[a-z0-9]{1,8}", suffix) else ".png"


def _free(target: Path) -> Path:
    if target.exists() or target.is_symlink():
        raise ApiError(409, f"{target.name} already exists here")
    return target


def _spare(folder: Path, name: str) -> Path:
    """`report.pdf`, and then `report-2.pdf`, keeping the name it arrived with.

    For a destination the sender did not choose. Uploading into a folder you picked refuses
    a name that is taken — you are looking at that folder and can see what is in it. A file
    dropped on a session lands wherever the server keeps drops, and dropping the second
    version of a report there is the normal case, not a mistake worth a red message.
    """
    target = folder / name
    if not target.exists() and not target.is_symlink():
        return target
    stem, suffix = Path(name).stem, Path(name).suffix
    for n in range(2, MAX_SEQUENCE + 1):
        candidate = folder / f"{stem}-{n}{suffix}"
        if not candidate.exists() and not candidate.is_symlink():
            return candidate
    raise ApiError(409, f"there are already {MAX_SEQUENCE} files called {stem}-N{suffix}")


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


@router.post("/api/fs/fetch", summary="Put a link's file into a folder, without a round trip")
async def fetch_link(request: Request, body: dict) -> dict:
    """Download a URL straight into a directory.

    The upload you would otherwise do in three moves — open a terminal, `wget`, come back — or
    in four, if the file is on the far side of the machine you are holding: download it to a
    phone and upload it again. A link is the whole instruction.

    The same care as an upload, because it is one: streamed to a dotted part-file and renamed
    into place only when it is complete, so an interrupted download never leaves a truncated
    file wearing the real name. Nothing is ever overwritten; a name already taken gets a number.

    **On the obvious objection.** Yes, this makes the server fetch a URL somebody else chose,
    and yes, that URL could be `169.254.169.254` or a service on loopback. It grants nothing:
    whoever can call this can already open a terminal here and run `curl`, because that is what
    Argus *is*. It is behind `--allow-write` like every other route that puts something on the
    disk, and it is worth knowing rather than worth hiding.
    """
    _writable(request)
    url = str(body.get("url", "")).strip()
    if not url.lower().startswith(("http://", "https://")):
        raise ApiError(400, "only http and https links")
    dest = _directory(_resolve(request, str(body.get("path", ""))))
    limit = request.app.state.cfg.max_upload_bytes
    sent = clean_headers(body.get("headers"))

    import httpx

    said = str(body.get("name", "")).strip()
    part = None
    try:
        async with httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(30, read=300)) as client:
            async with client.stream("GET", url, headers=sent) as answer:
                if answer.status_code >= 400:
                    raise ApiError(502, f"{url} answered {answer.status_code}")
                # What to call it: what you said, or what the server called it, or the last
                # part of the address. A URL ending in a slash or a query gets a plain name
                # rather than something unusable.
                name = safe_name(said or from_disposition(answer.headers.get("content-disposition", ""))
                                 or Path(urlsplit(url).path).name or "download")
                target = _free(dest / name)
                part = dest / f".{target.name}.argus-part"
                # A length the other end declares is worth refusing on *before* the download
                # rather than after: no point spending ten minutes to reject it.
                declared = answer.headers.get("content-length")
                if limit and declared and declared.isdigit() and int(declared) > limit:
                    raise ApiError(413, f"that is {int(declared)} bytes and max_upload_bytes is {limit}")
                size = 0
                with part.open("wb") as fh:
                    async for chunk in answer.aiter_bytes(UPLOAD_CHUNK):
                        size += len(chunk)
                        if limit and size > limit:
                            raise ApiError(413, f"larger than max_upload_bytes ({limit})")
                        await asyncio.to_thread(fh.write, chunk)
        part.rename(target)
    except ApiError:
        if part:
            with contextlib.suppress(OSError):
                part.unlink()
        raise
    except httpx.HTTPError as e:
        if part:
            with contextlib.suppress(OSError):
                part.unlink()
        # httpx's own words, which say whether it was DNS, a refusal or a timeout.
        raise ApiError(502, f"could not fetch it: {type(e).__name__}: {e}") from e
    except OSError as e:
        if part:
            with contextlib.suppress(OSError):
                part.unlink()
        raise ApiError(500, f"could not write it: {e.strerror}") from e
    return {"name": target.name, "path": str(target), "bytes": size}


# Hop-by-hop headers belong to the connection, not to the request: passing them on is at best
# ignored and at worst confusing, and httpx sets its own.
NOT_YOURS = {"host", "content-length", "connection", "keep-alive", "transfer-encoding",
             "upgrade", "te", "trailer", "proxy-authorization"}


def clean_headers(said) -> dict[str, str]:
    """The headers a caller wants sent with the fetch — `Cookie`, `Authorization`, whatever.

    Because a link worth fetching is often behind a login. The alternative was: download it to
    your laptop, then upload it to the machine, which for a file the machine could have taken
    in one hop is a long way round — and on a phone it is worse.

    Nothing is stored. They are used for this one request and forgotten; the journal records
    that a fetch happened and to which route, never the body it came in.
    """
    if not isinstance(said, dict):
        return {}
    out: dict[str, str] = {}
    for name, value in list(said.items())[:24]:
        name = str(name).strip()
        value = str(value).strip()
        if not name or not value or name.lower() in NOT_YOURS:
            continue
        # A newline in a header value is header injection, and this one is handed to a client
        # that would otherwise write it out verbatim.
        if any(c in name + value for c in "\r\n"):
            raise ApiError(400, f"that {name} header has a line break in it")
        out[name] = value[:8192]
    return out


def from_disposition(header: str) -> str:
    """The filename a server suggests, if it suggests one that is not a trick.

    Only the last component: `filename="../../etc/passwd"` is a real thing that real servers
    have been persuaded to send, and `safe_name` upstream would catch it anyway — this makes
    the intent visible rather than relying on the next function along.
    """
    found = re.search(r'filename\*?=(?:UTF-8'')?"?([^";]+)"?', header, re.I)
    return Path(found.group(1)).name if found else ""


@router.post("/api/fs/upload")
async def upload(
    request: Request,
    path: str = Form(...),
    files: list[UploadFile] = File(...),
    # When set, the file is named `<sequence>-1.<ext>` and so on, instead of by whatever
    # the sender called it. This is what a pasted screenshot needs: the clipboard hands
    # over the same "image.png" every single time.
    sequence: str = Form(""),
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
    return {"ok": True, "files": await _receive(dest, files, limit, sequence=sequence)}


async def _receive(
    dest: Path,
    files: list[UploadFile],
    limit: int,
    *,
    sequence: str = "",
    beside: bool = False,
) -> list[dict]:
    """Stream each file into `dest` and return what landed.

    Shared by the two ways a file arrives, because the careful part is the same for both:
    a dotted part-file renamed into place only once it is whole. `beside` is the one
    difference — see :func:`_spare`.
    """
    written = []

    for item in files:
        if sequence:
            target = next_free(dest, safe_name(sequence), safe_suffix(item.filename))
            name = target.name
        else:
            name = safe_name(Path(item.filename or "").name)
            target = _spare(dest, name) if beside else _free(dest / name)
            name = target.name
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

    return written


@router.post("/api/fs/drop", summary="Put a file where drops land, and say where that is")
async def drop(
    request: Request,
    files: list[UploadFile] = File(...),
    # A pasted image has no name of its own — the clipboard offers "image.png" every time —
    # so the server numbers it, exactly as it does for one pasted into a folder.
    sequence: str = Form(""),
) -> dict:
    """Receive files dropped onto a session.

    A terminal is not a folder, so a file dropped on one has to land somewhere the sender
    did not choose — and the same somewhere every time, or the absolute path it is handed
    back means nothing the next day. That place is `drop_dir` in the config, and it is
    named here rather than by the client precisely because nobody was looking at a folder
    when they let go of the file.

    Created the first time something is dropped and never before: a machine where this is
    not used does not grow a directory for it.
    """
    _writable(request)
    cfg = request.app.state.cfg
    wanted = cfg.drops()
    if not wanted:
        raise ApiError(404, "`drop_dir` is empty in the config — this server takes no drops")

    if not wanted.is_dir():
        # Nothing is created until the jail has agreed to it. The jail can only answer about
        # a path that exists, so it is asked about the nearest ancestor that does — which is
        # the check that matters: a folder made under an approved ancestor is inside. The
        # config refuses a `drop_dir` outside the roots at startup too; this is the second
        # lock, on the code path that does the creating.
        if not request.app.state.jail.contains(_deepest(wanted)):
            raise ApiError(403, "`drop_dir` is outside the configured roots")
        try:
            wanted.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise ApiError(500, f"could not create {wanted}: {e.strerror}") from e

    dest = _directory(_resolve(request, str(wanted)))
    landed = await _receive(dest, files, cfg.max_upload_bytes, sequence=sequence, beside=True)
    return {"ok": True, "folder": str(dest), "files": landed}


def sweep_drops(folder: Path, days: int) -> list[str]:
    """Remove files in the drop folder older than `days`, and say which.

    Only that folder, only its own files, only by when they were last written. Not
    recursive: a directory in there was put there on purpose — nothing this app writes to
    the drop folder is a directory — and walking into one would turn a tidy-up into a
    recursive delete, which is not what anybody agreed to when they typed a number.

    Says which files went rather than only how many. A sweep nobody can audit is a sweep
    nobody should trust, and this one deletes without asking.
    """
    if not days or not folder or not folder.is_dir():
        return []
    cutoff = time.time() - days * 86400
    gone = []
    for entry in sorted(folder.iterdir()):
        try:
            if not entry.is_file() or entry.is_symlink():
                continue
            if entry.stat().st_mtime >= cutoff:
                continue
            entry.unlink()
            gone.append(str(entry))
        except OSError:
            continue                      # one file that will not go is not a failed sweep
    return gone


def _deepest(p: Path) -> Path:
    """The nearest ancestor of `p` that exists, canonicalized. What the jail can be asked
    about when the path itself is not there yet."""
    for candidate in [p, *p.parents]:
        if candidate.exists():
            with contextlib.suppress(OSError):
                return candidate.resolve(strict=True)
    return p


@router.post("/api/fs/write")
async def write(request: Request, body: WriteBody) -> dict:
    """Save an edited text file.

    Two things must hold. The file cannot have moved on since it was read — otherwise a
    phone would quietly undo whatever the running job just wrote — and a file too large
    to have been previewed whole must never be saved from a preview, because that
    preview was only its tail.
    """
    _writable(request)
    # A file that is not there yet is written, as long as the folder holding it is. The jail
    # cannot resolve a path that does not exist, so the *parent* is what gets checked — which
    # is the right check anyway: it is the directory that has to be inside the roots.
    try:
        target = _resolve(request, body.path)
    except ApiError as missing:
        if missing.status != 404:
            raise
        asked = Path(body.path)
        parent = _directory(_resolve(request, str(asked.parent)))
        target = parent / safe_name(asked.name)
        if target.exists():
            raise                       # it resolved to nothing but exists: a symlink out
        data = body.content.encode("utf-8")
        if len(data) > request.app.state.cfg.max_preview_bytes:
            raise ApiError(413, "too large to write in one go") from None
        target.write_bytes(data)
        return {"ok": True, "path": str(target), "size": len(data),
                "mtime": int(target.stat().st_mtime), "created": True}

    if target.is_dir():
        raise ApiError(400, "that is a directory")

    if body.append:
        data = body.content.encode("utf-8")
        if len(data) > request.app.state.cfg.max_preview_bytes:
            raise ApiError(413, "too large to add in one go")
        try:
            with target.open("ab") as f:
                f.write(data)
        except OSError as e:
            raise ApiError(500, f"could not add to it: {e.strerror}") from e
        st = target.stat()
        return {"ok": True, "path": str(target), "size": st.st_size, "mtime": int(st.st_mtime),
                "appended": len(data)}

    limit = request.app.state.cfg.max_preview_bytes
    st = target.stat()
    if st.st_size > limit:
        raise ApiError(413, "this file is too big to have been read whole — saving it would lose the rest")

    if body.mtime is not None and int(st.st_mtime) != body.mtime:
        raise ApiError(409, "the file changed on disk since you opened it — reload before saving")

    data = body.content.encode("utf-8")
    part = target.with_name(f".{target.name}.argus-part")
    try:
        part.write_bytes(data)
        # Keep whatever the file already was: a rename would otherwise hand it fresh
        # default permissions.
        os.chmod(part, stat.S_IMODE(st.st_mode))
        part.replace(target)
    except OSError as e:
        with contextlib.suppress(OSError):
            part.unlink()
        raise ApiError(500, f"could not save: {e.strerror}") from e

    return {"ok": True, "path": str(target), "size": len(data), "mtime": int(target.stat().st_mtime)}


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

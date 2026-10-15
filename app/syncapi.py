"""argus-sync: a folder of this machine kept in sync with a folder on someone's computer.

The client (the separate `argus-sync` program) holds a **sync key**: like a device token, but it
opens one folder and nothing else — no terminal, no sessions, no other file, no setting. It is
made in the page (Sync to your computer…), shown once, and taken back from the same place.

Everything the client says is relative to that folder (`p=sub/dir/file.txt`), and every answer is
checked twice: through the jail (the configured roots, symlinks resolved) and against the key's own
folder, so a link inside it pointing elsewhere is refused like any other way out.

The client decides what to do; the server makes each step safe on its own:

- a write lands in a temporary file beside the target and is renamed over it, so nobody ever reads
  half a file, and carries the time the client's copy was changed, so both sides agree on "same";
- a write or a delete may name what the client believes is there (`base`, the mtime it last saw):
  when the file changed meanwhile the answer is 409 with what is there now, and the client keeps
  both copies instead of losing one;
- a delete is a move into a trash beside the config (`sync-trash/<key>/<when>/…`), never an unlink:
  a client that got it wrong costs a trip to the trash, not the data.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse

from . import devices
from .errors import ApiError
from .safepath import Denied, NotFound, PathError

router = APIRouter(include_in_schema=False)      # private until argus-sync is published

KEY_PREFIX = "as_"                  # a sync key says what it is, in a log or a config
MAX_KEYS = 64
MAX_ENTRIES = 300_000               # a manifest bigger than this is refused rather than truncated
WRITE_CHUNK = 1 << 20
# Never listed, never written: what an operating system or an editor leaves behind on its own,
# and the server-side parts of a sync in progress.
IGNORED = {".DS_Store", "Thumbs.db", "desktop.ini", ".argus-sync"}
PART_PREFIX = ".argus-sync-"


def default_store(config_path: Path) -> Path:
    return config_path.parent / "sync-keys.json"


def trash_root(store: Path) -> Path:
    return store.parent / "sync-trash"


# ------------------------------------------------------------------------------------- keys

class SyncKeyError(Exception):
    pass


def load(store: Path | None) -> list[dict]:
    if not store:
        return []
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
        return [k for k in data.get("keys", []) if isinstance(k, dict) and k.get("hash")]
    except (OSError, ValueError):
        return []


def save(store: Path, keys: list[dict]) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    tmp = store.with_suffix(".tmp")
    tmp.write_text(json.dumps({"keys": keys}, indent=1) + "\n", encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, store)


def public(keys: list[dict]) -> list[dict]:
    return [{k: v for k, v in key.items() if k != "hash"} for key in keys]


def add(store: Path, path: Path, name: str, write: bool) -> tuple[dict, str]:
    keys = load(store)
    if len(keys) >= MAX_KEYS:
        raise SyncKeyError(f"{MAX_KEYS} sync keys already — take one back first")
    plain = KEY_PREFIX + secrets.token_urlsafe(devices.TOKEN_BYTES)
    entry = {"id": secrets.token_hex(6), "name": devices.tidy_name(name) or path.name or "argus-sync",
             "path": str(path), "write": bool(write), "created": int(time.time()), "last_seen": None,
             "hash": devices.fingerprint(plain)}
    keys.append(entry)
    save(store, keys)
    return entry, plain


def revoke(store: Path, key_id: str) -> dict:
    keys = load(store)
    gone = next((k for k in keys if k["id"] == key_id), None)
    if not gone:
        raise SyncKeyError("no such sync key")
    save(store, [k for k in keys if k["id"] != key_id])
    return gone


def matching(store: Path | None, presented: str) -> dict | None:
    """The key this token is, compared in constant time against every one."""
    if not presented or not presented.startswith(KEY_PREFIX):
        return None
    want = devices.fingerprint(presented)
    found = None
    for k in load(store):
        if hmac.compare_digest(k["hash"], want):
            found = k
    return found


def touch(store: Path, key: dict) -> None:
    now = time.time()
    if key.get("last_seen") and now - key["last_seen"] < devices.SEEN_EVERY:
        return
    keys = load(store)
    for k in keys:
        if k["id"] == key["id"]:
            k["last_seen"] = int(now)
    save(store, keys)


# ---------------------------------------------------------------------------------- paths

def _key(request: Request) -> dict:
    key = request.scope.get("argus_sync")
    if not key:
        raise ApiError(403, "these routes are for argus-sync, with a sync key")
    return key


def _folder(request: Request, key: dict) -> Path:
    try:
        folder = request.app.state.jail.resolve(key["path"])
    except NotFound:
        raise ApiError(410, "the synced folder is gone from the server") from None
    except (Denied, PathError):
        raise ApiError(403, "the synced folder is outside the configured roots now") from None
    if not folder.is_dir():
        raise ApiError(410, "the synced folder is not a folder any more")
    return folder


def clean_rel(rel: str) -> str:
    """`sub/dir/file.txt`, nothing else: no leading slash, no `..`, no empty parts, no backslash."""
    rel = str(rel or "").strip("/")
    parts = rel.split("/") if rel else []
    if any(p in ("", ".", "..") or "\\" in p or "\0" in p for p in parts):
        raise ApiError(400, f"not a path inside the folder: {rel!r}")
    if any(p in IGNORED or p.startswith(PART_PREFIX) for p in parts):
        raise ApiError(400, f"argus-sync does not carry {rel!r}")
    return "/".join(parts)


def _inside(request: Request, key: dict, rel: str, must_exist: bool = True) -> tuple[Path, Path]:
    """(folder, the path) — through the jail, and inside the key's folder."""
    folder = _folder(request, key)
    rel = clean_rel(rel)
    target = folder / rel if rel else folder
    try:
        real = request.app.state.jail.resolve(str(target))
    except NotFound:
        if must_exist:
            raise ApiError(404, "not found") from None
        real = target
        # Not there yet: its nearest existing ancestor must still be inside the folder.
        probe = target.parent
        while not os.path.lexists(probe):
            probe = probe.parent
        if not (Path(os.path.realpath(probe)) == folder or Path(os.path.realpath(probe)).is_relative_to(folder)):
            raise ApiError(403, "outside the synced folder")
    except (Denied, PathError):
        raise ApiError(403, "outside the synced folder") from None
    if not (real == folder or real.is_relative_to(folder)):
        raise ApiError(403, "outside the synced folder")
    return folder, real


def _writable(request: Request, key: dict) -> None:
    if not key.get("write"):
        raise ApiError(403, "this sync key only reads — make one that may write in Argus")
    if not request.app.state.cfg.allow_write:
        raise ApiError(403, "this server is read-only — start it with --allow-write to sync both ways")


def _state(p: Path) -> dict | None:
    try:
        st = os.lstat(p)
    except OSError:
        return None
    return {"s": st.st_size, "m": st.st_mtime_ns, "d": os.path.isdir(p) and not os.path.islink(p)}


def manifest(folder: Path) -> list[dict]:
    """Every file and folder under `folder`: `{p, d, s, m}` (m in nanoseconds). Symbolic links are
    not followed nor listed — one pointing out would be a way out, one pointing in a loop."""
    out: list[dict] = []
    for root, dirs, files in os.walk(folder, followlinks=False):
        rp = Path(root)
        rel_root = rp.relative_to(folder).as_posix()
        dirs[:] = sorted(d for d in dirs if d not in IGNORED and not d.startswith(PART_PREFIX)
                         and not os.path.islink(rp / d))
        for d in dirs:
            out.append({"p": f"{rel_root}/{d}" if rel_root != "." else d, "d": True, "s": 0, "m": 0})
        for f in sorted(files):
            if f in IGNORED or f.startswith(PART_PREFIX):
                continue
            full = rp / f
            try:
                st = os.lstat(full)
            except OSError:
                continue
            if not os.path.isfile(full) or os.path.islink(full):
                continue
            out.append({"p": f"{rel_root}/{f}" if rel_root != "." else f, "d": False, "s": st.st_size, "m": st.st_mtime_ns})
        if len(out) > MAX_ENTRIES:
            raise ApiError(413, f"more than {MAX_ENTRIES:,} files — sync a smaller folder")
    return out


def signature(entries: list[dict]) -> str:
    h = hashlib.sha256()
    for e in entries:
        h.update(f"{e['p']}\0{int(e['d'])}\0{e['s']}\0{e['m']}\n".encode())
    return h.hexdigest()[:32]


def _check_base(real: Path, base: str | None) -> None:
    """`base`: what the client last saw there — an mtime in ns, or `none` for "nothing". A change
    since is a conflict: 409, with what is there now."""
    if base is None or base == "":
        return
    now = _state(real)
    if base == "none":
        if now is not None:
            raise ApiError(409, json.dumps({"conflict": "exists", "now": now}))
        return
    if now is None:
        raise ApiError(409, json.dumps({"conflict": "gone"}))
    if str(now["m"]) != base:
        raise ApiError(409, json.dumps({"conflict": "changed", "now": now}))


def _to_trash(request: Request, key: dict, folder: Path, real: Path) -> str:
    store: Path = request.app.state.sync_store
    when = time.strftime("%Y-%m-%d_%H%M%S")
    dest = trash_root(store) / key["id"] / when / real.relative_to(folder)
    dest.parent.mkdir(parents=True, exist_ok=True)
    n = 1
    while os.path.lexists(dest):
        n += 1
        dest = dest.with_name(f"{real.name}.{n}")
    shutil.move(str(real), str(dest))
    return str(dest)


# --------------------------------------------------------------------------------- routes

@router.get("/api/sync/hello", summary="Who this sync key is")
async def hello(request: Request) -> dict:
    key = _key(request)
    folder = _folder(request, key)
    return {"name": key["name"], "folder": folder.name, "path": str(folder),
            "write": bool(key.get("write")) and bool(request.app.state.cfg.allow_write),
            "host": os.uname().nodename, "server_time_ns": time.time_ns()}


@router.get("/api/sync/manifest", summary="Every file in the synced folder, with size and time")
async def get_manifest(request: Request, since: str = "") -> dict:
    key = _key(request)
    folder = _folder(request, key)
    entries = await asyncio.to_thread(manifest, folder)
    sig = signature(entries)
    if since and since == sig:
        return {"same": True, "signature": sig}
    return {"same": False, "signature": sig, "entries": entries}


@router.get("/api/sync/file", summary="One file of the synced folder")
async def get_file(request: Request, p: str) -> FileResponse:
    key = _key(request)
    _, real = _inside(request, key, p)
    if not real.is_file():
        raise ApiError(400, "not a file")
    st = os.stat(real)
    return FileResponse(real, headers={"x-mtime-ns": str(st.st_mtime_ns), "cache-control": "no-store"},
                        filename=real.name, content_disposition_type="attachment")


@router.put("/api/sync/file", summary="Write one file of the synced folder")
async def put_file(request: Request, p: str, m: int, base: str | None = None) -> dict:
    """The body is the file. `m`: its modification time (ns) on the client, given to the copy here."""
    key = _key(request)
    _writable(request, key)
    folder, real = _inside(request, key, p, must_exist=False)
    if real == folder:
        raise ApiError(400, "that is the folder itself")
    if os.path.isdir(real):
        raise ApiError(409, json.dumps({"conflict": "is-a-folder"}))
    _check_base(real, base)
    real.parent.mkdir(parents=True, exist_ok=True)
    _inside(request, key, Path(p).parent.as_posix() if "/" in p.strip("/") else "")      # the made parents too
    part = real.parent / f"{PART_PREFIX}{secrets.token_hex(6)}.part"
    size = 0
    try:
        limit = int(getattr(request.app.state.cfg, "max_upload_bytes", 0) or 0)
        with open(part, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                # The same ceiling as any upload (max_upload_bytes): a key that opens one folder
                # must not be a way to fill the disk.
                if limit and size > limit:
                    raise ApiError(413, f"bigger than this server takes ({limit // (1024 * 1024)} MB, max_upload_bytes)")
                f.write(chunk)
            f.flush()
            os.fsync(f.fileno())
        _check_base(real, base)                     # again: the upload may have taken a while
        os.utime(part, ns=(m, m))
        os.replace(part, real)
    finally:
        if part.exists():
            part.unlink()
    st = os.stat(real)
    return {"p": clean_rel(p), "s": st.st_size, "m": st.st_mtime_ns}


@router.delete("/api/sync/file", summary="Remove one file (into the trash)")
async def delete_file(request: Request, p: str, base: str | None = None) -> dict:
    key = _key(request)
    _writable(request, key)
    folder, real = _inside(request, key, p)
    if not real.is_file():
        raise ApiError(400, "not a file — folders go through /api/sync/dir")
    _check_base(real, base)
    return {"trashed": await asyncio.to_thread(_to_trash, request, key, folder, real)}


@router.post("/api/sync/dir", summary="Make a folder")
async def make_dir(request: Request, p: str) -> dict:
    key = _key(request)
    _writable(request, key)
    folder, real = _inside(request, key, p, must_exist=False)
    if os.path.lexists(real) and not real.is_dir():
        raise ApiError(409, json.dumps({"conflict": "is-a-file"}))
    real.mkdir(parents=True, exist_ok=True)
    return {"p": clean_rel(p)}


@router.delete("/api/sync/dir", summary="Remove an empty folder")
async def remove_dir(request: Request, p: str) -> dict:
    key = _key(request)
    _writable(request, key)
    folder, real = _inside(request, key, p)
    if real == folder:
        raise ApiError(400, "that is the folder itself")
    if not real.is_dir():
        raise ApiError(400, "not a folder")
    left = [x for x in os.listdir(real) if x not in IGNORED]
    if left:
        raise ApiError(409, json.dumps({"conflict": "not-empty", "left": left[:20]}))
    shutil.rmtree(real)                      # only what is ignored is left in it
    return {"p": clean_rel(p)}


# --------------------------------------------------------------- made and taken back in the page

def pair_link(base: str, plain: str, name: str) -> str:
    return f"argus-sync://pair?url={quote(base, safe='')}&key={quote(plain, safe='')}&name={quote(name, safe='')}"


@router.get("/api/sync/keys", summary="The sync keys")
async def list_keys(request: Request) -> dict:
    return {"keys": public(load(request.app.state.sync_store))}


@router.post("/api/sync/keys", summary="Make a sync key for one folder")
async def make_key(request: Request) -> dict:
    body = await request.json()
    try:
        folder = request.app.state.jail.resolve(str(body.get("path") or ""))
    except (NotFound, Denied, PathError):
        raise ApiError(403, "outside the configured roots") from None
    if not folder.is_dir():
        raise ApiError(400, "a folder, not a file")
    base = str(body.get("base") or "").rstrip("/")
    if not re.fullmatch(r"https?://[\w.:\[\]-]+(/proxy/\d+)?", base):
        raise ApiError(400, "base: the address this page was opened at")
    try:
        entry, plain = add(request.app.state.sync_store, folder, str(body.get("name") or folder.name), bool(body.get("write", True)))
    except SyncKeyError as e:
        raise ApiError(400, str(e)) from None
    return {"key": public([entry])[0], "token": plain, "link": pair_link(base, plain, entry["name"]),
            "url": base, "writable": bool(entry["write"]) and bool(request.app.state.cfg.allow_write)}


@router.delete("/api/sync/keys/{key_id}", summary="Take a sync key back")
async def take_back(request: Request, key_id: str) -> dict:
    try:
        gone = revoke(request.app.state.sync_store, key_id)
    except SyncKeyError as e:
        raise ApiError(404, str(e)) from None
    return {"revoked": public([gone])[0]}


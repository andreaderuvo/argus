"""File browsing: list, preview, download, search — all behind the jail."""

from __future__ import annotations

import mimetypes
import os
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from .errors import ApiError
from .safepath import Denied, NotFound, PathError

# Directories that never carry anything a phone user is looking for, and that would
# otherwise dominate the walk. Skipping them is what keeps search interactive.
SEARCH_SKIP = {
    ".git", "node_modules", "target", ".cargo", ".rustup", ".conda", "miniconda3",
    ".nextflow", "work", ".cache", ".venv", "__pycache__", ".npm", ".nvm",
}
SEARCH_MAX_HITS = 200
SEARCH_MAX_VISITED = 300_000
SEARCH_MAX_DEPTH = 12
BINARY_SNIFF_BYTES = 8192

# Binary types the browser renders better than we ever could, so they go out untouched
# with their real content type instead of being refused as "not text".
INLINE_TYPES = ("application/pdf",)

# An HTML file is served as HTML so it can be previewed rendered — but a page from this
# origin could read the access token out of localStorage, and plenty of HTML on a
# bioinformatics box came from somewhere else. The CSP sandbox directive drops it into an
# opaque origin, which cuts that off even if someone opens the URL directly instead of
# through the app's iframe. Scripts stay on: a MultiQC or FastQC report is inert without
# them, and in an opaque origin they can no longer reach anything of ours.
HTML_SANDBOX = "sandbox allow-scripts allow-popups allow-forms"


# Zipped XML documents we can turn into readable text with the standard library alone.
# The formatting is gone; for a preview on a phone that is the right trade.
ZIPPED_DOCS = {
    ".docx": "word/document.xml",
    ".odt": "content.xml",
    ".odp": "content.xml",
}
# Local tag names that end a line when walking that XML.
_BREAK_AFTER = {"p", "h", "tr"}
_BREAK_BEFORE = {"br", "line-break"}

router = APIRouter()


def _resolve(request: Request, path: str) -> Path:
    """The single door into the filesystem. Translates jail verdicts into API errors."""
    try:
        return request.app.state.jail.resolve(path)
    except Denied:
        raise ApiError(403, "outside the configured roots") from None
    except NotFound:
        raise ApiError(404, "not found") from None
    except PathError:
        raise ApiError(403, "outside the configured roots") from None


def _entry(path: Path, name: str | None = None) -> dict:
    """Follow symlinks for the reported kind/size; fall back to the link itself when
    the target is missing or unreadable."""
    is_link = path.is_symlink()
    try:
        st = path.stat()
        is_dir = os.path.isdir(path)
        size = 0 if is_dir else st.st_size
        mtime = int(st.st_mtime)
    except OSError:
        try:
            st = path.lstat()
            is_dir, size, mtime = False, st.st_size, int(st.st_mtime)
        except OSError:
            is_dir, size, mtime = False, 0, 0
    return {
        "name": name if name is not None else path.name,
        "type": "directory" if is_dir else "file",
        "path": str(path),
        "size": size,
        "mtime": mtime,
        # True when the entry is a symlink, whatever it resolves to. The UI shows a
        # hint, and opening it still goes through the jail — a link out of the roots
        # gets 403.
        "symlink": is_link,
    }


@router.get("/api/config")
async def server_info(request: Request) -> dict:
    cfg = request.app.state.cfg
    return {
        "roots": [str(r) for r in request.app.state.jail.roots],
        "resize_policy": cfg.resize_policy,
        "max_preview_bytes": cfg.max_preview_bytes,
        # The UI hides every mutating control when this is false.
        "allow_write": cfg.allow_write,
        "max_upload_bytes": cfg.max_upload_bytes,
    }


@router.get("/api/files")
async def list_dir(request: Request, path: str) -> list[dict]:
    directory = _resolve(request, path)
    if not directory.is_dir():
        raise ApiError(400, "not a directory")

    out = []
    try:
        with os.scandir(directory) as it:
            for entry in it:
                try:
                    out.append(_entry(Path(entry.path), entry.name))
                except OSError:
                    continue  # an unreadable entry should not sink the whole listing
    except OSError as e:
        raise ApiError(500, str(e)) from e

    # Directories first, then case-insensitive by name — the order a person expects.
    out.sort(key=lambda e: (e["type"] == "file", e["name"].lower(), e["name"]))
    return out


@router.get("/api/file")
async def read_file(request: Request, path: str) -> Response:
    target = _resolve(request, path)
    if target.is_dir():
        raise ApiError(400, "path is a directory")

    limit = request.app.state.cfg.max_preview_bytes
    size = target.stat().st_size
    guessed = mimetypes.guess_type(target.name)[0] or "application/octet-stream"

    # Office documents are unzipped into plain text, so a .docx is readable instead of
    # being a download-only blob.
    if target.suffix.lower() in ZIPPED_DOCS:
        return Response(content=document_text(target), media_type="text/plain; charset=utf-8")

    if size > limit:
        # A log is precisely the file that outgrows the cap, and refusing to show it is
        # the wrong answer: send the tail, which is the part anyone actually wants.
        if guessed.startswith("image/") or guessed in INLINE_TYPES or is_binary(head_of(target)):
            raise ApiError(413, f"file exceeds max_preview_bytes ({limit}) — download it instead")
        # A half-delivered document would render as garbage; show its source instead.
        return Response(
            content=tail_of(target, limit),
            media_type="text/plain; charset=utf-8",
            headers={"x-truncated": "tail", "x-total-size": str(size)},
        )

    data = target.read_bytes()

    if guessed == "text/html":
        return Response(
            content=data,
            media_type="text/html; charset=utf-8",
            headers={"content-security-policy": HTML_SANDBOX, "x-content-type-options": "nosniff"},
        )

    # Images and PDFs go out with their real type, so the preview screen can hand them
    # straight to the browser's own viewer.
    if guessed.startswith("image/") or guessed in INLINE_TYPES:
        return Response(content=data, media_type=guessed)

    # Everything else must look like text. A NUL byte in the first 8 KiB is the cheap,
    # reliable signal that it does not.
    if is_binary(data):
        raise ApiError(415, "binary file — download it instead")
    return Response(
        content=data,
        media_type="text/plain; charset=utf-8",
        # The editor sends this back when saving, and the write is refused if the file
        # moved on in between.
        headers={"x-mtime": str(int(target.stat().st_mtime)), "x-editable": "yes"},
    )


def is_binary(data: bytes) -> bool:
    return b"\x00" in data[:BINARY_SNIFF_BYTES]


def head_of(path: Path) -> bytes:
    with path.open("rb") as f:
        return f.read(BINARY_SNIFF_BYTES)


def tail_of(path: Path, limit: int) -> bytes:
    """The last `limit` bytes, minus the first partial line — which would otherwise show
    up as a fragment, and could cut a multi-byte character in half."""
    with path.open("rb") as f:
        f.seek(-limit, os.SEEK_END)
        data = f.read()
    cut = data.find(b"\n")
    return data[cut + 1 :] if 0 <= cut < 4096 else data


@router.get("/api/download")
async def download(request: Request, path: str) -> Response:
    target = _resolve(request, path)
    if target.is_dir():
        raise ApiError(400, "cannot download a directory")
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
        headers={"content-disposition": content_disposition(target.name or "download")},
    )


@router.get("/api/search")
async def search(request: Request, path: str, q: str) -> list[dict]:
    root = _resolve(request, path)
    needle = q.strip().lower()
    if not needle:
        return []
    return walk_for(root, needle)


def walk_for(root: Path, needle: str) -> list[dict]:
    hits: list[dict] = []
    visited = 0
    root_depth = len(root.parts)

    for dirpath, dirnames, filenames in os.walk(root, topdown=True, followlinks=False):
        here = Path(dirpath)
        # Prune in place: this is what stops the walk from entering the noise.
        if len(here.parts) - root_depth >= SEARCH_MAX_DEPTH:
            dirnames[:] = []
        else:
            dirnames[:] = [d for d in dirnames if d not in SEARCH_SKIP and not d.startswith(".")]

        for name in dirnames + filenames:
            visited += 1
            if visited > SEARCH_MAX_VISITED or len(hits) >= SEARCH_MAX_HITS:
                return hits
            if needle not in name.lower():
                continue
            try:
                hits.append(_entry(here / name, name))
            except OSError:
                continue
    return hits


def document_text(path: Path) -> str:
    """Readable text out of a zipped XML document (.docx / .odt / .odp).

    No dependency and no formatting: paragraphs become lines. Anything we cannot open is
    an unsupported-media error rather than a 500, because the download link still works.
    """
    member = ZIPPED_DOCS[path.suffix.lower()]
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read(member)
    except (KeyError, OSError, zipfile.BadZipFile) as e:
        raise ApiError(415, f"cannot read this document — download it instead ({e})") from e

    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError as e:
        raise ApiError(415, "this document is not readable as text — download it instead") from e

    chunks: list[str] = []
    _collect(root, chunks)
    text = "".join(chunks)
    # Word emits a paragraph per line break, which leaves long runs of blank lines.
    while "\n\n\n" in text:
        text = text.replace("\n\n\n", "\n\n")
    return text.strip() + "\n"


def _content(s: str | None) -> str | None:
    """Drop pretty-printing whitespace while keeping real spacing.

    Indentation between elements is blank *and* spans a newline; a genuine separator
    inside a paragraph (`<w:t xml:space="preserve">word </w:t>`) never does.
    """
    if not s:
        return None
    return None if (not s.strip() and "\n" in s) else s


def _collect(node, out: list[str]) -> None:
    tag = node.tag.rsplit("}", 1)[-1]
    if tag in _BREAK_BEFORE:
        out.append("\n")
    if tag == "tab":
        out.append("\t")
    if text := _content(node.text):
        out.append(text)
    for child in node:
        _collect(child, out)
    if tag in _BREAK_AFTER:
        out.append("\n")
    if tail := _content(node.tail):
        out.append(tail)


def content_disposition(name: str) -> str:
    """``filename=`` needs a plain-ASCII value; ``filename*=`` carries the real name.
    Sending both keeps every browser happy without letting a quote or newline in a
    filename inject a header."""
    ascii_name = "".join(c if (c.isascii() and (c.isalnum() or c in "-_. ")) else "_" for c in name)
    if not ascii_name.strip():
        ascii_name = "download"
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{percent_encode(name)}'


def percent_encode(s: str) -> str:
    out = []
    for b in s.encode("utf-8"):
        c = chr(b)
        if c.isascii() and (c.isalnum() or c in "-_.~"):
            out.append(c)
        else:
            out.append(f"%{b:02X}")
    return "".join(out)


def error_response(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)

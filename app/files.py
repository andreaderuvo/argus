"""File browsing: list, preview, download, search — all behind the jail."""

from __future__ import annotations

import asyncio
import mimetypes
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
from xml.etree import ElementTree

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse, Response

from . import tmux
from .errors import ApiError
from .safepath import Denied, NotFound, PathError

# What pandoc can be asked to render, and as what. Everything here also has a plain-text
# fallback below, because pandoc is a nice-to-have on the machine, never a requirement.
PANDOC_FORMATS = {".docx": "docx", ".odt": "odt", ".rtf": "rtf", ".epub": "epub"}
PANDOC_TIMEOUT = 25
# Images come back base64-inlined, so a document full of figures can balloon. Past this
# the plain text is the better answer than a page the phone cannot hold.
PANDOC_MAX_HTML = 12 * 1024 * 1024

# Directories that never carry anything a phone user is looking for, and that would
# otherwise dominate the walk. Skipping them is what keeps search interactive.
SEARCH_SKIP = {
    ".git", "node_modules", "target", ".cargo", ".rustup", ".conda", "miniconda3",
    ".nextflow", "work", ".cache", ".venv", "__pycache__", ".npm", ".nvm",
}
# Adding up a directory is unbounded work — a sequencing run is millions of files — so it
# stops at whichever of these comes first and says the answer is partial. A number marked
# "at least" is useful; a request that never returns is not.
USAGE_MAX_ENTRIES = 400_000
USAGE_MAX_SECONDS = 20.0

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


@router.get("/api/config", tags=["Setup"], summary="What this server allows")
async def server_info(request: Request) -> dict:
    cfg = request.app.state.cfg
    return {
        "roots": [str(r) for r in request.app.state.jail.roots],
        "resize_policy": cfg.resize_policy,
        "max_preview_bytes": cfg.max_preview_bytes,
        # The UI hides every mutating control when this is false.
        "allow_write": cfg.allow_write,
        # Whether a loopback URL printed in a session can be reached through us. The
        # ports screen learned this from /api/ports; a link clicked in a terminal has no
        # reason to ask that endpoint, and read it as "off" until this was here.
        "allow_proxy": cfg.allow_proxy,
        "max_upload_bytes": cfg.max_upload_bytes,
        # Where a file dropped on a session lands. Empty means drops are refused, and the UI
        # then does not light a terminal up as somewhere a file can go.
        "drop_dir": str(cfg.drops() or ""),
        # Where tmux reads its configuration, so the UI can offer to edit it.
        "tmux_conf": tmux.conf_path(),
        # For the "open this on another device" QR code.
        "addresses": request.app.state.addresses,
        "port": request.app.state.port,
        "token": cfg.token,
    }


@router.get("/api/files", tags=["Files"], summary="List a folder")
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


@router.get("/api/file", tags=["Files"], summary="Read a file, or its tail if it is large")
async def read_file(request: Request, path: str) -> Response:
    target = _resolve(request, path)
    if target.is_dir():
        raise ApiError(400, "path is a directory")

    limit = request.app.state.cfg.max_preview_bytes
    stat = target.stat()
    size = stat.st_size
    guessed = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    # A document is identified by when it was last written and how big it is. Two things
    # hang off this: a rebuilt PDF can never be served from the cache in place of the new
    # one, and the viewer downloads it once rather than twice — the preview fetches the
    # file to find out what it is, and the frame that shows it then asks for the same
    # bytes a second time.
    stamp = f'W/"{int(stat.st_mtime)}-{size}"'

    # Office documents: rendered as a document where the machine can, unzipped into plain
    # text where it cannot, and never a download-only blob.
    suffix = target.suffix.lower()
    if suffix in PANDOC_FORMATS or suffix in ZIPPED_DOCS:
        rendered = None
        if suffix in PANDOC_FORMATS and size <= limit:
            rendered = await asyncio.to_thread(pandoc_html, target, PANDOC_FORMATS[suffix])
        if rendered:
            return Response(
                content=rendered,
                media_type="text/html; charset=utf-8",
                # The same sandbox an HTML file gets: this page was written by somebody
                # else, and it must not be able to reach the token in localStorage.
                headers={
                    "content-security-policy": HTML_SANDBOX,
                    "x-content-type-options": "nosniff",
                    # Tells the viewer this is a rendered document, not a page whose
                    # source anyone wants to read.
                    "x-rendered": "document",
                },
            )
        if suffix in ZIPPED_DOCS:
            return Response(content=document_text(target), media_type="text/plain; charset=utf-8")
        raise ApiError(415, "this document could not be rendered — download it instead")

    # A recording is bigger than any preview cap worth having, and reading one into memory
    # to hand it over would be absurd: the browser asks for the few seconds it is about to
    # play and asks again when you drag the scrubber. So this is streamed from disk and
    # answers a range request, which is the whole of what makes seeking work — without it
    # a player can only start at the beginning and only stop at the end.
    if guessed.startswith(("video/", "audio/")):
        return FileResponse(
            target,
            media_type=guessed,
            headers={"content-disposition": content_disposition(target.name, inline=True)},
        )

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

    # Only the types handed straight to the browser's own viewer are cached, and only
    # against this stamp: text is re-read every time, because a log that grew by a line
    # must show that line.
    inline = guessed.startswith("image/") or guessed in INLINE_TYPES
    if inline and request.headers.get("if-none-match") == stamp:
        return Response(status_code=304, headers={"etag": stamp, "cache-control": "no-cache"})

    data = target.read_bytes()

    if guessed == "text/html":
        return Response(
            content=data,
            media_type="text/html; charset=utf-8",
            headers={"content-security-policy": HTML_SANDBOX, "x-content-type-options": "nosniff"},
        )

    # Images and PDFs go out with their real type, so the preview screen can hand them
    # straight to the browser's own viewer — with their name attached, so saving one from
    # inside that viewer keeps it.
    if inline:
        return Response(
            content=data,
            media_type=guessed,
            headers={
                "content-disposition": content_disposition(target.name, inline=True),
                "etag": stamp,
                # Kept, but never used without asking first: the file is expected to change.
                "cache-control": "no-cache",
            },
        )

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


@router.get("/api/download", tags=["Files"], summary="Download a file under its own name")
async def download(request: Request, path: str) -> Response:
    target = _resolve(request, path)
    if target.is_dir():
        raise ApiError(400, "cannot download a directory")
    return FileResponse(
        target,
        media_type=mimetypes.guess_type(target.name)[0] or "application/octet-stream",
        headers={"content-disposition": content_disposition(target.name or "download")},
    )


@router.get("/api/search", tags=["Files"], summary="Find files by name under a folder")
async def search(request: Request, path: str, q: str) -> list[dict]:
    root = _resolve(request, path)
    needle = q.strip().lower()
    if not needle:
        return []
    return walk_for(root, needle)


# Poppler's extractor, if the machine has it. Same reasoning as pandoc: a nice-to-have,
# never a requirement — without it the PDF still opens, it just cannot be searched.
PDFTOTEXT_TIMEOUT = 30
PDF_MAX_HITS = 60
SNIPPET = 90


def find_pdftotext() -> str | None:
    """Beside the interpreter as well as on PATH — a systemd service has a bare PATH and
    on a conda machine that is where poppler lives."""
    found = shutil.which("pdftotext")
    if found:
        return found
    nearby = Path(sys.executable).parent / "pdftotext"
    return str(nearby) if os.access(nearby, os.X_OK) else None


class NoExtractor(Exception):
    """This machine has no pdftotext."""


class Unreadable(Exception):
    """It has one, and the document defeated it."""


def pdf_pages(path: Path) -> list[str]:
    """The text of the document, one entry per page.

    `pdftotext` separates pages with a form feed, so one pass over the whole file gives
    every page in order — which is what makes "which page is this word on" answerable
    without a PDF library.
    """
    exe = find_pdftotext()
    if not exe:
        raise NoExtractor
    try:
        done = subprocess.run(
            [exe, "-q", "--", str(path), "-"],
            capture_output=True, timeout=PDFTOTEXT_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError) as e:
        raise Unreadable(str(e)) from e
    # A damaged file and a missing extractor are not the same failure, and telling the
    # reader "this server cannot search PDFs" when the truth is "this PDF is broken"
    # sends them looking in the wrong place.
    if done.returncode != 0:
        raise Unreadable(done.stderr.decode("utf-8", "replace").strip() or "the document could not be read")
    return done.stdout.decode("utf-8", "replace").split("\f")


def hits_in(pages: list[str], needle: str) -> list[dict]:
    """Where the words are, with enough text around each to recognise it."""
    found: list[dict] = []
    lowered = needle.lower()
    for number, text in enumerate(pages, start=1):
        haystack = text.lower()
        at = haystack.find(lowered)
        while at >= 0 and len(found) < PDF_MAX_HITS:
            start = max(0, at - SNIPPET // 2)
            snippet = " ".join(text[start:at + len(needle) + SNIPPET // 2].split())
            found.append({"page": number, "text": snippet})
            at = haystack.find(lowered, at + len(needle))
            if found and found[-1]["page"] == number and len([h for h in found if h["page"] == number]) >= 4:
                break        # four from one page is plenty to know it is on that page
        if len(found) >= PDF_MAX_HITS:
            break
    return found


@router.get("/api/pdf/search", tags=["Files"], summary="Find text in a PDF, page by page")
async def pdf_search(request: Request, path: str, q: str) -> dict:
    """Find a string in a PDF and say which pages it is on.

    The browser's own viewer has a search box on a desktop and nothing at all on a phone,
    and inside an iframe Ctrl+F searches the page around it rather than the document. So
    the text is extracted here and the viewer is sent to the page.
    """
    target = _resolve(request, path)
    needle = q.strip()
    if not needle:
        return {"hits": [], "pages": 0}
    if target.suffix.lower() != ".pdf":
        raise ApiError(400, "not a PDF")

    try:
        pages = await asyncio.to_thread(pdf_pages, target)
    except NoExtractor:
        raise ApiError(501, "this server has no pdftotext, so PDFs cannot be searched") from None
    except Unreadable as e:
        raise ApiError(422, f"this PDF could not be read: {e}") from None

    if not any(page.strip() for page in pages):
        # A scan is a picture of a page, and there is nothing in it to find.
        raise ApiError(422, "this PDF holds no text — it is probably a scan")
    return {"hits": hits_in(pages, needle), "pages": len(pages)}


@router.get("/api/fs/usage", tags=["Files"], summary="What a folder weighs, walked on request")
async def usage(request: Request, path: str) -> dict:
    """What a folder actually weighs, added up by hand.

    Apparent size, the sum of the file sizes — the number that matches what you see in a
    listing, rather than the blocks on disk, which sparse files and compression make a
    different question.
    """
    target = _resolve(request, path)
    if not os.path.isdir(target):
        st = target.stat()
        return {"path": str(target), "bytes": st.st_size, "files": 1, "dirs": 0, "complete": True}
    return await asyncio.to_thread(add_up, target)


def add_up(root: Path) -> dict:
    """Walk a tree adding sizes, without following symlinks anywhere.

    A link is counted as the little thing it is and never entered: following them would
    double-count a tree reachable twice, hang on a cycle, and quietly add up files outside
    the jail — the one place where a link is not the thing it points at.
    """
    total = 0
    files = 0
    dirs = 0
    seen = 0
    started = time.monotonic()
    complete = True
    stack = [root]

    while stack:
        if seen >= USAGE_MAX_ENTRIES or time.monotonic() - started > USAGE_MAX_SECONDS:
            complete = False
            break
        current = stack.pop()
        try:
            with os.scandir(current) as entries:
                for entry in entries:
                    seen += 1
                    try:
                        st = entry.stat(follow_symlinks=False)
                    except OSError:
                        continue
                    if entry.is_dir(follow_symlinks=False):
                        dirs += 1
                        stack.append(entry.path)
                    else:
                        files += 1
                        total += st.st_size
        except OSError:
            # A directory we may not read is not an error for the total — it is simply
            # not part of what we can see, and saying so beats refusing the whole answer.
            complete = False

    return {
        "path": str(root),
        "bytes": total,
        "files": files,
        "dirs": dirs,
        "complete": complete,
        "seconds": round(time.monotonic() - started, 2),
    }


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


def find_pandoc() -> str | None:
    """pandoc on PATH, or next to the interpreter running us.

    A service started by systemd inherits a bare PATH — /usr/bin and little else — so on a
    machine where every tool lives in a conda environment, `which` finds nothing while the
    same command works fine in a shell. The interpreter's own bin directory is exactly
    where that pandoc is.
    """
    found = shutil.which("pandoc")
    if found:
        return found
    nearby = Path(sys.executable).parent / "pandoc"
    return str(nearby) if os.access(nearby, os.X_OK) else None


def pandoc_html(path: Path, fmt: str) -> bytes | None:
    """A Word document as HTML, if this machine has pandoc.

    Reading a report on a phone as one undifferentiated wall of text is barely reading it:
    headings, lists and tables are most of what makes a document navigable. pandoc rebuilds
    all of that, and `--embed-resources` inlines the figures so the page needs nothing from
    anywhere. When it is missing, fails, or produces something enormous, the caller falls
    back to the text extraction, which has no dependencies at all.
    """
    exe = find_pandoc()
    if not exe:
        return None
    try:
        done = subprocess.run(
            [exe, "--from", fmt, "--to", "html", "--standalone", "--embed-resources",
             # `title-meta` fills the browser tab without pandoc's template also printing
             # the name as a heading: the viewer already shows it in the header bar.
             "--metadata", f"title-meta={path.stem}", "--", str(path)],
            capture_output=True, timeout=PANDOC_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if done.returncode != 0 or not done.stdout.strip():
        return None
    if len(done.stdout) > PANDOC_MAX_HTML:
        return None
    return done.stdout


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


def content_disposition(name: str, inline: bool = False) -> str:
    """``filename=`` needs a plain-ASCII value; ``filename*=`` carries the real name.
    Sending both keeps every browser happy without letting a quote or newline in a
    filename inject a header.

    `inline` is for something shown rather than saved — a PDF in the browser's own viewer.
    It still needs the name: the viewer's save button takes the name from the URL, and the
    URL here ends in `/api/file`, which is how every download came out called "file.pdf".
    """
    ascii_name = "".join(c if (c.isascii() and (c.isalnum() or c in "-_. ")) else "_" for c in name)
    if not ascii_name.strip():
        ascii_name = "download"
    kind = "inline" if inline else "attachment"
    return f'{kind}; filename="{ascii_name}"; filename*=UTF-8\'\'{percent_encode(name)}'


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

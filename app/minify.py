"""The app's JavaScript, served minified — made here, on the fly, never committed.

Argus has no build step on purpose: the files in static/ are the files that run, readable and
commented. The comments are most of their weight: 1,188 KB written, 523 KB minified; 401 KB and
200 KB gzipped (measured 2026-10-14). So the server minifies each module the first time it is
asked for, with esbuild when the machine has it, keeps the result for that version of the file,
and serves the source map beside it — the browser's developer tools still show the code as
written. Without esbuild, or with `minify: false`, the files go out as they are, as before.

`--keep-names`: function names survive (a `this`-using named function, a stack trace that says
where it was); the identifiers inside are what shrink.
"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MAP_TAIL = "//# sourceMappingURL=data:application/json;base64,"

_cache: dict[tuple[str, int, int], tuple[bytes, bytes] | None] = {}
_lock = threading.Lock()
_tool: list[str | None] = []


def esbuild() -> str | None:
    """The esbuild binary: $ARGUS_ESBUILD, then the repo's node_modules (npm ci), then the PATH."""
    if not _tool:
        found = None
        if os.environ.get("ARGUS_ESBUILD") == "off":
            _tool.append(None)
            return None
        for candidate in (os.environ.get("ARGUS_ESBUILD"), str(ROOT / "node_modules" / ".bin" / "esbuild"),
                          shutil.which("esbuild")):
            if candidate and os.access(candidate, os.X_OK):
                found = candidate
                break
        _tool.append(found)
    return _tool[0]


def minified(path: Path, url: str) -> tuple[bytes, bytes] | None:
    """(code, source map) for the module at `path`, served as `url`; None when it cannot be
    made — then the file goes out as written."""
    tool = esbuild()
    if not tool:
        return None
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    with _lock:
        if key in _cache:
            return _cache[key]
    try:
        done = subprocess.run(
            [tool, "--minify", "--keep-names", "--format=esm", "--target=es2020", "--sourcemap=inline",
             f"--sourcefile={url}", "--log-level=error"],
            input=path.read_bytes(), capture_output=True, timeout=20,
        )
        out = done.stdout.decode("utf-8") if done.returncode == 0 else ""
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        out = ""
    made = None
    at = out.rfind(MAP_TAIL)
    if out and at >= 0:
        sourcemap = base64.b64decode(out[at + len(MAP_TAIL):].strip())
        code = out[:at] + f"//# sourceMappingURL={url.rsplit('/', 1)[-1]}.map\n"
        made = (code.encode("utf-8"), sourcemap)
    with _lock:
        if len(_cache) > 500:
            _cache.clear()
        _cache[key] = made
    return made


def warm(static_dir: Path) -> None:
    """Minify every module once, in the background, so no page waits for the first time."""
    def run():
        for path in [static_dir / "app.js", *sorted((static_dir / "js").glob("*.js"))]:
            if path.is_file():
                minified(path, "/" + path.relative_to(static_dir).as_posix())
    if esbuild():
        threading.Thread(target=run, daemon=True, name="argus-minify").start()

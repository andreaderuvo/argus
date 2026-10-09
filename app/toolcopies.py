"""Copies of Argus's commands left behind by an update.

`argus-say`, `argus-bell`, `argus-mcp`… live in `tools/`. Sessions Argus starts get `tools/` first
on their PATH, the installer writes launchers that run the installed code, and the plugin's copies
are versioned and checked — none of those go stale. What does is a *copy* made by hand
(`cp tools/argus-say ~/.local/bin/`): after `git pull` the repository moves on, the copy does not,
and an agent outside Argus keeps running last month's client without anything saying so.

So: every directory on the PATH (and `~/.local/bin`, `~/bin`) is looked at for those names. A
link into this checkout, the installer's launcher, or a byte-for-byte copy of today's file is
fine; anything else is reported, with the line that replaces it by a link — which cannot go stale.
"""

from __future__ import annotations

import os
import shutil
import sys
import time
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent / "tools"
NAMES = ("argus-say", "argus-bell", "argus-mcp", "argus-where", "argus_client.py", "argus_mcp.py")
SHIM = "Written by install.sh"
# The plugin's own copies: versioned, and checked by pluginstate — not this module's business.
PLUGIN_DIRS = ("/.claude/plugins/", "/.codex/plugins/", "/.gemini/extensions/")


def _dirs(path_env: str | None, home: Path) -> list[Path]:
    seen, out = set(), []
    # Beside the PATH, where people put copies: a service's PATH is bare, and conda's bin (where the
    # Python running Argus lives) is where an `argus-say` copied years ago would still sit.
    # A PATH given (the tests) is the whole search: only the real one gets Python's own bin added.
    own = [str(Path(sys.executable).parent)] if path_env is None else []
    for raw in [*(path_env if path_env is not None else os.environ.get("PATH", "")).split(os.pathsep),
                str(home / ".local" / "bin"), str(home / "bin"), *own]:
        if not raw or any(part in raw for part in PLUGIN_DIRS):
            continue
        d = Path(raw).expanduser()
        try:
            key = d.resolve()
        except OSError:
            continue
        if key in seen or not d.is_dir() or key == TOOLS.resolve():
            continue
        seen.add(key)
        out.append(d)
    return out


def stale_copies(path_env: str | None = None, home: Path | None = None) -> list[dict]:
    """`[{name, path, why, fix}]` for each copy of a tool that is not today's. `ARGUS_OLD_TOOLS=off`
    (the browser harness) looks nowhere: its Argus runs on the real machine's Python."""
    if path_env is None and os.environ.get("ARGUS_OLD_TOOLS") == "off":
        return []
    home = home or Path.home()
    out = []
    for d in _dirs(path_env, home):
        for name in NAMES:
            f = d / name
            ours = TOOLS / name
            if not f.is_file() or not ours.is_file():
                continue
            try:
                real = f.resolve()
                if real.parent == TOOLS.resolve():
                    continue                                       # a link into this checkout
                if f.stat().st_size > 2_000_000:
                    continue
                data = f.read_bytes()
            except OSError:
                continue
            if SHIM.encode() in data[:400] or data == ours.read_bytes():
                continue                                           # the installer's launcher, or today's copy
            why = "a link to another copy of Argus" if f.is_symlink() else "a copy older than this Argus"
            out.append({"name": name, "path": str(f), "why": why,
                        "changed": int(f.stat().st_mtime),
                        "fix": f"ln -sf {ours} {f}"})
    return out


def link(found: list[dict]) -> list[str]:
    """Replace each reported copy with a link into this checkout, keeping the old file beside it
    (`<name>.argus-old-<time>`). Only what `stale_copies` reported, by its exact path."""
    done = []
    stamp = int(time.time())
    for item in found:
        f = Path(item["path"])
        ours = TOOLS / item["name"]
        if f.name != item["name"] or item["name"] not in NAMES or not ours.is_file():
            continue
        backup = f.with_name(f"{f.name}.argus-old-{stamp}")
        if f.is_symlink():
            f.unlink()
        else:
            shutil.move(str(f), str(backup))
        f.symlink_to(ours)
        done.append(str(f))
    return done

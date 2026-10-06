"""Which build is running — the commit, when Argus runs from a git checkout.

"0.1.0" is the same for every commit between two tags, so after a `git pull` it says nothing about
where you are. The commit does. Read once at start-up (what is *running*), and again when asked
(what is *on disk*), so a pull that was never followed by a restart can say so.

Installed without git (a wheel, a container), the commit can come from `$ARGUS_COMMIT`, set when
the image is built; with neither, there is only the version.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _git(*args: str) -> str:
    try:
        done = subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, timeout=3)
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def read() -> dict | None:
    """`{commit, short, date, describe, dirty}` for the checkout this file is in, or None."""
    if not (ROOT / ".git").exists():
        commit = os.environ.get("ARGUS_COMMIT", "").strip()
        return {"commit": commit, "short": commit[:7], "date": "", "describe": "", "dirty": False} if commit else None
    commit = _git("rev-parse", "HEAD")
    if not commit:
        return None
    describe = _git("describe", "--tags", "--always", "--dirty")
    return {
        "commit": commit,
        "short": commit[:7],
        "date": _git("log", "-1", "--format=%cI"),
        "describe": describe,
        "dirty": describe.endswith("-dirty"),
    }


def on_disk() -> str:
    """The commit the checkout is at now — different from the running one after a pull."""
    return _git("rev-parse", "HEAD") if (ROOT / ".git").exists() else ""

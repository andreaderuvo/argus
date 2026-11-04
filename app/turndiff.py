"""What one turn of a team changed: a picture of the folder before the turn and after it.

A team's turn used to be its words — "built Pricing A, 9 of 9 tests" — and the change itself was
somewhere in git, mixed with every other turn's. The team's Chat shows each turn with its own
diff, so this takes a picture of the working tree when an agent's turn starts and when it ends,
and compares the two.

A picture is a git tree written through a **temporary index**: a copy of the repository's index,
`git add -u` for what is tracked, plus the untracked files that are not ignored and not big. The
repository's own index, its refs, its stash and its working tree are never touched — an agent may
be running git in it at that very moment. The only trace is loose objects in `.git/objects`,
which git's own housekeeping removes once nothing points at them.

Not a repository, no git, a timeout: no picture, and the turn simply has no diff.
"""

from __future__ import annotations

import functools
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

TIMEOUT = 20
# Untracked files bigger than this are data, not the change: never hashed.
BIG = 1024 * 1024
MAX_UNTRACKED = 500
MAX_PATCH = 400 * 1024
MAX_FILES = 300


def _git(folder: str, *args: str, env: dict | None = None, data: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", folder, *args], capture_output=True, timeout=TIMEOUT, input=data,
                          env={**os.environ, "GIT_OPTIONAL_LOCKS": "0", **(env or {})})


def snapshot(folder: str) -> dict | None:
    """`{root, tree}` for the working tree of the repository holding `folder`, or None."""
    if not folder or not shutil.which("git") or not os.path.isdir(folder):
        return None
    try:
        top = _git(folder, "rev-parse", "--show-toplevel")
        if top.returncode:
            return None
        root = top.stdout.decode().strip()
        gitdir = _git(root, "rev-parse", "--absolute-git-dir").stdout.decode().strip()
        with tempfile.TemporaryDirectory(prefix="argus-turn-") as tmp:
            index = Path(tmp) / "index"
            real = Path(gitdir) / "index"
            env = {"GIT_INDEX_FILE": str(index)}
            if real.exists():
                shutil.copyfile(real, index)
            elif _git(root, "rev-parse", "--verify", "-q", "HEAD").returncode == 0:
                _git(root, "read-tree", "HEAD", env=env)
            if _git(root, "add", "-u", env=env).returncode:
                return None
            listed = _git(root, "ls-files", "-z", "--others", "--exclude-standard").stdout.split(b"\0")
            small = []
            for raw in listed:
                if not raw:
                    continue
                try:
                    if os.path.getsize(os.path.join(root, raw.decode(errors="surrogateescape"))) <= BIG:
                        small.append(raw)
                except OSError:
                    continue
                if len(small) >= MAX_UNTRACKED:
                    break
            if small:
                _git(root, "add", "--pathspec-from-file=-", "--pathspec-file-nul", env=env, data=b"\0".join(small))
            tree = _git(root, "write-tree", env=env)
            if tree.returncode:
                return None
            return {"root": root, "tree": tree.stdout.decode().strip()}
    except (OSError, subprocess.SubprocessError, UnicodeDecodeError):
        return None


def summary(before: dict | None, after: dict | None) -> dict | None:
    """`{files: [{path, added, removed, status}], added, removed}` between two pictures, or None."""
    if not before or not after or before.get("root") != after.get("root"):
        return None
    if before["tree"] == after["tree"]:
        return {"files": [], "more": 0, "added": 0, "removed": 0}
    return _summary(before["root"], before["tree"], after["tree"])


@functools.lru_cache(maxsize=512)
def _summary(root: str, old: str, new: str) -> dict | None:
    # Two trees never change: the Chat asks every few seconds, git is asked once.
    try:
        nums = _git(root, "diff", "--numstat", "-z", "--no-renames", old, new)
        kinds = _git(root, "diff", "--name-status", "-z", "--no-renames", old, new)
    except (OSError, subprocess.SubprocessError):
        return None
    if nums.returncode or kinds.returncode:
        return None
    status = {}
    parts = kinds.stdout.decode(errors="replace").split("\0")
    for i in range(0, len(parts) - 1, 2):
        status[parts[i + 1]] = {"A": "new", "D": "deleted"}.get(parts[i][:1], "changed")
    files = []
    for rec in nums.stdout.decode(errors="replace").split("\0"):
        if not rec:
            continue
        bits = rec.split("\t", 2)
        if len(bits) < 3:
            continue
        add, rem, path = bits
        binary = add == "-"
        files.append({"path": path, "added": 0 if binary else int(add), "removed": 0 if binary else int(rem),
                      "binary": binary, "status": status.get(path, "changed")})
    files.sort(key=lambda f: f["path"])
    return {"files": files[:MAX_FILES], "more": max(0, len(files) - MAX_FILES),
            "added": sum(f["added"] for f in files), "removed": sum(f["removed"] for f in files)}


def patch(before: dict | None, after: dict | None, path: str | None = None, leave_out=()) -> str | None:
    """The unified diff between two pictures (one file's, with `path`), cut at MAX_PATCH."""
    if not before or not after or before.get("root") != after.get("root"):
        return None
    args = ["diff", "--no-color", "--no-renames", "--no-ext-diff", before["tree"], after["tree"]]
    if path:
        args += ["--", path]
    elif leave_out:
        args += ["--", ".", *(f":(exclude){x}" for x in leave_out)]
    try:
        got = _git(before["root"], *args)
    except (OSError, subprocess.SubprocessError):
        return None
    if got.returncode:
        return None
    text = got.stdout[:MAX_PATCH].decode(errors="replace")
    return text + ("\n… (cut here)\n" if len(got.stdout) > MAX_PATCH else "")

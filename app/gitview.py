"""What changed in a repository, read and never written.

gitwork.py says Argus is not a git client, and this does not make it one: it reads. The
question it answers is the one asked of every agent's work — *what did it change?* — without
opening another terminal to type `git diff` into: the files that differ, and the patch, for
the work not yet committed, the last commit, or against another branch (a worktree beside its
main checkout, one executor of a Tournament against the other).

Everything is limited to the folder asked about (`-- .` from it), so a jail root inside a
bigger repository shows only what is under it. A ref is checked to be a commit before it goes
anywhere near a command line, and git is always run with its arguments as a list.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

MAX_DIFF = 4 * 1024 * 1024        # past this a patch is cut, and says so
MAX_UNTRACKED = 60                # new files shown as whole additions, at most this many
MAX_NEW_FILE = 512 * 1024


class GitError(Exception):
    pass


def _git(where: Path, *args: str, timeout: float = 20.0, ok=(0,)) -> str:
    env = {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "LC_ALL": "C", "GIT_PAGER": "cat"}
    try:
        done = subprocess.run(["git", "-C", str(where), *args], capture_output=True, text=True,
                              errors="replace", timeout=timeout, env=env)
    except FileNotFoundError as e:
        raise GitError("git is not installed on this machine") from e
    except subprocess.TimeoutExpired as e:
        raise GitError(f"git took longer than {timeout:.0f}s") from e
    except (OSError, subprocess.SubprocessError) as e:
        raise GitError(f"git would not run: {e}") from e
    if done.returncode not in ok:
        raise GitError((done.stderr or done.stdout or "git failed").strip().splitlines()[0])
    return done.stdout


def _dir(path: Path) -> Path:
    return path.parent if path.is_file() else path


def _commit(where: Path, ref: str) -> str:
    """A ref that names a commit, or GitError. Never an option: `-x` would be read as one."""
    ref = (ref or "").strip()
    if not ref or ref.startswith("-") or any(c in ref for c in " \t\n\0"):
        raise GitError(f"{ref!r} is not a branch or commit")
    try:
        return _git(where, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}").strip()
    except GitError:
        raise GitError(f"no branch or commit called {ref!r} here") from None


STATES = {"M": "modified", "A": "added", "D": "deleted", "R": "renamed", "C": "copied",
          "T": "type changed", "U": "conflict", "?": "new"}


def status(path: Path, quick: bool = False) -> dict:
    """The repository, its branch, and every file that differs from HEAD under this folder."""
    here = _dir(path)
    try:
        top = Path(_git(here, "rev-parse", "--show-toplevel").strip())
    except GitError:
        return {"repo": None}
    if quick:                     # "is this a repository?" — a button decides whether to show itself
        return {"repo": str(top)}
    branch = _git(here, "branch", "--show-current").strip()
    try:
        head = _git(here, "log", "-1", "--format=%h%x00%s%x00%an%x00%ar").rstrip("\n").split("\0")
    except GitError:
        head = []                                         # a repository with no commit yet
    # Every path is said relative to the folder asked about: porcelain speaks from the top.
    rel = os.path.relpath(here.resolve(), top.resolve())
    strip = "" if rel == "." else rel + "/"
    files: dict[str, dict] = {}
    raw = _git(here, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".")
    parts = raw.split("\0")
    i = 0
    while i < len(parts):
        entry = parts[i]
        i += 1
        if len(entry) < 4:
            continue
        x, y, name = entry[0], entry[1], entry[3:]
        was = None
        if x in "RC":                                     # the old name follows, on its own
            was = parts[i] if i < len(parts) else None
            i += 1
        name = name[len(strip):] if strip and name.startswith(strip) else name
        if was and strip and was.startswith(strip):
            was = was[len(strip):]
        code = "?" if x == "?" else ("U" if "U" in (x, y) or (x, y) in (("A", "A"), ("D", "D")) else (x if x != " " else y))
        if code == "?":
            try:
                target = here / name
                if target.is_file() and not target.is_symlink() and target.stat().st_size <= MAX_NEW_FILE:
                    n_new = target.read_bytes().count(b"\n")
                else:
                    n_new = 0
            except OSError:
                n_new = 0
        files[name] = {"path": name, "state": STATES.get(code, code), "code": code,
                       "staged": x not in " ?", "was": was, "add": n_new if code == "?" else 0, "del": 0}
    # Counts of lines, from the same comparison the patch makes (work tree against HEAD).
    if head:
        for line in _git(here, "diff", "--numstat", "-z", "--relative", "HEAD", "--", ".").split("\0"):
            bits = line.split("\t")
            if len(bits) == 3 and bits[2] in files:
                files[bits[2]]["add"] = int(bits[0]) if bits[0].isdigit() else 0
                files[bits[2]]["del"] = int(bits[1]) if bits[1].isdigit() else 0
    branches = [b for b in _git(here, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n") if b]
    return {
        "repo": str(top), "folder": str(here), "under": "" if rel == "." else rel,
        "branch": branch or None, "detached": not branch,
        "head": {"short": head[0], "subject": head[1], "author": head[2], "when": head[3]} if len(head) == 4 else None,
        "files": sorted(files.values(), key=lambda f: f["path"]),
        "branches": branches,
    }


def diff(path: Path, what: str = "work", ref: str = "", file: str = "") -> tuple[str, bool]:
    """The patch, and whether it was cut short. `what`: `work` (everything not committed, new
    files included, against HEAD), `last` (the last commit), `ref` (the work tree against a
    branch or commit — what this checkout has that `ref` has not, and the reverse)."""
    here = _dir(path)
    spec = ["--", file] if file else ["--", "."]
    if file and (file.startswith("/") or ".." in Path(file).parts):
        raise GitError("a file is named from inside the repository")
    common = ["--no-color", "--no-ext-diff", "-M", "--relative"]
    if what == "last":
        out = _git(here, "show", "--format=", *common, "HEAD", *spec)
    elif what == "ref":
        out = _git(here, "diff", *common, _commit(here, ref), *spec)
    elif what == "work":
        try:
            _git(here, "rev-parse", "--verify", "--quiet", "HEAD")
            out = _git(here, "diff", *common, "HEAD", *spec)
        except GitError:
            out = _git(here, "diff", *common, "--cached", *spec)
        out += _untracked(here, file)
    else:
        raise GitError("what is one of work, last, ref")
    cut = len(out) > MAX_DIFF
    return (out[:MAX_DIFF] if cut else out), cut


def _untracked(here: Path, file: str) -> str:
    """New files as whole additions: `git diff` leaves them out, and an agent's new module is
    often the most interesting thing it did. Read only — no `git add -N`, nothing is staged."""
    names = [n for n in _git(here, "ls-files", "--others", "--exclude-standard", "-z", "--", file or ".").split("\0") if n]
    out = []
    for name in names[:MAX_UNTRACKED]:
        target = here / name
        try:
            if target.is_symlink() or not target.is_file() or target.stat().st_size > MAX_NEW_FILE:
                continue
        except OSError:
            continue
        out.append(_git(here, "diff", "--no-color", "--no-index", "--", "/dev/null", name, ok=(0, 1)))
    return "".join(out)

"""Git worktrees, for starting a job beside the one already running.

A worktree is git's own answer to "two agents, one repository": a second working directory on
its own branch, sharing the object store, with none of the copying and none of the fighting
over a single checkout. It is what the neighbouring tools build their whole model around, and
it costs Argus four commands.

Kept deliberately small. This is not a git client and is not going to become one: it lists
worktrees, makes one, and removes one — the three things you need to start a piece of work
somewhere it cannot collide with what is already going on. Committing, merging, resolving:
that is what the agent in the terminal is for.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path


class GitError(Exception):
    pass


def _git(repo: Path | str, *args: str, timeout: float = 20.0) -> str:
    try:
        done = subprocess.run(["git", "-C", str(repo), *args],
                              capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError as e:
        raise GitError("git is not installed on this machine") from e
    except (OSError, subprocess.SubprocessError) as e:
        raise GitError(f"git would not run: {e}") from e
    if done.returncode != 0:
        # git's own words. They are better than anything invented here — "fatal: 'x' is
        # already checked out at …" tells you precisely what to do next.
        raise GitError((done.stderr or done.stdout or "git failed").strip().splitlines()[0])
    return done.stdout


def top_of(path: Path | str) -> Path | None:
    """The repository a path belongs to, or None if it is not in one.

    A file gets asked about its folder: `git -C` wants a directory and answers "cannot change
    to …: Not a directory" for anything else — so a path pointing at a file in a repository
    came back as "not in a repository at all", which is exactly the case a browser is in when
    it asks about the thing you clicked.
    """
    here = Path(path)
    if here.is_file():
        here = here.parent
    try:
        out = _git(here, "rev-parse", "--show-toplevel")
    except GitError:
        return None
    top = out.strip()
    return Path(top) if top else None


def worktrees(repo: Path | str) -> list[dict]:
    """Every working directory this repository has, the main one first.

    From `--porcelain`, which is the form git promises not to change under you; the human
    format is aligned columns and would be parsed wrong by somebody eventually.
    """
    out = _git(repo, "worktree", "list", "--porcelain")
    found: list[dict] = []
    current: dict = {}
    for line in out.splitlines():
        if not line.strip():
            if current:
                found.append(current)
                current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current = {"path": value, "branch": None, "head": None, "bare": False,
                       "detached": False, "locked": False}
        elif key == "HEAD":
            current["head"] = value[:12]
        elif key == "branch":
            current["branch"] = re.sub(r"^refs/heads/", "", value)
        elif key in ("bare", "detached", "locked"):
            current[key] = True
    if current:
        found.append(current)
    return found


def has_branch(repo: Path | str, branch: str) -> bool:
    try:
        _git(repo, "show-ref", "--verify", "--quiet", f"refs/heads/{branch}")
        return True
    except GitError:
        return False


def suggested_path(repo: Path, branch: str) -> Path:
    """Where a worktree goes when nobody says.

    Beside the repository rather than inside it: a checkout nested in its own parent gets
    picked up by that parent's tooling — test runners walk into it, `git status` in the parent
    ignores it only because git puts it in `.git/info/exclude`, and every "find every file"
    in the app would count everything twice.
    """
    return repo.parent / f"{repo.name}-{branch.replace('/', '-')}"


def add(repo: Path | str, path: Path | str, branch: str) -> dict:
    """A new worktree, on a new branch or an existing one.

    `-b` when the branch is new and a plain checkout when it is not, because `git worktree add
    -b` on an existing branch is an error and "it already exists" is not a reason to refuse the
    thing somebody asked for.
    """
    repo = Path(repo)
    path = Path(path)
    if path.exists():
        raise GitError(f"{path} is already there")
    args = ["worktree", "add"]
    if has_branch(repo, branch):
        args += [str(path), branch]
    else:
        args += ["-b", branch, str(path)]
    _git(repo, *args)
    return {"path": str(path), "branch": branch, "repo": str(repo)}


def remove(repo: Path | str, path: Path | str, force: bool = False) -> None:
    """Take a worktree away.

    Not forced by default: git refuses when there are changes in it that are not committed
    anywhere, and that refusal is the only thing standing between an afternoon's work and a
    button. Forcing is a separate, deliberate answer.
    """
    args = ["worktree", "remove"]
    if force:
        args.append("--force")
    _git(repo, *args, str(path))

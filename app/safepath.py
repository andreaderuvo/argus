"""Path jail.

Every filesystem path that arrives from the network goes through :meth:`Jail.resolve`.
This is the only place allowed to turn a user-supplied string into a real path.

The rule that makes it safe: **canonicalize before comparing**. Comparing the raw string
against the roots would let both ``../../etc/passwd`` and a symlink pointing outside the
root slip through, because neither looks suspicious lexically.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path


class PathError(Exception):
    """Base class so a caller can catch either outcome at once."""


class Denied(PathError):
    """Outside every configured root, or otherwise unacceptable. Answer 403."""


class NotFound(PathError):
    """Inside a root, but nothing is there. Answer 404."""


class Jail:
    def __init__(self, roots: list[Path]):
        """Canonicalizes the configured roots once, at startup. Roots that do not exist
        are dropped with a warning rather than aborting: a config listing a not-yet-created
        log directory should not stop the server from booting."""
        canon: list[Path] = []
        for r in roots:
            try:
                canon.append(Path(r).resolve(strict=True))
            except OSError as e:
                print(f"warning: skipping root {r} ({e.strerror})", file=sys.stderr)
        if not canon:
            raise ValueError("no usable roots — check the `roots:` list in your config")
        self.roots = sorted(set(canon))

    def resolve(self, requested: str) -> Path:
        """Turns a client-supplied path into a canonical path guaranteed to sit inside
        a root. Raises :class:`Denied` or :class:`NotFound`."""
        if not requested or not requested.startswith("/"):
            raise Denied(requested)

        # Canonicalize the deepest ancestor that actually exists, then re-attach the
        # missing tail literally. Doing it this way means a nonexistent path *inside*
        # the jail reports 404 while a nonexistent path *outside* it reports 403 — so we
        # never confirm or deny the existence of anything we do not serve.
        existing, tail = _split_at_existing(Path(requested))
        try:
            full = existing.resolve(strict=True)
        except OSError:
            raise Denied(requested) from None

        for part in tail:
            # The tail is guaranteed not to exist, so it cannot contain a traversing
            # symlink — but `..` would still move us lexically, so reject anything that
            # is not a plain name.
            if part in ("", ".", "..") or "/" in part:
                raise Denied(requested)
            full = full / part

        if not self.contains(full):
            raise Denied(requested)
        if tail:
            raise NotFound(requested)
        return full

    def contains(self, p: Path) -> bool:
        # `is_relative_to` compares whole components, so root `/home/ada` does not
        # match `/home/adam`.
        return any(p == r or p.is_relative_to(r) for r in self.roots)


def _split_at_existing(p: Path) -> tuple[Path, list[str]]:
    """Splits `p` into (deepest existing ancestor, remaining components)."""
    tail: list[str] = []
    cur = p
    while True:
        # `os.path.exists` follows symlinks and answers False for anything it cannot
        # stat, permission errors included — so a broken symlink, or a directory we may
        # not enter, counts as missing and ends up in the tail. `Path.exists()` would
        # raise instead, turning a 403 into a 500.
        if os.path.exists(cur):
            return cur, list(reversed(tail))
        if cur.name == "" or cur.parent == cur:
            return Path("/"), list(reversed(tail))
        tail.append(cur.name)
        cur = cur.parent

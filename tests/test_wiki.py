"""The wiki, checked like code — when it is cloned beside the repository (~/argus.wiki).

Every link goes to a page that exists, every #anchor to a heading that exists, the API
reference is what scripts/apiref.py would write today, and no image points at a branch the
repository does not have. The audit of 2026-10-07 found broken images (`/main/` on a repository
whose branch is `master`) and a reference 53 routes behind; this is what keeps them found.
Skipped where the wiki is not cloned (CI): `git clone https://github.com/andreaderuvo/argus.wiki.git ~/argus.wiki`.
"""

from __future__ import annotations

import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import pytest

WIKI = Path.home() / "argus.wiki"
ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(not WIKI.is_dir(), reason="the wiki is not cloned at ~/argus.wiki")

LINK = re.compile(r"\]\(([A-Za-z0-9][A-Za-z0-9_-]*)?(?:#([^)\s]+))?\)")
HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*#*\s*$", re.M)
FENCE = re.compile(r"^```.*?^```", re.M | re.S)


def slug(heading: str) -> str:
    """GitHub's anchor for a heading: lowercase, punctuation dropped, spaces as dashes."""
    text = re.sub(r"`|\*\*|\*|_(?=\w)|(?<=\w)_|\[([^\]]*)\]\([^)]*\)", lambda m: m.group(1) or "", heading)
    text = unicodedata.normalize("NFC", text).lower()
    text = "".join(ch for ch in text if ch.isalnum() or ch in " -_")
    return text.replace(" ", "-")


def anchors(page: Path) -> set[str]:
    seen: dict[str, int] = {}
    out = set()
    for h in HEADING.findall(FENCE.sub("", page.read_text())):
        s = slug(h)
        n = seen.get(s, 0)
        out.add(s if n == 0 else f"{s}-{n}")
        seen[s] = n + 1
    return out


def test_every_link_and_anchor_resolves():
    pages = {p.stem: p for p in WIKI.glob("*.md")}
    cache: dict[str, set[str]] = {}
    broken = []
    for name, page in pages.items():
        text = FENCE.sub("", page.read_text())
        for target, anchor in LINK.findall(text):
            if target and target not in pages:
                if "." in target or target.startswith("http"):
                    continue
                broken.append(f"{name}: [{target}] — no such page")
                continue
            if anchor:
                where = target or name
                have = cache.setdefault(where, anchors(pages[where]))
                if anchor.lower() not in have:
                    broken.append(f"{name}: [{where}#{anchor}] — no such heading")
    assert not broken, "\n".join(broken)


def test_images_point_at_a_branch_that_exists():
    branch = subprocess.run(["git", "-C", str(ROOT), "branch", "-a"], capture_output=True, text=True).stdout
    bad = []
    for page in WIKI.glob("*.md"):
        for m in re.finditer(r"raw\.githubusercontent\.com/andreaderuvo/argus/([^/]+)/", page.read_text()):
            if m.group(1) not in branch:
                bad.append(f"{page.stem}: branch {m.group(1)!r}")
    assert not bad, bad


def test_the_api_reference_is_current():
    done = subprocess.run([sys.executable, str(ROOT / "scripts" / "apiref.py"), "--check", str(WIKI / "API-reference.md")],
                          capture_output=True, text=True)
    assert done.returncode == 0, done.stdout + done.stderr

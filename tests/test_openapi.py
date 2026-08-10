"""The published API description must match the routes it claims to describe.

A spec copied into `docs/` for the website goes stale the moment somebody adds a route,
and a stale spec is worse than none: it tells a stranger to call something that is not
there. This is the check that keeps it honest.
"""

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_the_published_spec_matches_the_code():
    done = subprocess.run(
        [sys.executable, "scripts/openapi.py", "--check"],
        cwd=ROOT, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stdout + done.stderr


def test_every_route_says_what_it_is_for():
    """A route with no summary is a route nobody outside can use."""
    spec = json.loads((ROOT / "docs" / "openapi.json").read_text())
    naked = [
        f"{verb.upper()} {path}"
        for path, ops in spec["paths"].items()
        for verb, op in ops.items()
        if not op.get("summary") or not op.get("tags")
    ]
    assert not naked, f"no summary or tag: {naked}"


def test_nothing_answers_with_data_outside_api():
    """Everything is under /api, which is what puts it behind the token."""
    spec = json.loads((ROOT / "docs" / "openapi.json").read_text())
    stray = [p for p in spec["paths"] if not p.startswith("/api/")]
    assert stray == ["/proxy/{port}/{path}"], f"outside /api: {stray}"

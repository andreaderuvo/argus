"""Which files of a patch the Changes window shows (static/js/patchfilter.js), run in Node."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def section(path, was=None):
    was = was or path
    return f"diff --git a/{was} b/{path}\n--- a/{was}\n+++ b/{path}\n@@ -1 +1 @@\n-a\n+b\n"


PATCH = "".join([section("app/main.py"), section("app/gitview.py"), section("tests/test_x.py"),
                 section("static/js/changes.js"), section("package-lock.json"), section("docs/new.md", "docs/old.md")])

CASES = [
    ("", ["app/main.py", "app/gitview.py", "tests/test_x.py", "static/js/changes.js", "package-lock.json", "docs/new.md"]),
    ("py", ["app/main.py", "app/gitview.py", "tests/test_x.py"]),
    ("*.py", ["app/main.py", "app/gitview.py", "tests/test_x.py"]),          # by name, at any depth
    ("tests/*", ["tests/test_x.py"]),
    ("app/*.py, *.js", ["app/main.py", "app/gitview.py", "static/js/changes.js"]),   # either
    ("!*.json", ["app/main.py", "app/gitview.py", "tests/test_x.py", "static/js/changes.js", "docs/new.md"]),
    ("py !tests", ["app/main.py", "app/gitview.py"]),
    ("MAIN", ["app/main.py"]),                                                # any case
    ("old.md", ["docs/new.md"]),                                              # a rename, by its old name
    ("static/**", ["static/js/changes.js"]),
    ("nothing-like-this", []),
]


def run(query):
    script = f"""
import {{ filterPatch, sectionPaths, splitPatch }} from '{ROOT / 'static/js/patchfilter.js'}';
const r = filterPatch({json.dumps(PATCH)}, {json.dumps(query)});
console.log(JSON.stringify({{ shown: r.shown, total: r.total,
  paths: splitPatch(r.text).map((s) => sectionPaths(s).at(-1)), whole: r.text === {json.dumps(PATCH)} }}));
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.skipif(not NODE, reason="needs node")
@pytest.mark.parametrize("query, expected", CASES)
def test_the_filter_keeps_the_files_asked_for(query, expected):
    got = run(query)
    assert got["paths"] == expected and got["shown"] == len(expected) and got["total"] == 6, got
    if not query:
        assert got["whole"], "no filter: the patch untouched"

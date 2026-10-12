"""A link split into what you read and where it is (static/js/linkparts.js), run in Node."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

CASES = [
    ("/data/run1/report.pdf", False, "report.pdf", "/data/run1/"),
    ("/data/run1/", False, "run1", "/data/"),                       # a folder is named by itself
    ("notes.md", False, "notes.md", ""),
    ("/", False, "/", ""),
    ("https://github.com/andreaderuvo/argus/blob/master/static/js/tray.js", True, "tray.js",
     "github.com/andreaderuvo/argus/blob/master/static/js/"),
    ("https://example.org/files/My%20Report%202026.pdf", True, "My Report 2026.pdf", "example.org/files/"),
    ("https://example.org/download?file=data%2Fresults.csv&v=2", True, "results.csv", "example.org/download"),
    ("http://localhost:5002/", True, "localhost:5002", "http"),
    ("localhost:8090/api/x", True, "x", "localhost:8090/api/"),
    ("https://example.org/page?q=1", True, "page", "example.org/?q=1"),
]


@pytest.mark.skipif(not NODE, reason="needs node")
@pytest.mark.parametrize("text, url, name, where", CASES)
def test_a_link_says_its_name_first(text, url, name, where):
    script = f"""
import {{ linkParts }} from '{ROOT / 'static/js/linkparts.js'}';
console.log(JSON.stringify(linkParts({json.dumps(text)}, {json.dumps(url)})));
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    got = json.loads(done.stdout)
    assert (got["name"], got["where"]) == (name, where), got

"""What a filter box means (static/js/textmatch.js), run in Node: plain text plain, a regular
expression with the switch or between slashes, and a broken one said."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
TEXTS = ["/data/run1/report.pdf", "/data/run2/a.b.txt", "https://localhost:5002/x", "http://example.org", "README.md"]

CASES = [
    ("", False, TEXTS, None),
    ("a.b", False, ["/data/run2/a.b.txt"], None),                     # plain: the dot is a dot
    ("REPORT", False, ["/data/run1/report.pdf"], None),               # any case
    (r"\.pdf$", True, ["/data/run1/report.pdf"], None),
    ("run[12]/", True, ["/data/run1/report.pdf", "/data/run2/a.b.txt"], None),
    (r"/^https?:\/\/localhost/", False, ["https://localhost:5002/x"], None),   # slashes: a regex with the switch off
    ("/readme/", False, ["README.md"], None),                         # no flags: any case
    ("/readme/m", False, [], None),                                   # flags without i: exact case
    ("/README/m", False, ["README.md"], None),
    ("(unclosed", True, TEXTS, "Unterminated group"),                # broken: said, the list left alone
]


@pytest.mark.skipif(not NODE, reason="needs node")
@pytest.mark.parametrize("query, on, expected, error", CASES)
def test_a_filter_box(query, on, expected, error):
    script = f"""
import {{ textMatcher }} from '{ROOT / 'static/js/textmatch.js'}';
const m = textMatcher({json.dumps(query)}, {json.dumps(on)});
console.log(JSON.stringify({{ kept: {json.dumps(TEXTS)}.filter((x) => m.test(x)), error: m.error }}));
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    got = json.loads(done.stdout)
    assert got["kept"] == expected, got
    assert (error is None and got["error"] is None) or (error and error in (got["error"] or "")), got

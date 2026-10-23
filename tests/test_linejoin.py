"""A link or a path an agent printed over two rows is one link (static/js/linejoin.js).

Run in Node against the module itself, on rows laid out the way Claude Code and Codex lay them out:
a newline and an indent where they wrap, nothing marked as wrapped for the terminal to know. And
what must not be joined: a row that stops short, a sentence that starts below a path.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
COLS = 60


def pad(s: str) -> str:
    return s.ljust(COLS)


def lay(text: str, width: int = 56, indent: str = "  ") -> list[str]:
    """A long word cut at `width`, the rows after the first indented — as an agent's TUI writes."""
    rows, rest = [text[:width]], text[width:]
    while rest:
        rows.append(indent + rest[: width - len(indent)])
        rest = rest[width - len(indent):]
    return [pad(r) for r in rows]


# (rows, the row hovered, what the line reads, wrapped flags or None)
CASES = [
    # Claude Code: a URL at its own edge (58 wide here), carried on below with its indent.
    ([pad("  The report is at https://github.com/andreaderuvo/argus/blo"),
      pad("  b/master/docs/report.md for the details."),
      pad("  Next row of prose that is ordinary and long enough to be."),
      ], 1, "  The report is at https://github.com/andreaderuvo/argus/blob/master/docs/report.md for the details.", None),
    # A path over three rows, cut the way Claude Code cuts: at its own width, the rest indented.
    (lay("⏺ Wrote the matrix to /data/lab/cgdist/listeria/st6-farm-cluster/2026-10/distances/snp-matrix-final-v2.tsv"),
     0, "⏺ Wrote the matrix to /data/lab/cgdist/listeria/st6-farm-cluster/2026-10/distances/snp-matrix-final-v2.tsv", None),
    # Codex: broken after a slash because the next piece would not fit — the row stops short
    # (the screenshot of 2026-10-23, at a 60-column pane).
    ([pad("Sì, finito."), pad(""), pad("La versione definitiva è qui:"), pad(""),
      pad("/data/lab/freemap_revision/rev2/"), pad("mm2geo_cert_ont_v3_with_a_long_name"), pad(""),
      pad("Risultati completi e tabella comparativa:"), pad("")], 5,
     "/data/lab/freemap_revision/rev2/mm2geo_cert_ont_v3_with_a_long_name", None),
    # Wrapped by the terminal: joined as it always was, with no indent to take away.
    ([("x" * 40) + "http://localhost:5002/a/b/c/d/e/f/g/h", "ij/k", pad("next")], 1,
     ("x" * 40) + "http://localhost:5002/a/b/c/d/e/f/g/hij/k" + " " * (COLS - 4), [False, True, False]),
]

APART = [
    # A folder ending in / on a row of its own, then a word that would have fitted beside it.
    ([pad("Look in /data/lab/out/"), pad("then run it again")], 0),
    # A row that stops short ended its line, whatever is below.
    ([pad("  see /tmp/out.txt"), pad("  and/then more")], 0),
    # A sentence below a path at the edge.
    ([pad("  The full output of the run is in /home/lab/results/batch-12"), pad("  Then I compared the two runs and found nothing.")], 0),
    # Prose at the edge: no link shape at the end of the row.
    ([pad("  this is a long line of ordinary words that fill the row ok"), pad("  continuing the sentence here")], 0),
]


def run(rows, y, wrapped=None):
    if NODE is None:
        pytest.skip("needs node")
    wrapped = wrapped or [False] * len(rows)
    script = f"""
import {{ joinRows }} from {json.dumps(str(ROOT / 'static/js/linejoin.js'))};
const rows = {json.dumps(rows)}; const wrapped = {json.dumps(wrapped)};
const out = joinRows((i) => ({{ text: rows[i], wrapped: wrapped[i] }}), {y}, rows.length, {COLS});
console.log(JSON.stringify(out));
"""
    done = subprocess.run([NODE, "--input-type=module", "-e", script], capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    return json.loads(done.stdout)


@pytest.mark.parametrize("rows,y,want,wrapped", CASES)
def test_a_link_broken_over_rows_reads_as_one(rows, y, want, wrapped):
    got = run(rows, y, wrapped)
    assert got["text"].rstrip() == want.rstrip()
    # Every character still knows where it is on screen, so the underline lands on both halves.
    assert len(got["cells"]) == len(got["text"])


@pytest.mark.parametrize("rows,y", APART)
def test_what_is_not_one_line_is_left_apart(rows, y):
    got = run(rows, y)
    assert got["first"] == got["last"] == y, got["text"]


def test_hovering_the_second_half_finds_the_whole_line():
    rows, _, want, _ = CASES[0]
    got = run(rows, 1)
    assert got["first"] == 0 and got["last"] == 1 and got["text"].rstrip() == want
    start = got["text"].index("https://")
    assert got["cells"][start] == [0, 19] and got["cells"][got["text"].index("b/master")] == [1, 2]

"""The line being typed, followed from what a terminal sends — the rules behind "also →".

Run in Node against the module itself, with the sequences a real terminal sends: a Claude behind
a real tmux made the button never appear, because the terminal's answers to tmux's questions were
read as keys and every line became "not known".
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")

CASES = [
    # (what went out, line after, sure after, lines sent)
    ("hello", "hello", True, []),
    ("hel\x7flo", "helo", True, []),
    ("say hi\r", "", True, ["say hi"]),
    # answers and reports, from tmux's questions and the window's focus: not typing
    ("\x1b[?1;2c\x1b[>0;276;0c\x1b]10;rgb:c5c5/caca/d3d3\x1b\\\x1b]11;rgb:0/0/0\x07hi", "hi", True, []),
    ("\x1bP>|xterm.js(6.0.0)\x1b\\hi", "hi", True, []),
    ("\x1b[I\x1b[Ohi\x1b[12;40R", "hi", True, []),
    ("\x1b[?2004;1$yhi", "hi", True, []),
    ("\x1b[<0;10;5Mhi\x1b[<0;10;5m", "hi", True, []),
    # a paste, framed
    ("\x1b[200~two\nlines\x1b[201~", "two\nlines", True, []),
    # keys that move the cursor or edit: the line is no longer known
    ("abc\x1b[D", "abc", False, []),
    ("abc\x1bOD", "abc", False, []),
    ("abc\x1b[3~", "abc", False, []),
    ("abc\x1b\r", "abc", False, []),            # Alt-Enter, a newline in an agent's box
    ("abc\x1b[Ddef\r", "", True, [None]),      # an Enter on a line it lost: said, as unknown
    # Ctrl-U and Ctrl-C start the line afresh, known
    ("abc\x1b[D\x15ok\r", "", True, ["ok"]),
]


@pytest.mark.skipif(NODE is None, reason="needs node")
def test_the_line_is_followed_through_what_a_real_terminal_sends():
    script = """
import { followLine } from '%s';
const cases = JSON.parse(process.argv[1]);
const out = cases.map(([data]) => { const s = { line: '', sure: true }; const sent = followLine(s, data); return [s.line, s.sure, sent]; });
console.log(JSON.stringify(out));
""" % (ROOT / "static/js/typedline.js").as_uri()
    done = subprocess.run([NODE, "--input-type=module", "-e", script, json.dumps(CASES)],
                          capture_output=True, text=True, timeout=20)
    assert done.returncode == 0, done.stderr
    got = json.loads(done.stdout)
    for (data, line, sure, sent), (gline, gsure, gsent) in zip(CASES, got):
        assert (gline, gsure, gsent) == (line, sure, sent), repr(data)

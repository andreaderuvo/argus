"""Every flag says what it is for.

`--help` is the documentation people actually read: it is on the machine, it cannot be out of
date, and it is what an issue report quotes. So a flag without a `help=` is a flag nobody can
use — which is how Panoptes shipped a bare `--config`, described in its wiki and nowhere else.

Checked here rather than trusted, because adding a flag and forgetting its sentence is the
easiest omission there is.
"""

from __future__ import annotations

import re
from pathlib import Path

SOURCE = Path(__file__).resolve().parent.parent / "app" / "main.py"

# argparse's own two, which it documents itself.
ITS_OWN = {"-h", "--help", "--version"}


def flags() -> list[tuple[str, str]]:
    """Every `add_argument` call, as (the flags it declares, the whole call)."""
    body = SOURCE.read_text(encoding="utf-8")
    found = []
    for call in re.finditer(r"parser\.add_argument\(", body):
        i, depth = call.end(), 1
        while i < len(body) and depth:
            if body[i] == "(":
                depth += 1
            elif body[i] == ")":
                depth -= 1
            i += 1
        whole = body[call.end():i - 1]
        names = re.findall(r'"(-{1,2}[\w-]+)"', whole)
        if names:
            found.append((names[0], whole))
    return found


def test_every_flag_is_described():
    bare = [name for name, whole in flags() if name not in ITS_OWN and "help=" not in whole]
    assert not bare, f"these flags have no help text: {', '.join(bare)}"


def test_there_are_flags_to_check():
    """A regex that quietly matches nothing would make the test above pass for ever."""
    assert len(flags()) >= 4

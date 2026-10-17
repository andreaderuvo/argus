"""A URL or a path an agent printed over two rows opens with one click — on either half.

Claude Code and Codex lay out their own text: where a long link meets their width they write a
newline and an indent, so for the terminal it is two lines, and a click on either half opened half a
link or nothing (2026-10-17). The rows here are written the same way, at the terminal's width.
"""

from __future__ import annotations

import json
import time

from .test_flows import eventually

URL_HEAD = "https://example.org/argus/reports/2026-10-17/listeria-st6-farm-cluster/"


def lay(text: str, width: int, indent: str = "  ") -> list[str]:
    rows, rest = [text[:width]], text[width:]
    while rest:
        rows.append(indent + rest[: width - len(indent)])
        rest = rest[width - len(indent):]
    return rows


def cell(page, term, row, col):
    """The middle of a cell on screen, from the terminal's own size."""
    box = json.loads(page.eval(f"JSON.stringify((r => [r.left, r.top, r.width, r.height])({term}.querySelector('.xterm-screen').getBoundingClientRect()))"))
    cols, rows = page.eval(f"{term}._term.cols"), page.eval(f"{term}._term.rows")
    return box[0] + (col + 0.5) * box[2] / cols, box[1] + (row + 0.5) * box[3] / rows


def click(page, x, y):
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    time.sleep(0.8)                                  # the link provider answers the hover
    for kind in ("mousePressed", "mouseReleased"):
        page.send("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": "left", "clickCount": 1})


def test_a_link_broken_over_rows_opens_from_its_second_half(make_page, argus):
    deep = argus.root / "docs" / "listeria-st6-farm-cluster" / "2026-10" / "distances"
    deep.mkdir(parents=True, exist_ok=True)
    target = deep / "snp-matrix-final-version-two.tsv"
    target.write_text("a\tb\n")
    argus.tmux("new-session", "-d", "-s", "linked", "-x", "120", "-y", "30")
    try:
        page = make_page(route="#/term?s=linked")
        term = "document.querySelector('#termwrap')"
        page.wait(f"!!{term}?._term", timeout=20, what="the terminal")
        time.sleep(1.5)
        cols = page.eval(f"{term}._term.cols")
        width = cols - 4
        # Longer than a row, whatever the window: it has to break.
        URL = URL_HEAD + "-".join(["snp-distances"] * (cols // 12)) + "/summary.html"
        assert len(URL) > width
        prose = "  Done. Every row of this answer is written at the program's own width, as an agent does it."
        rows = lay(prose, width) + lay(f"  The report is at {URL}", width) + lay(f"  Matrix: {target}", width)
        script = argus.root / "print.sh"
        script.write_text("clear\n" + "".join(f"printf '%s\\n' {json.dumps(r)}\n" for r in rows))
        argus.tmux("send-keys", "-t", "linked", f"sh {script}", "Enter")
        page.wait(f"(() => {{ const b = {term}._term.buffer.active; for (let i = 0; i < b.length; i++)"
                  f" if ((b.getLine(i)?.translateToString(true) || '').includes('Matrix:')) return true; return false; }})()",
                  timeout=10, what="the rows printed")
        page.eval("window.open = (url) => { window.__opened = url; return null; }")

        def screen_row(piece):
            return page.eval(f"(() => {{ const b = {term}._term.buffer.active; for (let i = b.viewportY; i < b.viewportY + {term}._term.rows; i++)"
                             f" {{ const s = b.getLine(i)?.translateToString(true) || ''; const at = s.indexOf({piece!r}); if (at >= 0) return [i - b.viewportY, at]; }} return null; }})()")

        # The URL's second half, which on its own is no URL at all.
        tail = URL[-12:]
        row, col = screen_row(tail)
        click(page, *cell(page, term, row, col + 3))
        eventually(lambda: page.eval("window.__opened || ''") == URL, timeout=5, what="the whole URL opened")

        # The path's last row: opened whole, as a file.
        row, col = screen_row(target.name[-8:])
        click(page, *cell(page, term, row, col + 2))
        page.wait(f"location.hash.includes(encodeURIComponent({str(target)!r}))", timeout=10, what="the whole path opened")
    finally:
        argus.tmux("kill-session", "-t", "linked", check=False)

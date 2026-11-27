"""A path under the mouse in a terminal offers its folder to argus-bridge (termpaths.js showSyncChip).

Asked for on 2026-11-27: hover an absolute path printed in a session and the button to share the folder
appears at once; a path to a file shares the folder that holds it.
"""

from __future__ import annotations

import json
import os
import time

from .test_broken_links import cell


def hover(page, x, y):
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})


def test_a_hovered_file_offers_its_folder_and_opens_the_sync_sheet(make_page, argus):
    folder = argus.root / "runs" / "st6-cluster"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / "distances.tsv"
    target.write_text("a\tb\n")
    argus.tmux("new-session", "-d", "-s", "chip", "-x", "120", "-y", "30")
    try:
        page = make_page(route="#/term?s=chip")
        term = "document.querySelector('#termwrap')"
        page.wait(f"!!{term}?._term", timeout=20, what="the terminal")
        time.sleep(1.2)
        argus.tmux("send-keys", "-t", "chip", f"clear; echo 'Matrix: {target}'", "Enter")
        find = (f"(() => {{ const b = {term}._term.buffer.active; for (let i = b.viewportY; i < b.viewportY + {term}._term.rows; i++)"
                f" {{ const s = b.getLine(i)?.translateToString(true) || ''; if (s.startsWith('Matrix:')) return [i - b.viewportY, s.indexOf('/')]; }} return null; }})()")
        page.wait(f"!!{find}", timeout=10, what="the path printed")
        row, col = page.eval(find)
        chip = "document.querySelector('.pathsync')"
        for _ in range(3):                         # the provider answers the second pass from its cache
            hover(page, *cell(page, term, row, col + 5))
            time.sleep(0.6)
            hover(page, *cell(page, term, row, col + 6))
            if page.eval(f"!!{chip} && !{chip}.hidden"):
                break
        page.wait(f"!!{chip} && !{chip}.hidden", timeout=5, what="the sync chip beside the path")
        assert page.eval(f"{chip}.dataset.folder") == str(folder), "a file offers the folder that holds it"
        assert page.eval(f"{chip}.textContent") == folder.name
        # Beside the path, on its row, not over it.
        box = json.loads(page.eval(f"JSON.stringify({chip}.getBoundingClientRect())"))
        end_x, row_y = cell(page, term, row, col + len(str(target)))
        assert box["left"] >= end_x - 2 and abs(box["top"] + box["height"] / 2 - row_y) < box["height"]
        if os.environ.get("ARGUS_SHOTS"):
            page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "path-sync-chip.png"))

        # The mouse travels to the chip (leaving the link) and it stays to be clicked.
        hover(page, box["left"] + box["width"] / 2, box["top"] + box["height"] / 2)
        time.sleep(0.7)
        assert page.eval(f"!{chip}.hidden"), "the chip waits for the mouse that comes to it"
        page.eval(f"{chip}.click()")
        page.wait("!!document.querySelector('dialog.syncsheet[open]')", timeout=5, what="the sync sheet")
        assert str(folder) in page.eval("document.querySelector('dialog.syncsheet .mwpath').textContent")
    finally:
        argus.tmux("kill-session", "-t", "chip")


def test_the_chip_can_be_switched_off(make_page, argus):
    target = argus.root / "off-here.txt"
    target.write_text("x\n")
    argus.tmux("new-session", "-d", "-s", "chipoff", "-x", "120", "-y", "30")
    try:
        page = make_page(route="#/term?s=chipoff")
        term = "document.querySelector('#termwrap')"
        page.wait(f"!!{term}?._term", timeout=20, what="the terminal")
        page.eval("import('/js/state.js').then((m) => { m.prefs.pathSync = false; })")
        time.sleep(1.2)
        argus.tmux("send-keys", "-t", "chipoff", f"clear; echo 'File: {target}'", "Enter")
        find = (f"(() => {{ const b = {term}._term.buffer.active; for (let i = b.viewportY; i < b.viewportY + {term}._term.rows; i++)"
                f" {{ const s = b.getLine(i)?.translateToString(true) || ''; if (s.startsWith('File:')) return [i - b.viewportY, s.indexOf('/')]; }} return null; }})()")
        page.wait(f"!!{find}", timeout=10, what="the path printed")
        row, col = page.eval(find)
        for _ in range(3):
            hover(page, *cell(page, term, row, col + 3))
            time.sleep(0.6)
            hover(page, *cell(page, term, row, col + 4))
        assert page.eval("!document.querySelector('.pathsync') || document.querySelector('.pathsync').hidden")
        # Switched on again, the same hover brings it: the path was a link all along.
        page.eval("import('/js/state.js').then((m) => { m.prefs.pathSync = true; })")
        hover(page, *cell(page, term, row + 6, 2))             # off the link, then onto it: xterm's hover again
        time.sleep(0.3)
        hover(page, *cell(page, term, row, col + 5))
        page.wait("!!document.querySelector('.pathsync') && !document.querySelector('.pathsync').hidden", timeout=5,
                  what="the chip once switched on")
        assert page.eval("document.querySelector('.pathsync').dataset.folder") == str(argus.root)
    finally:
        argus.tmux("kill-session", "-t", "chipoff")

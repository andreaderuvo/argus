"""Needs you, in the rail: what waits on you in one list, answered from there.

"Copy only the best" (2026-11-04). A question answered with a tap, a late to-do marked done, and the
list says it is clear; the rail's count follows, amber while anything waits.
"""

from __future__ import annotations

import os
import time

from .cdp import PHONE
from .test_flows import eventually


def shoot(page, name):
    where = os.environ.get("ARGUS_SHOTS")
    if where:
        page.screenshot(os.path.join(where, f"{name}.png"))


def test_a_question_and_a_late_to_do_are_answered_from_needs_you(make_page, argus):
    asked = argus.api("/api/ask", "POST", {"text": "Overwrite **results.tsv** with the new run?", "options": ["Yes", "No"],
                                           "session": "fixer", "wait": 0})
    made = argus.api("/api/todo", "POST", {"note": "send the cgMLST matrix to the lab", "due": "2020-01-01"})
    try:
        page = make_page(route="#/needs")
        page.wait("document.querySelectorAll('.needrow').length === 2", timeout=15, what="the two things waiting")
        kinds = page.eval("[...document.querySelectorAll('.needrow')].map(r => r.dataset.kind).join()")
        assert kinds == "ask,todo", kinds
        page.wait("document.querySelector('#nav a[data-tab=\"needs\"] .tally')?.textContent === '2'", timeout=10, what="the rail's count")
        assert page.eval("document.querySelector('#nav a[data-tab=\"needs\"] .tally').classList.contains('wants')"), "amber"
        assert page.eval("!!document.querySelector('.needrow.ask .agentmd strong')"), "the question's own markdown"
        shoot(page, "needs-desktop")

        page.click_at(*page._center("[...document.querySelectorAll('.needrow.ask .needbtn')].find(b => b.textContent === 'No')"))
        eventually(lambda: argus.api(f"/api/ask/{asked['id']}")["answer"] == "No", timeout=10, what="answered")
        page.wait("document.querySelectorAll('.needrow').length === 1", timeout=10, what="the question gone")

        page.click_at(*page._center("document.querySelector('.needrow.todo .needbtn.primary')"))
        eventually(lambda: next(x for x in argus.api("/api/todo")["items"] if x["id"] == made["id"])["status"] == "done",
                   timeout=10, what="the to-do done")
        page.wait("!!document.querySelector('.needempty')", timeout=10, what="all clear")
        page.wait("!document.querySelector('#nav a[data-tab=\"needs\"] .tally')", timeout=10, what="no count")
    finally:
        argus.api(f"/api/todo/{made['id']}", "DELETE")


def test_needs_you_on_a_phone_is_in_the_drawer_with_its_count(make_page, argus):
    made = argus.api("/api/todo", "POST", {"note": "renew the certificate", "due": "2020-01-01"})
    try:
        page = make_page(viewport=PHONE, route="#/needs")
        page.wait("document.querySelectorAll('.needrow').length === 1", timeout=15)
        page.wait("document.querySelector('.drawertally[data-for=\"needs\"]')?.textContent === '1'", timeout=10, what="its count in the drawer")
        width = page.eval("document.documentElement.scrollWidth")
        assert width <= 390, f"nothing wider than the phone ({width}px)"
        shoot(page, "needs-phone")
    finally:
        argus.api(f"/api/todo/{made['id']}", "DELETE")


QUIET = """#!/usr/bin/env python3
import time
print('Which reference: GRCh38 or T2T?', flush=True)
time.sleep(600)
"""


def test_open_brings_the_agents_window_forward_on_its_own_desk(make_page, argus, tmp_path):
    """"Open" on an agent that waits goes to its window: its desk made the one on screen — here one
    put away in the rail — and the window raised and out of the dock."""
    (tmp_path / "claude").write_text(QUIET)
    (tmp_path / "claude").chmod(0o755)
    argus.tmux("new-session", "-d", "-s", "aligner", "-x", "80", "-y", "20", str(tmp_path / "claude"))
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Main", "desktop": []},
        {"id": 2, "name": "Mapping", "hidden": True, "desktop": [{"kind": "term", "name": "aligner", "docked": True}]}]}})
    try:
        eventually(lambda: any(x["kind"] == "waiting" and x["session"] == "aligner" for x in argus.api("/api/needs")["items"]),
                   timeout=30, what="the agent waiting")
        page = make_page(route="#/needs")
        row = "document.querySelector('.needrow.waiting')"
        page.wait(f"!!{row}", timeout=15, what="the agent in the list")
        page.click_at(*page._center(f"[...{row}.querySelectorAll('.needbtn')].find(b => b.textContent === 'Open')"))
        win = "document.querySelector('.deck.on .win[data-session=\"aligner\"]')"
        page.wait(f"!!{win} && !{win}.hidden", timeout=15, what="its window on screen, out of the dock")
        assert page.eval("location.hash").startswith("#/wall")
        assert "Mapping" in page.eval("document.querySelector('.wstab.on')?.textContent || ''"), "its desk the one on screen"
        eventually(lambda: not next(w for w in argus.api("/api/prefs")["prefs"]["workspaces"] if w["id"] == 2).get("hidden"),
                   timeout=5, what="back from the rail")
    finally:
        argus.tmux("new-session", "-d", "-s", "keep-server", check=False)
        argus.tmux("kill-session", "-t", "aligner", check=False)
        time.sleep(1.6)
        argus.tmux("kill-session", "-t", "keep-server", check=False)


def test_needs_you_beside_the_page_left_or_right_of_the_file_sidebar(make_page, argus):
    """"Needs you also as a sidebar, right or left, beside the main one — all of it chosen"
    (2026-11-04). Chosen on the screen, moved and closed from its own bar, toggled with a key."""
    made = argus.api("/api/todo", "POST", {"note": "renew the certificate", "due": "2020-01-01"})
    argus.api("/api/prefs", "PATCH", {"changes": {"sidebar": True}})
    try:
        page = make_page(route="#/needs")
        page.wait("!!document.querySelector('.needside.off.on')", timeout=15, what="off at first")
        box = lambda sel: page.eval(f"(() => {{ const b = document.querySelector('{sel}').getBoundingClientRect(); return [b.left, b.right, b.width]; }})()")  # noqa: E731

        page.click_at(*page._center("document.querySelector('.needside.left')"))
        page.wait("!!document.querySelector('#needpanel .needrow.todo')", timeout=10, what="the panel, with what waits")
        side, panel, view = box("#side"), box("#needpanel"), box("#view")
        assert side[1] <= panel[0] + 1 and panel[1] <= view[0] + 1, ("files, then Needs you, then the page", side, panel, view)
        eventually(lambda: argus.api("/api/prefs")["prefs"].get("needsPanel") == "left", timeout=5, what="kept")
        shoot(page, "needs-panel-left")

        page.click_at(*page._center("document.querySelector('#needpanel .needpswap')"))
        page.wait("document.body.classList.contains('needright')", timeout=5)
        side, panel, view = box("#side"), box("#needpanel"), box("#view")
        assert side[1] <= view[0] + 1 and view[1] <= panel[0] + 1, ("files, the page, then Needs you", side, panel, view)
        assert page.eval("!!document.querySelector('#needpanel .needrow.todo')"), "the same list, moved"

        # On every screen, and the list answers from there.
        page.eval("location.hash = '#/files'")
        page.wait("!!document.querySelector('#needpanel .needrow.todo') && location.hash === '#/files'", timeout=10)
        shoot(page, "needs-panel-right")
        page.click_at(*page._center("document.querySelector('#needpanel .needrow.todo .needbtn.primary')"))
        page.wait("!!document.querySelector('#needpanel .needempty')", timeout=10, what="all clear, in the panel")

        page.click_at(*page._center("[...document.querySelectorAll('#needpanel .needpbar .icon')].pop()"))
        page.wait("!document.body.classList.contains('needright') && getComputedStyle(document.querySelector('#needpanel')).display === 'none'", timeout=5)
        page.key("i", "KeyI", modifiers=3)     # Ctrl+Alt+I: back, on the side it was on
        page.wait("document.body.classList.contains('needright')", timeout=5, what="back on the right")
    finally:
        argus.api(f"/api/todo/{made['id']}", "DELETE")


def test_long_words_are_cut_and_opened_whole_in_place(make_page, argus):
    """"Can the tile have all the text? Show some, and with a button one can read it all" (2026-11-04)."""
    long = "Before I overwrite **results.tsv**:\n\n" + "\n\n".join(f"- sample {i}: 412 loci differ from the last run" for i in range(1, 31))
    asked = argus.api("/api/ask", "POST", {"text": long, "options": ["Yes", "No"], "session": "fixer", "wait": 0})
    short = argus.api("/api/ask", "POST", {"text": "Go on?", "options": ["Yes", "No"], "session": "other", "wait": 0})
    try:
        page = make_page(route="#/needs")
        card = "[...document.querySelectorAll('.needrow')].find(r => r.textContent.includes('results.tsv'))"
        page.wait(f"!!{card}?.querySelector('.needmore:not([hidden])')", timeout=15, what="cut, with Show all")
        assert page.eval("[...document.querySelectorAll('.needrow')].find(r => r.textContent.includes('Go on?')).querySelector('.needmore').hidden"), \
            "a short one is whole, with nothing to press"
        closed = page.eval(f"{card}.querySelector('.needbody').clientHeight")
        assert closed < 200, closed
        page.click_at(*page._center(f"{card}.querySelector('.needmore')"))
        page.wait(f"{card}.querySelector('.needbody').clientHeight > {closed * 3}", timeout=5, what="opened whole")
        assert "sample 30" in page.eval(f"{card}.querySelector('.needbody').innerText")
        # Drawn again (the other one answered elsewhere): still open.
        argus.api(f"/api/ask/{short['id']}/answer", "POST", {"answer": "No"})
        page.wait("document.querySelectorAll('.needrow').length === 1", timeout=10)
        page.wait(f"{card}.querySelector('.needbody').classList.contains('open')", timeout=5, what="still open")
        shoot(page, "needs-long")
    finally:
        for one in (asked, short):
            try:
                argus.api(f"/api/ask/{one['id']}/answer", "POST", {"answer": "No"})
            except Exception:
                pass

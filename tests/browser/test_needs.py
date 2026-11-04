"""Needs you, in the rail: what waits on you in one list, answered from there.

"Copy only the best" (2026-11-04). A question answered with a tap, a late to-do marked done, and the
list says it is clear; the rail's count follows, amber while anything waits.
"""

from __future__ import annotations

import os

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

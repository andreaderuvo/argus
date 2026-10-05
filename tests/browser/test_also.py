""""Also →": a prompt typed to one agent, sent to another of the desk as well.

Checked by effect. Two stand-in agents (named so Argus counts them as agents) each run the lines
they are given, in folders of their own: a prompt that reaches both leaves a file in both.
"""

from __future__ import annotations

import time

from .test_flows import eventually

RUNS_LINES = """#!/usr/bin/env python3
import os, sys
print('ready', flush=True)
for line in sys.stdin:
    os.system(line)
"""


def desk(argus, tmp_path):
    a, b = tmp_path / "a", tmp_path / "b"
    a.mkdir(exist_ok=True)
    b.mkdir(exist_ok=True)
    for name in ("claude", "codex"):
        (tmp_path / name).write_text(RUNS_LINES)
        (tmp_path / name).chmod(0o755)
    argus.tmux("new-session", "-d", "-s", "writer", "-x", "80", "-y", "12", "-c", str(a), str(tmp_path / "claude"))
    argus.tmux("new-session", "-d", "-s", "checker", "-x", "80", "-y", "12", "-c", str(b), str(tmp_path / "codex"))
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Pair", "desktop": [{"kind": "term", "name": "writer"}, {"kind": "term", "name": "checker"}]},
    ]}})
    eventually(lambda: {"writer", "checker"} <= set(argus.api("/api/tmux/states")["states"]),
               timeout=20, what="both to be known as agents")
    return a, b


def into_writer(page):
    page.wait("!!document.querySelector('.win[data-session=\"writer\"] .xterm-screen')", timeout=15, what="the writer")
    page.wait("!!document.querySelector('.win[data-session=\"checker\"] .xterm-screen')", timeout=15, what="the checker")
    time.sleep(1)
    page.click_at(*page._center("document.querySelector('.win[data-session=\"writer\"] .xterm-screen')"))
    time.sleep(0.3)


def chip(page):
    return "document.querySelector('.win[data-session=\"writer\"] .alsochip')"


def test_armed_before_enter_the_prompt_goes_to_both(make_page, argus, tmp_path):
    a, b = desk(argus, tmp_path)
    page = make_page(route="#/wall")
    into_writer(page)
    page.type("touch armed")
    page.wait(f"{chip(page)} && !{chip(page)}.hidden", timeout=5, what="the also button while typing")
    assert "checker" in page.eval(f"{chip(page)}.textContent")
    page.click_at(*page._center(f"{chip(page)}.querySelector('.alsomain')"))
    page.wait(f"{chip(page)}.querySelector('.alsomain.on')", timeout=3, what="it to be armed")
    page.key("Enter", "Enter", text="\r")
    eventually(lambda: (a / "armed").exists(), timeout=10, what="the writer to run it")
    eventually(lambda: (b / "armed").exists(), timeout=10, what="the checker to have been given it too")
    for s in ("writer", "checker"):
        argus.tmux("kill-session", "-t", s, check=False)


def test_after_the_enter_it_offers_to_send_it_too(make_page, argus, tmp_path):
    a, b = desk(argus, tmp_path)
    page = make_page(route="#/wall")
    into_writer(page)
    page.type("touch later")
    page.key("Enter", "Enter", text="\r")
    eventually(lambda: (a / "later").exists(), timeout=10, what="the writer to run it")
    page.wait(f"{chip(page)} && !{chip(page)}.hidden && {chip(page)}.textContent.includes('too')", timeout=5, what="the offer after")
    time.sleep(0.5)
    assert not (b / "later").exists(), "nothing goes anywhere unasked"
    page.click_at(*page._center(f"{chip(page)}.querySelector('.alsomain')"))
    eventually(lambda: (b / "later").exists(), timeout=10, what="the checker to be given it")
    for s in ("writer", "checker"):
        argus.tmux("kill-session", "-t", s, check=False)


def test_a_line_it_cannot_be_sure_of_is_not_offered(make_page, argus, tmp_path):
    desk(argus, tmp_path)
    page = make_page(route="#/wall")
    into_writer(page)
    page.type("touch x")
    page.wait(f"{chip(page)} && !{chip(page)}.hidden", timeout=5, what="the button")
    page.key("ArrowLeft", "ArrowLeft")                    # now what is on the line is not known
    page.wait(f"{chip(page)}.hidden", timeout=3, what="the button to go")
    page.key("Enter", "Enter", text="\r")
    time.sleep(0.6)
    assert page.eval(f"{chip(page)}.hidden"), "and no offer after an Enter on a line it lost"
    for s in ("writer", "checker"):
        argus.tmux("kill-session", "-t", s, check=False)


def test_a_chain_of_one_does_not_hide_it(make_page, argus, tmp_path):
    """Found on a real desk: the session typed into was the only one in the desk's chain. A
    chain of one sends nothing anywhere, and the button never appeared."""
    a, b = desk(argus, tmp_path)
    argus.api("/api/prefs", "PATCH", {"changes": {"chain": {"1": ["writer"]}}})
    page = make_page(route="#/wall")
    into_writer(page)
    page.type("touch chained")
    page.wait(f"{chip(page)} && !{chip(page)}.hidden", timeout=5, what="the also button, chain of one or not")
    for s in ("writer", "checker"):
        argus.tmux("kill-session", "-t", s, check=False)

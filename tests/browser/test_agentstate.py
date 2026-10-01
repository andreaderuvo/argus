"""Working or waiting, as the screens show it — with two fake agents in the test's own tmux."""

from __future__ import annotations

import json
import time

import pytest

from .cdp import DESKTOP, PHONE

# Named `claude` and `codex` so the server recognises them as agents: one draws like a spinner
# for a while and then goes quiet, the other asks something and waits from the start.
SPINS_THEN_STOPS = """#!/usr/bin/env python3
import sys, time
end = time.time() + {seconds}
while time.time() < end:
    for c in '|/-':
        sys.stdout.write('\\r' + c + ' thinking'); sys.stdout.flush(); time.sleep(0.2)
print('\\ndone. Anything else?'); sys.stdout.flush()
time.sleep(600)
"""
ASKS = """#!/usr/bin/env python3
import time
print('Which do you want: memory or disk?', flush=True)
time.sleep(600)
"""


def agents(tmp_path, argus, spin_for: int):
    (tmp_path / "claude").write_text(SPINS_THEN_STOPS.format(seconds=spin_for))
    (tmp_path / "codex").write_text(ASKS)
    for name in ("claude", "codex"):
        (tmp_path / name).chmod(0o755)
    argus.tmux("new-session", "-d", "-s", "busy", "-x", "80", "-y", "20", str(tmp_path / "claude"))
    argus.tmux("new-session", "-d", "-s", "asking", "-x", "80", "-y", "20", str(tmp_path / "codex"))


def pill(name: str) -> str:
    return f"document.querySelector('.agentstate[data-session={json.dumps(name)}]')"


@pytest.mark.parametrize("size", [pytest.param(DESKTOP, id="desktop"), pytest.param(PHONE, id="phone")])
def test_the_sessions_screen_says_who_is_working_and_who_waits(make_page, argus, tmp_path, size):
    agents(tmp_path, argus, spin_for=14)
    page = make_page(viewport=size, route="#/sessions")
    page.wait(f"{pill('busy')}?.classList.contains('working')", timeout=15, what="busy shown as working")
    page.wait(f"{pill('asking')}?.classList.contains('waiting')", timeout=15, what="asking shown as waiting")
    assert page.eval(f"{pill('asking')}.textContent").startswith("waiting for you")
    # Somebody is waiting: the count turns amber, whether or not anything rang.
    page.wait("[...document.querySelectorAll('.tally, .drawertally, #hamburger')].some(e => e.classList.contains('wants'))",
              timeout=10, what="the amber on the count")
    # And it follows the agent without a reload: the spinner stops, the row changes.
    page.wait(f"{pill('busy')}?.classList.contains('waiting')", timeout=30, what="busy to become waiting once it stops")


def test_a_desk_window_shows_the_state_of_its_agent(make_page, argus, tmp_path):
    agents(tmp_path, argus, spin_for=60)
    page = make_page(route="#/sessions")
    page.wait(f"{pill('asking')}?.classList.contains('waiting')", timeout=15, what="the list to know")
    # The row's own button: open this session in a window on a desk.
    page.click_at(*page._center(
        "[...document.querySelectorAll('.rowwrap.sess')].find(w => w.textContent.includes('asking'))"
        ".querySelector('button[title^=\"Open in a window\"]')"))
    page.wait("document.body.classList.contains('wall')", timeout=10, what="the desk")
    page.wait("document.querySelector('.win[data-session=\"asking\"]')?.classList.contains('agent-waiting')",
              timeout=15, what="the window of the waiting agent to say so")
    assert not page.eval("document.querySelector('.win[data-session=\"asking\"]').classList.contains('agent-working')")


def test_the_desk_tabs_say_which_desk_has_an_agent_waiting(make_page, argus, tmp_path):
    """The tab's dot follows the agents' states, not bytes arriving: amber and steady while one
    waits, pulsing while one works — including on a desk not opened since the page loaded,
    which has no windows in the document and is exactly the desk you are not looking at."""
    agents(tmp_path, argus, spin_for=60)
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Here", "desktop": [{"kind": "term", "name": "busy"}]},
        {"id": 2, "name": "Elsewhere", "desktop": [{"kind": "term", "name": "asking"}]},
    ]}})
    page = make_page(route="#/wall")
    tab = lambda ws: f"document.querySelector('.wstab[data-ws=\"{ws}\"]')"
    page.wait(f"{tab(2)}?.classList.contains('agents-waiting')", timeout=20, what="the unopened desk to say someone waits")
    page.wait(f"{tab(1)}?.classList.contains('agents-working')", timeout=20, what="the open desk to say its agent works")
    assert not page.eval("!!document.querySelector('.deck[data-ws=\"2\"] .win')"), "desk 2 must not have been built"
    assert "waiting for you" in page.eval(f"{tab(2)}.dataset.agents")
    assert not page.eval(f"{tab(1)}.classList.contains('agents-waiting')")
    # Hovering the tab opens a card naming the agent, its session and how long it has waited.
    x, y = page._center(tab(2))
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    page.wait("document.querySelector('.deskcard')?.isConnected", timeout=5, what="the card under the tab")
    rows = page.eval("JSON.stringify([...document.querySelectorAll('.deskcardrow')].map(r => [r.className, r.textContent]))")
    rows = json.loads(rows)
    assert len(rows) == 1 and "waiting" in rows[0][0] and "asking" in rows[0][1] and "codex" in rows[0][1], rows
    assert page.eval(f"{tab(2)}.title") == "", "the native hint must not open on top of the card"
    import os
    if os.environ.get("ARGUS_SHOT"):           # a picture to look at, never asserted on
        time.sleep(0.5)
        page.screenshot(os.environ["ARGUS_SHOT"])
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": 5, "y": 400, "button": "none"})
    page.wait("!document.querySelector('.deskcard')?.isConnected", timeout=5, what="the card to go")
    assert page.eval(f"{tab(2)}.title") != "", "and the hint comes back"
    # "Got it": seen, nothing to do. The desk stops asking, the amber leaves the counts, and the
    # card says it was seen rather than forgetting the agent.
    x, y = page._center(tab(2))
    page.send("Input.dispatchMouseEvent", {"type": "mouseMoved", "x": x, "y": y, "button": "none"})
    page.wait("!!document.querySelector('.deskcardok')", timeout=5, what="the Got it button")
    page.click_at(*page._center("document.querySelector('.deskcardok')"))
    page.wait(f"!{tab(2)}.classList.contains('agents-waiting')", timeout=5, what="the desk to stop asking")
    page.wait("![...document.querySelectorAll('.tally, .drawertally, #hamburger')].some(e => e.classList.contains('wants'))",
              timeout=5, what="the amber to leave the counts")
    assert argus.api("/api/tmux/states")["states"]["asking"]["seen"] is True

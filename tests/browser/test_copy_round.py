"""Every terminal on a page asks about copy mode together: one request per round, not one each."""

from __future__ import annotations

import time


def test_one_request_per_round_and_the_button_still_follows_tmux(make_page, argus):
    argus.kill_sessions()
    names = ["t1", "t2", "t3"]
    for n in names:
        argus.tmux("new-session", "-d", "-s", n, "-x", "90", "-y", "25")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": n} for n in names]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait("document.querySelectorAll('.win').length === 3", timeout=20)
    seen = []
    page._listeners.append(lambda m: m.get("method") == "Network.requestWillBeSent" and seen.append(m["params"]["request"]["url"]))
    time.sleep(6)
    rounds = [u for u in seen if "/api/tmux/copymodes" in u]
    single = [u for u in seen if "/api/tmux/copymode?" in u]
    assert 1 <= len(rounds) <= 4 and not single, (len(rounds), len(single))
    assert all(all(n in u for n in names) for u in rounds), "all three in each round"
    argus.tmux("send-keys", "-t", "t2", "seq 300", "Enter")
    time.sleep(0.5)
    argus.tmux("copy-mode", "-t", "t2")
    page.wait("!document.querySelector('.win[data-session=\"t2\"] .toend').hidden", timeout=8, what="the button, from the round")
    assert page.eval("document.querySelector('.win[data-session=\"t1\"] .toend').hidden")
    argus.kill_sessions()

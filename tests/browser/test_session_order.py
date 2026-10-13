"""Sessions: the day each started beside how long it has been up, and the list in the order asked —
by name, newest first or oldest first, kept across visits."""

from __future__ import annotations

import time

from .test_flows import eventually

NAMES = "[...document.querySelectorAll('#view .row.dir .name > span:first-child')].map(n => n.textContent)"


def test_sessions_say_when_they_started_and_sort_by_it(make_page, argus):
    argus.kill_sessions()
    for name in ("b-middle", "a-newest", "c-oldest")[::-1]:     # c first, then a: started in that order
        argus.tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24")
        time.sleep(1.2)
    argus.tmux("new-session", "-d", "-s", "zz-pad", "-x", "80", "-y", "24")
    page = make_page(route="#/sessions")
    page.wait(f"{NAMES}.length === 4", timeout=10)
    assert page.eval(NAMES) == ["a-newest", "b-middle", "c-oldest", "zz-pad"], "by name first"
    meta = page.eval("document.querySelector('#view .row.dir .meta').textContent")
    assert "up " in meta and "since " in meta, meta
    page.eval("(() => { const s = document.querySelector('.sessorder'); s.value = 'oldest'; s.onchange(); })()")
    page.wait(f"{NAMES}.join() === 'c-oldest,a-newest,b-middle,zz-pad'", timeout=5, what="oldest first")
    page.eval("(() => { const s = document.querySelector('.sessorder'); s.value = 'newest'; s.onchange(); })()")
    page.wait(f"{NAMES}.join() === 'zz-pad,b-middle,a-newest,c-oldest'", timeout=5, what="newest first")
    eventually(lambda: argus.api("/api/prefs")["prefs"].get("sessionOrder") == "newest", timeout=10, what="kept")
    again = make_page(route="#/sessions")
    again.wait(f"{NAMES}.join() === 'zz-pad,b-middle,a-newest,c-oldest' && document.querySelector('.sessorder').value === 'newest'",
               timeout=10, what="still newest first on the next visit")
    argus.kill_sessions()


def test_the_quietest_first_and_the_ones_asleep_for_days(make_page, argus):
    argus.kill_sessions()
    activity = lambda s: int(argus.tmux("display-message", "-p", "-t", s, "#{window_activity}").stdout.strip() or 0)  # noqa: E731

    def settled(s):
        # A shell's start-up can print late under load (a login profile, conda): wait until quiet.
        last, still = activity(s), 0
        while still < 3:
            time.sleep(0.5)
            now = activity(s)
            still = still + 1 if now == last else 0
            last = now

    argus.tmux("new-session", "-d", "-s", "busy", "-x", "80", "-y", "24")
    argus.tmux("new-session", "-d", "-s", "idle", "-x", "80", "-y", "24")
    settled("busy")
    settled("idle")
    time.sleep(1.1)
    argus.tmux("send-keys", "-t", "busy", "echo still here", "Enter")     # output: busy is the recent one now
    eventually(lambda: activity("busy") > activity("idle"), timeout=10, what="busy the more recent")
    page = make_page(route="#/sessions")
    page.wait(f"{NAMES}.length === 2", timeout=10)
    page.eval("(() => { const s = document.querySelector('.sessorder'); s.value = 'quiet'; s.onchange(); })()")
    page.wait(f"{NAMES}.join() === 'idle,busy'", timeout=5, what="the one nothing happened in first")
    assert not page.eval("!!document.querySelector('.teambadge.asleep')") and page.eval("document.querySelector('.sessdormant').hidden")
    # Asleep: two days without output or a key — said on the row, and one press ticks them all.
    week = "Date.now() / 1000 - 7 * 86400"
    assert page.eval(f"import('/js/screens.js').then(m => [m.isDormant({{ activity: {week} }}), m.isDormant({{ activity: Date.now() / 1000 - 3600 }}), m.isDormant({{}})])") == [True, False, False]
    argus.kill_sessions()

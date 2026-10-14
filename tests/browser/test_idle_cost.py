"""What a screen costs while nobody touches it, on a slow computer (the CPU slowed 6×).

Found 2026-10-14 on "an old PC where everything is slow": the rail's fades repainted themselves
every frame through their own MutationObserver — 4 s of CPU in 10 idle seconds, 6,600 style
recalculations. Idle must be idle: a screen left open all day on an old laptop is the normal case."""

from __future__ import annotations

import time

import pytest

SCREENS = ["#/wall?ws=1", "#/files", "#/sessions", "#/system", "#/todo", "#/since", "#/settings", "#/prompts", "#/journal"]
WINDOW = 5.0


def measure(page, seconds=WINDOW):
    page.send("Performance.enable")
    page.send("Emulation.setCPUThrottlingRate", {"rate": 6})
    get = lambda: {m["name"]: m["value"] for m in page.send("Performance.getMetrics")["metrics"]}  # noqa: E731
    a = get()
    time.sleep(seconds)
    b = get()
    page.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    return {k: b[k] - a[k] for k in ("TaskDuration", "ScriptDuration", "RecalcStyleCount", "LayoutCount")}


@pytest.fixture
def busy_desk(argus):
    argus.kill_sessions()
    names = [f"s{i}" for i in range(4)]
    for n in names:
        argus.tmux("new-session", "-d", "-s", n, "-x", "100", "-y", "30")
    desk = [{"kind": "term", "name": n} for n in names] + [{"kind": "browser", "path": str(argus.root), "id": "b1"}]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Main", "desktop": desk}]}})
    yield names
    argus.kill_sessions()


@pytest.mark.parametrize("route", SCREENS)
def test_a_screen_left_alone_costs_almost_nothing(make_page, busy_desk, route):
    page = make_page(route=route)
    if route.startswith("#/wall"):
        page.wait("document.querySelectorAll('.win').length === 5", timeout=20)
    time.sleep(2.5)                                       # past the first paint and its first answers
    cost = measure(page)
    print(f"IDLE {route}: {cost}")
    # Measured healthy: script ≤ 0.04 s and ≤ 27 recalculations in 5 s; the loop that prompted this
    # gave 0.62 s and 2,616. Total task time is printed but not asserted: under -n 16 the machine's
    # own load moves it, while these two count what the page itself did.
    assert cost["ScriptDuration"] < 0.3, f"{route} ran script {cost['ScriptDuration']:.2f}s of {WINDOW}s idle: {cost}"
    assert cost["RecalcStyleCount"] < 120, f"{route} recalculates styles {cost['RecalcStyleCount']:.0f} times in {WINDOW}s idle"

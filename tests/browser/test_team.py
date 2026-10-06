"""A team, started from the desk in three questions, watched in one line, stopped with one press."""

from __future__ import annotations

import json
import time

from .test_flows import eventually


def test_a_team_is_started_from_the_desk_and_shows_on_it(make_page, argus):
    argus.kill_sessions()
    project = argus.root / "home"
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Work", "desktop": [], "home": str(project)},
    ]}})
    page = make_page(route="#/wall")
    page.click_at(*page._center("[...document.querySelectorAll('#walltools button')].find(b => b.textContent.trim() === 'Team')"))
    page.wait("!!document.querySelector('.teamcard')", timeout=20, what="the templates")
    page.click_at(*page._center("document.querySelector('.teamgoal')"))
    page.type("fix the crash on empty input")
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Fix a bug')", timeout=5,
              what="the template the goal reads like")
    page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent for the role, from the launchers")
    check = "document.querySelector('.teamcheck input')"
    page.eval(f"{check}.value = 'test -f fixed'; {check}.dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('.sheetfoot button')].find(b => b.textContent === 'Start the team')"))
    page.wait("!document.querySelector('dialog.sheet')", timeout=40, what="the team to start")

    # The agent's window and the check's are on the desk, and the line over it says whose turn it is.
    page.wait("!!document.querySelector('.win[data-session=\"Fix-a-bug-executor\"]')", timeout=10, what="the executor's window")
    page.wait("!!document.querySelector('.win[data-session=\"Fix-a-bug-check\"]')", timeout=10, what="the check's window")
    page.wait("document.querySelector('.teamstrip .teamline')?.textContent.includes('round 1 of 10')", timeout=10, what="the team's line")
    assert page.eval("document.querySelector('.teamstep.now')?.textContent.trim()") == "executor"
    team = argus.api("/api/teams")["teams"][0]
    assert team["template"] == "fix" and team["check"] == "test -f fixed" and team["ws"] == 1
    assert (project / "TEAM.argus.md").exists()

    # Stop is one press, and a stopped team can be forgotten.
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.textContent === 'Stop')"))
    eventually(lambda: argus.api("/api/teams")["teams"][0]["status"] == "stopped", timeout=10, what="the team to stop")
    page.wait("document.querySelector('.teamline')?.textContent.includes('stopped')", timeout=10, what="the line to say so")
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.title === 'Forget this team')"))
    eventually(lambda: argus.api("/api/teams")["teams"] == [], timeout=10, what="the team to be forgotten")
    (project / "TEAM.argus.md").unlink(missing_ok=True)
    argus.kill_sessions()

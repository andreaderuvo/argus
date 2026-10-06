"""A team, started from the desk in three questions, drawn as a graph, changed with clicks, watched
live over the desk, stopped with one press."""

from __future__ import annotations

import time

from .test_flows import eventually


def open_sheet(page, argus, goal):
    page.click_at(*page._center("[...document.querySelectorAll('#walltools button')].find(b => b.textContent.trim() === 'Team')"))
    page.wait("!!document.querySelector('.teamcard') && !!document.querySelector('.teampicture svg')", timeout=20, what="the templates and the graph")
    page.click_at(*page._center("document.querySelector('.teamgoal')"))
    page.type(goal)


def desk(argus):
    argus.kill_sessions()
    project = argus.root / "home"
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Work", "desktop": [], "home": str(project)},
    ]}})
    return project


def start(page):
    page.click_at(*page._center("[...document.querySelectorAll('.sheetfoot button')].find(b => b.textContent === 'Start the team')"))
    page.wait("!document.querySelector('dialog.sheet')", timeout=60, what="the team to start")


def clean(argus, project):
    for team in argus.api("/api/teams")["teams"]:
        argus.api(f"/api/teams/{team['id']}/stop", "POST", {})
        argus.api(f"/api/teams/{team['id']}", "DELETE")
    (project / "TEAM.argus.md").unlink(missing_ok=True)
    argus.kill_sessions()


def test_a_team_is_started_from_the_desk_and_shows_on_it_as_a_graph(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "fix the crash on empty input")
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Fix a bug')", timeout=5,
              what="the template the goal reads like")
    page.wait("document.querySelectorAll('.teampicture .tgnode').length === 3", timeout=5, what="its graph: executor, check, end")
    page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent for the step, from the launchers")
    check = "document.querySelector('.teamcheck input')"
    page.eval(f"{check}.value = 'test -f fixed'; {check}.dispatchEvent(new Event('input'))")
    start(page)

    # The agent's window and the check's are on the desk, and the graph over it says whose turn it is.
    page.wait("!!document.querySelector('.win[data-session=\"Fix-a-bug-executor\"]')", timeout=10, what="the executor's window")
    page.wait("!!document.querySelector('.win[data-session=\"Fix-a-bug-check\"]')", timeout=10, what="the check's window")
    page.wait("document.querySelector('.teamstrip .teamline')?.textContent.includes('round 1 of 10')", timeout=10, what="the team's line")
    page.wait("[...document.querySelectorAll('.teamstrip .tgnode')].some(n => n.classList.contains('executor') || n.textContent.startsWith('executor') && (n.classList.contains('running') || n.classList.contains('waiting')))",
              timeout=10, what="the executor's step, live")
    team = argus.api("/api/teams")["teams"][0]
    assert team["template"] == "fix" and team["ws"] == 1
    assert next(n for n in team["nodes"] if n["id"] == "check")["command"] == "test -f fixed"
    assert (project / "TEAM.argus.md").exists()

    # Stop is one press, and a stopped team can be forgotten.
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.textContent === 'Stop')"))
    eventually(lambda: argus.api("/api/teams")["teams"][0]["status"] == "stopped", timeout=10, what="the team to stop")
    page.wait("document.querySelector('.teamline')?.textContent.includes('stopped')", timeout=10, what="the line to say so")
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.title === 'Forget this team')"))
    eventually(lambda: argus.api("/api/teams")["teams"] == [], timeout=10, what="the team to be forgotten")
    clean(argus, project)


def test_a_step_added_in_parallel_with_a_click_is_in_the_team_that_runs(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "make the parser faster")
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Optimise')", timeout=5, what="Optimise")
    # Click the executor in the picture: its panel opens.
    page.click_at(*page._center("[...document.querySelectorAll('.teampicture .tgnode')].find(n => n.querySelector('.tgtext')?.textContent === 'executor')"))
    page.wait("!document.querySelector('.teamnode').hidden", timeout=5, what="the step's panel")
    page.click_at(*page._center("[...document.querySelectorAll('.teamnode button')].find(b => b.textContent === '+ agent in parallel')"))
    page.wait("[...document.querySelectorAll('.teampicture .tgtext')].some(t => t.textContent === 'executor-b')", timeout=5,
              what="the new branch, drawn")
    page.wait("document.querySelectorAll('.teamrole').length === 3", timeout=25, what="an agent for it too")
    check = "document.querySelector('.teamcheck input')"
    page.eval(f"{check}.value = 'true'; {check}.dispatchEvent(new Event('input'))")
    start(page)
    team = argus.api("/api/teams")["teams"][0]
    ids = {n["id"] for n in team["nodes"]}
    assert {"executor", "executor-b", "check", "reviewer"} <= ids
    edges = {(e["from"], e["to"], e["when"]) for e in team["edges"]}
    assert ("executor-b", "check", "always") in edges, "the branch goes where the executor goes"
    running = {n["id"] for n in team["nodes"] if n["state"] == "running"}
    assert running == {"executor", "executor-b"}, "and both start together"
    page.wait("!!document.querySelector('.win[data-session=\"Optimise-executor-b\"]')", timeout=10, what="its window")
    clean(argus, project)


def test_a_shape_saved_as_a_model_comes_back_as_a_card(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "write the report")
    page.click_at(*page._center("[...document.querySelectorAll('.teampicturehead button')].find(b => b.textContent === 'Save as my model')"))
    page.wait("!!document.querySelector('dialog.sheet:last-of-type input')", timeout=5, what="the name to save it under")
    page.eval("const i = [...document.querySelectorAll('dialog.sheet input')].pop(); i.value = 'my review'; i.dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Save')"))
    page.wait("[...document.querySelectorAll('.teamcard.mine')].some(c => c.textContent.includes('my review'))", timeout=5,
              what="the model, as a card")
    eventually(lambda: "my review" in (argus.api("/api/prefs")["prefs"].get("teamModels") or {}), timeout=10,
               what="kept with the other preferences")
    saved = argus.api("/api/prefs")["prefs"]["teamModels"]["my review"]
    assert all("session" not in n for n in saved["nodes"]), "the shape, not the sessions of a run"
    clean(argus, project)


def test_a_role_of_your_own_is_saved_and_offered_again(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "make the parser faster")
    page.click_at(*page._center("[...document.querySelectorAll('.teampicture .tgnode')].find(n => n.querySelector('.tgtext')?.textContent === 'reviewer')"))
    page.wait("!document.querySelector('.teamnode').hidden", timeout=5, what="the step's panel")
    duty = "document.querySelector('.teamnode .teamduty')"
    page.eval(f"{duty}.value = 'Use your /security-review skill on the diff.'; {duty}.dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('.teamnode button')].find(b => b.textContent === 'Save as a role of mine')"))
    page.wait("!!document.querySelector('dialog.sheet:last-of-type input')", timeout=5, what="the name to save it under")
    page.eval("const i = [...document.querySelectorAll('dialog.sheet input')].pop(); i.value = 'Security Auditor!'; i.dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Save')"))
    eventually(lambda: "security auditor" in (argus.api("/api/prefs")["prefs"].get("teamRoles") or {}), timeout=10,
               what="kept with the other preferences, under a clean name")
    saved = argus.api("/api/prefs")["prefs"]["teamRoles"]["security auditor"]
    assert saved == {"duty": "Use your /security-review skill on the diff.", "judge": True}
    # Another step can take it: choosing it brings its duty along.
    page.click_at(*page._center("[...document.querySelectorAll('.teampicture .tgnode')].find(n => n.querySelector('.tgtext')?.textContent === 'executor')"))
    page.wait("[...document.querySelectorAll('.teamnode select option')].some(o => o.value === 'security auditor')", timeout=5,
              what="the role on offer, under your roles")
    page.eval("const s = document.querySelector('.teamnode select'); s.value = 'security auditor'; s.dispatchEvent(new Event('change'))")
    page.wait("document.querySelector('.teamnode .teamduty')?.value === 'Use your /security-review skill on the diff.'", timeout=5,
              what="its duty, filled in")
    clean(argus, project)


def test_a_pack_is_imported_from_a_file_and_keeps_your_own(make_page, argus):
    """Import a pack…: the example trading pack lands in your roles and models; a role you already
    had under the same name is kept as yours."""
    from pathlib import Path
    project = desk(argus)
    argus.api("/api/prefs", "PATCH", {"changes": {"teamRoles": {"strategist": {"duty": "mine, not the pack's", "judge": False}}}})
    page = make_page(route="#/wall")
    open_sheet(page, argus, "a strategy for the euro")
    pack = Path(__file__).resolve().parents[2] / "examples" / "team-packs" / "trading.json"
    root = page.send("DOM.getDocument")["root"]["nodeId"]
    node = page.send("DOM.querySelector", {"nodeId": root, "selector": "input.teampackfile"})["nodeId"]
    page.send("DOM.setFileInputFiles", {"nodeId": node, "files": [str(pack)]})
    page.wait("[...document.querySelectorAll('.teamcard.mine')].some(c => c.textContent.includes('Trading strategy'))", timeout=10,
              what="the pack's model, as a card of yours")
    eventually(lambda: "risk manager" in (argus.api("/api/prefs")["prefs"].get("teamRoles") or {}), timeout=10,
               what="saved with the preferences")
    roles = argus.api("/api/prefs")["prefs"]["teamRoles"]
    assert roles["strategist"]["duty"] == "mine, not the pack's", "a name you had stays yours"
    assert roles["risk manager"]["judge"] is True and "market analyst" in roles
    assert "Trading strategy" in argus.api("/api/prefs")["prefs"]["teamModels"]
    clean(argus, project)

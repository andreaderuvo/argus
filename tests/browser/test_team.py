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


def more(page):
    """Open "More" in the sheet, where the files and packs are."""
    page.eval("document.querySelector('.teamadvanced').open = true")


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
    # The graph is in the team's own window, opened with the team.
    page.wait("[...document.querySelectorAll('.win[data-kind=\"team\"] .tgnode')].some(n => n.textContent.startsWith('executor') && (n.classList.contains('running') || n.classList.contains('waiting')))",
              timeout=10, what="the executor's step, live")
    team = argus.api("/api/teams")["teams"][0]
    assert team["template"] == "fix" and team["ws"] == 1
    assert next(n for n in team["nodes"] if n["id"] == "check")["command"] == "test -f fixed"
    assert (project / "TEAM.argus.md").exists()

    # Stop is one press, and a stopped team can be forgotten.
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.textContent === 'Stop')"))
    # It asks whether to end the team's sessions too; ticked, they go.
    page.wait("!!document.querySelector('.confirmcheck')", timeout=5, what="the question")
    assert "Fix-a-bug-executor" in page.eval("document.querySelector('.confirmcheck').textContent")
    page.click_at(*page._center("document.querySelector('.confirmcheck input')"))
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Stop')"))
    eventually(lambda: argus.api("/api/teams")["teams"][0]["status"] == "stopped", timeout=10, what="the team to stop")
    eventually(lambda: not any(s.startswith("Fix-a-bug-") for s in argus.sessions()), timeout=10, what="its sessions ended")
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


def test_the_projects_team_yaml_is_offered_and_starts(make_page, argus):
    """A team.yaml in the folder becomes a card in the sheet, its picture drawn, ready to start."""
    project = desk(argus)
    (project / "team.yaml").write_text(
        "name: Quick fix\nsteps:\n  fixer: {role: executor}\n  tests: {check: 'true', of: fixer}\n"
        "flow:\n  - fixer -> tests\n  - tests -> done if PASS\n  - tests -> fixer if FAIL\n")
    page = make_page(route="#/wall")
    open_sheet(page, argus, "fix the thing")
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Quick fix')", timeout=10,
              what="the project's own team, chosen")
    page.wait("[...document.querySelectorAll('.teampicture .tgtext')].map(t => t.textContent).join(',') === 'fixer,tests,done'",
              timeout=5, what="its picture")
    page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent for the step")
    start(page)
    team = argus.api("/api/teams")["teams"][0]
    assert [n["id"] for n in team["nodes"]] == ["fixer", "tests", "end"] and team["template"] == "custom"
    (project / "team.yaml").unlink()
    clean(argus, project)


def test_an_example_pack_is_one_press_away(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "a strategy")
    more(page)
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Examples…')"))
    page.wait("!!document.querySelector('.teamexample')", timeout=10, what="the examples")
    page.click_at(*page._center("[...document.querySelectorAll('.teamexample')].find(b => b.textContent.includes('Trading research'))"))
    page.wait("[...document.querySelectorAll('.teamcard.mine')].some(c => c.textContent.includes('Trading strategy'))", timeout=10,
              what="its model, as a card of yours")
    clean(argus, project)


def test_badges_say_where_a_team_comes_from_and_yours_can_go(make_page, argus):
    """Argus's own, yours, a pack's: said on the card. A pack is taken back whole by Remove a pack…;
    a model of yours by its ✕."""
    project = desk(argus)
    argus.api("/api/prefs", "PATCH", {"changes": {"teamModels": {"hand made": {
        "nodes": [{"id": "a", "kind": "agent", "role": "executor"}, {"id": "end", "kind": "end"}],
        "edges": [{"from": "a", "to": "end", "when": "DONE"}], "start": ["a"]}}}})
    page = make_page(route="#/wall")
    open_sheet(page, argus, "a strategy")
    badge = lambda name: f"[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === '{name}')?.querySelector('.teambadge')?.textContent"
    page.wait(f"{badge('Optimise')} === 'Argus'", timeout=10, what="a template says Argus")
    page.wait(f"{badge('hand made')} === 'yours'", timeout=5, what="yours says yours")
    more(page)
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Examples…')"))
    page.wait("!!document.querySelector('.teamexample')", timeout=10, what="the examples")
    page.click_at(*page._center("[...document.querySelectorAll('.teamexample')].find(b => b.textContent.includes('Security review'))"))
    page.wait(f"{badge('Security review')} === 'Security review'", timeout=10, what="a pack's model says its pack")
    # The pack goes back out whole.
    more(page)
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Remove a pack…')"))
    page.wait("[...document.querySelectorAll('.teamexample')].some(b => b.textContent.includes('Security review'))", timeout=5, what="the pack, listed")
    page.click_at(*page._center("[...document.querySelectorAll('.teamexample')].find(b => b.textContent.includes('Security review'))"))
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Remove')"))
    page.wait(f"{badge('Security review')} === undefined", timeout=5, what="its model gone")
    eventually(lambda: "security auditor" not in (argus.api("/api/prefs")["prefs"].get("teamRoles") or {}), timeout=10,
               what="and its roles")
    # Yours goes by its ✕.
    page.click_at(*page._center("[...document.querySelectorAll('.teamcard')].find(c => c.textContent.includes('hand made')).querySelector('.teamcardx')"))
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Forget')"))
    eventually(lambda: "hand made" not in (argus.api("/api/prefs")["prefs"].get("teamModels") or {}), timeout=10, what="forgotten")
    clean(argus, project)


def test_the_folder_is_required_and_a_pack_brings_its_goal(make_page, argus):
    """No folder, no start: a team's folder is chosen, never defaulted to your home. And a model
    that carries a goal fills the box when it is empty — never over words you typed."""
    argus.kill_sessions()
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [{"id": 1, "name": "Work", "desktop": []}]}})
    page = make_page(route="#/wall")
    page.click_at(*page._center("[...document.querySelectorAll('#walltools button')].find(b => b.textContent.trim() === 'Team')"))
    page.wait("!!document.querySelector('.teamcard')", timeout=20, what="the sheet")
    assert page.eval("document.querySelector('.startpath').value") == "", "a desk with no folder suggests none"
    start_button = "[...document.querySelectorAll('.sheetfoot button')].find(b => b.textContent === 'Start the team')"
    assert page.eval(f"{start_button}.disabled") is True, "no folder, no start"
    page.eval("const w = document.querySelector('.startpath'); w.value = '~/work/x'; w.dispatchEvent(new Event('input'))")
    assert page.eval(f"{start_button}.disabled") is False
    more(page)
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Examples…')"))
    page.wait("!!document.querySelector('.teamexample')", timeout=10, what="the examples")
    page.click_at(*page._center("[...document.querySelectorAll('.teamexample')].find(b => b.textContent.includes('Security review'))"))
    page.wait("[...document.querySelectorAll('.teamcard')].some(c => c.querySelector('.name')?.textContent === 'Security review' && c.querySelector('.teambadge').textContent === 'Security review')",
              timeout=10, what="the pack's card")
    page.click_at(*page._center("[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === 'Security review' && c.querySelector('.teambadge').textContent === 'Security review')"))
    page.wait("document.querySelector('.teamgoal').value.startsWith('Review the code in this folder')", timeout=5,
              what="its goal, in the empty box")
    page.eval("const g = document.querySelector('.teamgoal'); g.value = 'my own words'; g.dispatchEvent(new Event('input'))")
    page.click_at(*page._center("[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === 'Optimise')"))
    page.click_at(*page._center("[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === 'Security review' && c.querySelector('.teambadge').textContent === 'Security review')"))
    assert page.eval("document.querySelector('.teamgoal').value") == "my own words", "never over what you typed"


def test_the_folder_is_guided_and_the_team_can_be_edited_as_text(make_page, argus):
    project = desk(argus)
    (project / "alpha").mkdir(exist_ok=True)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "fix the crash")
    place = "document.querySelector('.teamplace').className"
    start_button = "[...document.querySelectorAll('.sheetfoot button')].find(b => b.textContent === 'Start the team')"
    setp = lambda v: page.eval(f"(() => {{ const w = document.querySelector('.startpath'); w.value = {v!r}; w.dispatchEvent(new Event('input')); }})()")
    setp("/etc/argus-nowhere")
    page.wait(f"{place}.includes('outside')", timeout=5, what="outside, said under the box")
    assert page.eval(f"{start_button}.disabled") is True, "and Start off"
    setp(str(project / "brand-new"))
    page.wait(f"{place}.includes('new')", timeout=5, what="to be made")
    setp(str(project))
    page.wait(f"{place}.includes('exists')", timeout=5, what="there")
    # Choose…: walk into alpha, use it.
    page.click_at(*page._center("[...document.querySelectorAll('button')].find(b => b.textContent === 'Choose…')"))
    page.wait("[...document.querySelectorAll('.folderlist button')].some(b => b.textContent === 'alpha/')", timeout=10, what="the folders")
    page.click_at(*page._center("[...document.querySelectorAll('.folderlist button')].find(b => b.textContent === 'alpha/')"))
    page.wait("document.querySelector('.folderat')?.textContent.endsWith('/alpha')", timeout=5, what="inside alpha")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Use this folder')"))
    page.wait(f"document.querySelector('.startpath').value === {str(project / 'alpha')!r}", timeout=5, what="the box filled")
    # Edit as text: rename the executor, apply, see it drawn.
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Edit as text')"))
    page.wait("!!document.querySelector('.teamyaml')", timeout=10, what="the YAML")
    page.eval("(() => { const y = document.querySelector('.teamyaml'); y.value = y.value.replaceAll('executor', 'fixer'); })()")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Apply')"))
    page.wait("[...document.querySelectorAll('.teampicture .tgtext')].some(t => t.textContent === 'fixer')", timeout=5, what="the edit, drawn")
    clean(argus, project)


def test_a_pack_may_suggest_everything_and_the_sheet_says_so_in_red(make_page, argus, tmp_path):
    import json as _json
    project = desk(argus)
    pack = tmp_path / "p.json"
    g = {"nodes": [{"id": "a", "kind": "agent", "role": "executor"}, {"id": "end", "kind": "end"}],
         "edges": [{"from": "a", "to": "end", "when": "DONE"}], "start": ["a"], "permissions": "everything"}
    pack.write_text(_json.dumps({"argus_team_pack": 1, "name": "bold", "models": {"bold one": g}}))
    page = make_page(route="#/wall")
    open_sheet(page, argus, "go")
    root = page.send("DOM.getDocument")["root"]["nodeId"]
    node = page.send("DOM.querySelector", {"nodeId": root, "selector": "input.teampackfile"})["nodeId"]
    page.send("DOM.setFileInputFiles", {"nodeId": node, "files": [str(pack)]})
    card = "[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === 'bold one')"
    page.wait(f"!!{card}", timeout=10, what="its card")
    assert page.eval("document.querySelector('.teamdanger').hidden") is True, "not before it is chosen"
    page.click_at(*page._center(card))
    page.wait("[...document.querySelectorAll('select.setpick')].some(s => s.value === 'everything')", timeout=5, what="the choice made")
    page.wait("document.querySelector('.teamdanger').hidden === false", timeout=5, what="and said in red")
    clean(argus, project)


def test_the_team_line_survives_the_desk_being_put_back(make_page, argus):
    """Opening a team's Log redrew the desk, and the team line was not among the parts put back."""
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "fix the crash")
    page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent")
    page.eval("(() => { const c = document.querySelector('.teamcheck input'); c.value = 'true'; c.dispatchEvent(new Event('input')); })()")
    start(page)
    page.wait("!!document.querySelector('.win[data-kind=\"team\"] .teamwin svg')", timeout=10, what="the team's window, with its graph")
    page.click_at(*page._center("[...document.querySelectorAll('.teamline button')].find(b => b.textContent === 'Log')"))
    page.wait("!!document.querySelector('.win[data-kind=\"file\"]')", timeout=8, what="the log, opened beside")
    page.wait("!!document.querySelector('#view .teamstrip .teamline') && !!document.querySelector('#view .teamwin svg')", timeout=8, what="line and window still there after the Log")
    page.eval("location.hash = '#/sessions'")
    page.wait("!document.querySelector('#view .teamstrip')", timeout=5)
    page.eval("location.hash = '#/wall'")
    page.wait("!!document.querySelector('#view .teamstrip .teamline') && !!document.querySelector('#view .teamwin svg')", timeout=8, what="and back from another screen")
    clean(argus, project)


def test_the_team_window_keeps_your_place_and_puts_the_newest_first(make_page, argus):
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "fix the crash")
    page.wait("!!document.querySelector('.teamrole select')", timeout=25, what="an agent")
    page.eval("(() => { const c = document.querySelector('.teamcheck input'); c.value = 'true'; c.dispatchEvent(new Event('input')); })()")
    start(page)
    page.wait("document.querySelectorAll('.teamwin .teamstory li').length >= 2", timeout=10, what="the story")
    first = page.eval("document.querySelector('.teamwin .teamstory li').textContent")
    last = page.eval("[...document.querySelectorAll('.teamwin .teamstory li')].pop().textContent")
    assert "turn" in first and "started from" in last, "the newest on top"
    # In a tall window the story takes the room under the graph (it was held to 12rem).
    page.eval("(() => { const b = document.querySelector('.teamwin'); b.style.height = '760px'; b.style.flex = 'none'; })()")
    page.wait("""(() => { const b = document.querySelector('.teamwin').getBoundingClientRect();
      const s = document.querySelector('.teamwin .teamstory').getBoundingClientRect();
      return s.height > 230 && b.bottom - s.bottom < 24; })()""", timeout=5, what="the story filling the window")
    # Scrolled down, it stays where it is across the window's refreshes.
    page.eval("(() => { const b = document.querySelector('.teamwin'); b.style.height = '120px'; b.style.flex = 'none'; })()")
    page.wait("(() => { const b = document.querySelector('.teamwin'); return b.scrollHeight > b.clientHeight + 40; })()", timeout=5,
              what="a window short enough to scroll")
    page.eval("document.querySelector('.teamwin').scrollTop = 40")
    at = page.eval("document.querySelector('.teamwin').scrollTop")
    assert at > 0, page.eval("(() => { const b = document.querySelector('.teamwin'); return [b.scrollHeight, b.clientHeight, getComputedStyle(b).overflowY]; })()")
    import time
    time.sleep(7)
    assert page.eval("document.querySelector('.teamwin').scrollTop") == at, "not thrown back to the top"
    clean(argus, project)


def test_a_team_drawn_in_mermaid_is_previewed_while_typed(make_page, argus):
    """Edit as text opens on the diagram; what is typed is drawn beside it before Apply, a wrong line
    is named, and Apply puts it in the picture. The sheet keeps the rarely changed under "More"."""
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "make it faster")
    assert page.eval("document.querySelector('.teamadvanced').open") is False, "More is folded"
    assert page.eval("document.querySelectorAll('.teamcard.teammore').length") == 1, "the other shapes one press away"
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Edit as text')"))
    page.wait("document.querySelector('.teamyaml')?.value.startsWith('flowchart')", timeout=10, what="the diagram")
    page.wait("!!document.querySelector('.teampreview svg')", timeout=10, what="drawn beside it")
    typed = "flowchart LR\\n  scout[\\\"scout\\\"] --> boss[\\\"boss · judges\\\"]\\n  boss -->|DONE| done\\n"
    page.eval(f"(() => {{ const y = document.querySelector('.teamyaml'); y.value = \"{typed}\"; y.dispatchEvent(new Event('input')); }})()")
    page.wait("[...document.querySelectorAll('.teampreview .tgtext')].some(t => t.textContent === 'scout')", timeout=5, what="the new step, previewed")
    page.eval("(() => { const y = document.querySelector('.teamyaml'); y.value += '  boss -->|MAYBE| scout\\n'; y.dispatchEvent(new Event('input')); })()")
    page.wait("[...document.querySelectorAll('dialog.sheet .error')].some(e => !e.hidden && e.textContent.includes('line 4'))", timeout=5, what="the wrong line, named")
    page.eval("(() => { const y = document.querySelector('.teamyaml'); y.value = y.value.replace('MAYBE', 'REDO'); y.dispatchEvent(new Event('input')); })()")
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Apply')"))
    page.wait("[...document.querySelectorAll('.teampicture:not(.teampreview) .tgtext')].some(t => t.textContent === 'scout')", timeout=5, what="applied to the picture")
    clean(argus, project)


def test_the_teams_can_be_filtered(make_page, argus):
    """Typing in the filter shows every card that matches — a template hidden behind "more…" too —
    by name or by a role in it; nothing matching says so; Esc clears it."""
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "anything")
    names = "[...document.querySelectorAll('.teamcard:not(.teammore) .name')].map(n => n.textContent)"
    find = lambda q: page.eval(f"(() => {{ const f = document.querySelector('.teamfind'); f.value = {q!r}; f.dispatchEvent(new Event('input')); }})()")
    find("tourn")
    page.wait(f"JSON.stringify({names}) === JSON.stringify(['Tournament'])", timeout=5, what="a hidden template, found by name")
    find("critic")
    page.wait(f"JSON.stringify({names}) === JSON.stringify(['Write'])", timeout=5, what="found by a role in it")
    find("zzz-nothing")
    page.wait("!!document.querySelector('.teamnone') && document.querySelectorAll('.teamcard').length === 0", timeout=5, what="none, said")
    page.click_at(*page._center("document.querySelector('.teamfind')"))
    page.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Escape", "code": "Escape", "windowsVirtualKeyCode": 27})
    page.wait("document.querySelector('.teamfind').value === '' && !!document.querySelector('.teamcard.teammore')", timeout=5, what="cleared")
    assert page.eval("!!document.querySelector('dialog.sheet[open]')"), "and the sheet still open"
    clean(argus, project)


def test_an_old_pair_left_on_a_desk_can_be_hidden(make_page, argus):
    """A PLAN/BRIDGE.argus.md left by the old Two agents kept its note ("together · blocked") on the
    desk for ever. Hide takes it off until either file is written again; the files stay."""
    project = desk(argus)
    (project / "PLAN.argus.md").write_text("# Plan\n\n- builds: a\n- reviews: b\n")
    (project / "BRIDGE.argus.md").write_text("## WORKER: BLOCKED\nneed the credentials\n")
    page = make_page(route="#/wall")
    page.wait("!document.querySelector('.pairnote').hidden", timeout=15, what="the old pair's note")
    page.click_at(*page._center("document.querySelector('.pairnote')"))
    page.click_at(*page._center("[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Hide')"))
    page.wait("document.querySelector('.pairnote').hidden", timeout=5, what="hidden")
    eventually(lambda: (argus.api("/api/prefs")["prefs"].get("pairHidden") or {}).get(str(project)), timeout=10, what="remembered")
    assert (project / "PLAN.argus.md").exists() and (project / "BRIDGE.argus.md").exists(), "the files stay"
    page.eval("location.reload()")
    page.wait("!!document.querySelector('.pairnote')", timeout=15)
    time.sleep(1.5)
    assert page.eval("document.querySelector('.pairnote').hidden") is True, "still hidden after a reload"
    (project / "PLAN.argus.md").unlink()
    (project / "BRIDGE.argus.md").unlink()


def test_a_team_proposed_by_an_agent_opens_from_its_bell(make_page, argus):
    """An agent writes a team and proposes it: the bell's toast, tapped — from another screen —
    opens Team on that folder with the proposed team chosen and its goal filled. Nothing started."""
    project = desk(argus)
    folder = project / "proposed"
    folder.mkdir(exist_ok=True)
    page = make_page(route="#/files")
    page.wait("!!document.querySelector('#nav')", timeout=10)
    time.sleep(1.0)                        # the bell stream is listening
    text = ("%% name: Bench it\n%% goal: make the parser faster\nflowchart LR\n"
            "  a[\"executor\"] --> c{{\"true\"}}\n  c -->|PASS| r[\"reviewer · judges\"]\n"
            "  c -->|FAIL| a\n  r -->|OK, REDO| a\n  r -->|DONE| done\n")
    argus.api("/api/teams/propose", "POST", {"text": text, "folder": str(folder), "session": ""})
    toast = "[...document.querySelectorAll('.toast.tappable')].find(t => t.textContent.includes('Bench it'))"
    page.wait(f"!!{toast}", timeout=10, what="the bell, as a toast")
    page.click_at(*page._center(toast))
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Bench it')", timeout=20, what="Team, with the proposal chosen")
    assert page.eval("document.querySelector('.startpath').value") == str(folder)
    assert page.eval("document.querySelector('.teamgoal').value") == "make the parser faster"
    assert argus.api("/api/teams")["teams"] == [], "proposed, not started"
    page.eval("document.querySelector('dialog.sheet')?.close()")
    (folder / "team.yaml").unlink()


def test_a_missed_proposal_waits_over_the_desk_and_as_a_card(make_page, argus):
    """The bell missed: the proposal is still over the desk, with Open and Dismiss, and a card in
    Team whatever folder the box holds. Picking the card moves the folder to the proposal's."""
    project = desk(argus)
    folder = project / "elsewhere"
    folder.mkdir(exist_ok=True)
    text = "%% name: Missed one\n%% goal: find it again\nflowchart LR\n  a[\"executor\"] --> c{{\"true\"}}\n  c -->|PASS| done\n  c -->|FAIL| a\n"
    argus.api("/api/teams/propose", "POST", {"text": text, "folder": str(folder), "session": "claude-x"})
    page = make_page(route="#/wall")
    line = "[...document.querySelectorAll('.teamproposal')].find(l => l.textContent.includes('Missed one'))"
    page.wait(f"!!{line}", timeout=15, what="the proposal, over the desk")
    assert "claude-x" in page.eval(f"{line}.textContent")
    # As a card, with the desk's own folder in the box.
    open_sheet(page, argus, "")
    card = "[...document.querySelectorAll('.teamcard')].find(c => c.querySelector('.name')?.textContent === 'Missed one')"
    page.wait(f"!!{card}", timeout=10, what="its card")
    assert page.eval(f"{card}.querySelector('.teambadge').textContent") == "proposed"
    page.click_at(*page._center(card))
    page.wait(f"document.querySelector('.startpath').value === {str(folder)!r}", timeout=5, what="the folder, the proposal's")
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Missed one')", timeout=5, what="chosen")
    page.eval("document.querySelector('dialog.sheet').close()")
    # Dismissed from the line: gone from the list, the file still there.
    page.click_at(*page._center(f"[...{line}.querySelectorAll('button')].find(b => b.textContent === 'Dismiss')"))
    page.wait("!document.querySelector('.teamproposal')", timeout=10, what="dismissed")
    assert (folder / "team.yaml").exists()
    (folder / "team.yaml").unlink()


def test_a_team_started_on_request_lands_in_the_desk_asked_for(make_page, argus):
    """"Start the Build and review team in the desk Work": an agent requests it, the person taps Do
    it, and the team's window and its agents' windows are on that desk."""
    project = desk(argus)
    page = make_page(route="#/wall")
    page.wait("!!document.querySelector('#walltools')", timeout=10)
    req = argus.api("/api/agent/request", "POST", {"action": "start_team", "args": {
        "team": "Build and review", "folder": str(project), "goal": "tidy the notes", "desk": "Work"},
        "why": "you asked for it", "session": ""})
    assert req["state"] == "asked" and "in the desk Work" in req["text"]
    argus.api(f"/api/ask/{req['question']}/answer", "POST", {"answer": "Do it"})
    eventually(lambda: argus.api(f"/api/agent/request/{req['id']}?wait=2")["state"] in ("done", "failed"), timeout=60, what="done")
    said = argus.api(f"/api/agent/request/{req['id']}")
    assert said["state"] == "done", said
    page.wait("!!document.querySelector('.win[data-kind=\"team\"]')", timeout=15, what="the team's window, on the desk")
    page.wait("!!document.querySelector('.win[data-session=\"Build-and-review-executor\"]')", timeout=15, what="its first agent's window")
    clean(argus, project)


def test_an_agents_request_waits_in_the_corner_until_answered(make_page, argus):
    """A request for your OK is a card in the bottom-right corner, on any screen, with Do it and No;
    it does not fade, comes back after a reload, and leaves once answered."""
    argus.api("/api/todo", "POST", {"note": "drop me"})
    n = argus.api("/api/todo")["items"][0]["n"]
    page = make_page(route="#/files")
    req = argus.api("/api/agent/request", "POST", {"action": "todo_delete", "args": {"todo": n}, "session": "claude-x"})
    card = "[...document.querySelectorAll('#toasts .askcard')].find(c => c.textContent.includes('claude-x'))"
    page.wait(f"!!{card}", timeout=15, what="the request, in the corner")
    time.sleep(4)
    assert page.eval(f"!!{card}"), "it does not fade like a toast"
    page.eval("window.__old = true; location.reload()")
    page.wait("!window.__old", timeout=15, what="the page reloaded")
    page.wait(f"!!{card}", timeout=15, what="and is back after a reload")
    page.click_at(*page._center(f"[...{card}.querySelectorAll('button')].find(b => b.textContent === 'Do it')"))
    eventually(lambda: argus.api(f"/api/agent/request/{req['id']}?wait=2")["state"] == "done", timeout=15, what="done")
    assert argus.api("/api/todo")["items"] == []
    page.wait("!document.querySelector('#toasts .askcard')", timeout=10, what="and gone once answered")

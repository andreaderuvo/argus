"""The team editor, in a real browser: a team.yaml opened from the files, its problems underlined
on their lines and listed, a fix that fixes, completion from the schema, the graph that finds a
step's line, Save that asks once more while errors are left; and the same editor in Team's
"Edit as text", whose Apply waits for a team that reads."""

from __future__ import annotations

import json
import time

GOOD = """name: Fix it
steps:
  fixer: {role: executor}
  tests: {check: pytest -q, of: fixer}
flow:
  - fixer -> tests
  - tests -> done if PASS
  - tests -> fixer if FAIL
"""


def open_editor(make_page, argus, text):
    folder = argus.root / "home" / "teamed"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "team.yaml"
    path.write_text(text)
    page = make_page(route=f"#/preview?path={path}")
    page.wait("document.querySelector('#hdr-action') && !document.querySelector('#hdr-action').hidden || "
              "[...document.querySelectorAll('button')].some(b => b.title === 'Edit this file')", timeout=10, what="the edit button")
    page.click_at(*page._center("[...document.querySelectorAll('button')].find(b => b.title === 'Edit this file')"))
    page.wait("!!document.querySelector('.teamfileedit .teinput')", timeout=10, what="the team editor, not the plain one")
    return page, path


def set_caret(page, offset):
    page.eval(f"(() => {{ const i = document.querySelector('.teinput'); i.focus(); i.setSelectionRange({offset}, {offset}); }})()")


def test_a_team_file_is_edited_with_its_problems_on_their_lines(make_page, argus):
    page, path = open_editor(make_page, argus, GOOD.replace("  - fixer -> tests", "  - fixr -> tests"))
    page.wait("document.querySelector('.testatus')?.classList.contains('bad')", timeout=10, what="the error found")
    # On its line: the gutter marks line 6, the word is underlined, the list says it.
    assert page.eval("document.querySelectorAll('.teln')[5].classList.contains('error')")
    assert page.eval("document.querySelector('.tehl .sq-error')?.textContent") == "fixr"
    row = "document.querySelector('.teproblem.error')"
    assert "did you mean `fixer`" in page.eval(f"{row}.textContent")
    assert page.eval("document.querySelector('.teamfilegraph').classList.contains('stale')"), "the picture says it is old"
    # The fix fixes, and the picture comes back.
    page.click_at(*page._center(f"{row}.querySelector('.tefix')"))
    page.wait("document.querySelector('.testatus')?.classList.contains('good')", timeout=10, what="no problems after the fix")
    assert "- fixer -> tests" in page.eval("document.querySelector('.teinput').value")
    page.wait("!!document.querySelector('.teamfilegraph svg') && !document.querySelector('.teamfilegraph').classList.contains('stale')", timeout=5)
    # A click on a step in the graph puts the cursor on its line.
    page.click_at(*page._center("[...document.querySelectorAll('.teamfilegraph .tgnode')].find(g => g.textContent.includes('tests'))"))
    line = page.eval("(() => { const i = document.querySelector('.teinput'); return i.value.slice(0, i.selectionStart).split('\\n').length; })()")
    assert line == 4, line
    # Completion: a new key in a step, from the schema.
    value = page.eval("document.querySelector('.teinput').value")
    set_caret(page, value.index("{role: executor") + len("{role: executor"))
    page.type(", wor")
    page.wait("!document.querySelector('.tecomplete').hidden", timeout=5, what="the completion list")
    assert "worktree" in page.eval("document.querySelector('.tecomplete .teitem.on').textContent")
    page.key("Enter")
    page.type("t")
    page.wait("!document.querySelector('.tecomplete').hidden && document.querySelector('.tecomplete').textContent.includes('true')", timeout=5,
              what="true/false offered for worktree")
    page.key("Enter")
    page.wait("document.querySelector('.teinput').value.includes('{role: executor, worktree: true}')", timeout=5)
    # Saved with Ctrl+S.
    page.wait("document.querySelector('.testatus')?.classList.contains('good')", timeout=10)
    page.key("s", modifiers=2)
    deadline = time.time() + 10
    while "worktree: true" not in path.read_text() and time.time() < deadline:
        time.sleep(0.2)
    assert "fixer: {role: executor, worktree: true}" in path.read_text()


def test_saving_with_errors_asks_once_more(make_page, argus):
    page, path = open_editor(make_page, argus, GOOD)
    page.wait("document.querySelector('.testatus')?.classList.contains('good')", timeout=10)
    value = page.eval("document.querySelector('.teinput').value")
    set_caret(page, value.index("done if PASS") + len("done if "))
    page.type("X")
    page.wait("document.querySelector('.testatus')?.classList.contains('bad')", timeout=10, what="XPASS refused")
    save = "[...document.querySelectorAll('.teamfileedit .editbar button')].find(b => /Save/.test(b.textContent))"
    page.click_at(*page._center(save))
    page.wait(f"{save}.textContent === 'Save anyway'", timeout=5, what="asked once more")
    assert "XPASS" not in path.read_text(), "nothing written on the first press"
    assert "Argus will not start it" in page.text(".teamfileedit .editnote")
    page.click_at(*page._center(save))
    deadline = time.time() + 10
    while "XPASS" not in path.read_text() and time.time() < deadline:
        time.sleep(0.2)
    assert "XPASS" in path.read_text(), "kept as written, when asked twice"


def test_edit_as_text_in_team_waits_for_a_team_that_reads(make_page, argus):
    from tests.browser.test_team import clean, desk, open_sheet
    project = desk(argus)
    page = make_page(route="#/wall")
    open_sheet(page, argus, "tidy it")
    page.click_at(*page._center("[...document.querySelectorAll('.teampackbtns button')].find(b => b.textContent === 'Edit as text')"))
    page.wait("!!document.querySelector('.teamtext .teinput')", timeout=20, what="the editor in the sheet")
    page.wait("document.querySelector('.teamtext .testatus')?.classList.contains('good')", timeout=10)
    apply = "[...document.querySelectorAll('dialog.sheet button')].find(b => b.textContent === 'Apply')"
    assert not page.eval(f"{apply}.disabled")
    page.eval("(() => { const i = document.querySelector('.teamtext .teinput'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()")
    page.type("\n  nobody -->|MAYBE| done")
    page.wait("document.querySelector('.teamtext .testatus')?.classList.contains('bad')", timeout=10)
    assert page.eval(f"{apply}.disabled"), "Apply waits for a team that reads"
    assert page.eval("document.querySelector('.teamtext .teproblem.error .teline-n').textContent").startswith("line ")
    page.key("Backspace")
    for _ in range(len("\n  nobody -->|MAYBE| done") - 1):
        page.key("Backspace")
    page.wait("document.querySelector('.teamtext .testatus')?.classList.contains('good')", timeout=10, what="it reads again")
    assert not page.eval(f"{apply}.disabled"), "Apply back once it reads"
    assert json.loads(page.eval("JSON.stringify(document.querySelectorAll('.teamtext .teproblem.error').length)")) == 0
    clean(argus, project)


def test_a_team_file_read_says_what_it_is_and_opens_in_team(make_page, argus):
    argus.kill_sessions()
    folder = argus.root / "home" / "teamcard"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / "team.yaml"
    path.write_text(GOOD.replace("name: Fix it", "name: Card team"))
    page = make_page(route=f"#/preview?path={path}")
    page.wait("document.querySelector('.teamfilecard .testatus')?.classList.contains('good')", timeout=10, what="the card, checked")
    assert page.eval("!!document.querySelector('.teamfilecard svg.teamgraph')"), "the team drawn"
    assert "1 agent" in page.text(".teamfilecard")
    page.click_at(*page._center("document.querySelector('.teamfilecard .teamfileopen:not(.teamfilesave)')"))
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Card team')", timeout=20, what="Team, on this folder's team")
    path.unlink()


FULL = """name: Paper run
goal: trade on paper
gate: auto
rounds: 7
steps:
  trader: {role: executor, duty: "Trade carefully."}
  check: {check: python3 run.py --check, of: trader}
flow:
  - trader -> check
  - check -> done if PASS
  - check -> trader if FAIL
"""


def test_a_team_yaml_can_be_edited_as_a_diagram_and_is_saved_as_yaml(make_page, argus):
    page, path = open_editor(make_page, argus, FULL)
    page.wait("document.querySelector('.testatus')?.classList.contains('good')", timeout=10)
    page.click_at(*page._center("[...document.querySelectorAll('.teamfiletabs button')].find(b => b.textContent.startsWith('Diagram'))"))
    page.wait("document.querySelector('.teinput').value.startsWith('flowchart')", timeout=10, what="the diagram")
    assert "duties, worktrees, gate, rounds and reset are kept" in page.text(".teamfilemode")
    page.eval("(() => { const i = document.querySelector('.teinput'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); })()")
    page.type('  analyst["researcher"] --> trader\n')
    page.wait("[...document.querySelectorAll('.teamfilegraph .tgtext')].some(x => x.textContent === 'analyst')", timeout=10, what="the new step, drawn")
    page.key("s", modifiers=2)
    deadline = time.time() + 10
    while "analyst" not in path.read_text() and time.time() < deadline:
        time.sleep(0.2)
    saved = path.read_text()
    assert not saved.startswith("flowchart") and "analyst:" in saved, saved
    assert "Trade carefully." in saved and "rounds: 7" in saved and "gate: auto" in saved, "nothing the diagram cannot say was lost"


def test_a_diagram_file_becomes_the_folders_team(make_page, argus):
    argus.kill_sessions()
    folder = argus.root / "home" / "drawn"
    folder.mkdir(parents=True, exist_ok=True)
    team = folder / "team.yaml"
    team.unlink(missing_ok=True)
    mmd = folder / "flow.mmd"
    mmd.write_text("flowchart LR\n  %% name: Drawn team\n  fixer[executor] --> tests{{pytest -q}}\n  tests -->|PASS| done\n  tests -->|FAIL| fixer\n")
    page = make_page(route=f"#/preview?path={mmd}")
    page.wait("document.querySelector('.teamfilecard .testatus')?.classList.contains('good')", timeout=10, what="a team, drawn")
    assert "A team, drawn" in page.text(".teamfilecard")
    page.click_at(*page._center("[...document.querySelectorAll('.teamfilecard button')].find(b => b.textContent.includes('Save as team.yaml'))"))
    deadline = time.time() + 10
    while not team.exists() and time.time() < deadline:
        time.sleep(0.2)
    assert "fixer:" in team.read_text() and "name: Drawn team" in team.read_text()
    page.wait("[...document.querySelectorAll('.teamfilecard button')].some(b => b.textContent.includes('Open in Team') && !b.hidden)", timeout=5)
    # Again, over a team.yaml with a duty: asked once, then replaced keeping the duty.
    team.write_text(team.read_text().replace("role: executor", "role: executor\n    duty: Mind the edge cases."))
    page.eval("location.reload()")
    page.wait("document.querySelector('.teamfilecard .testatus')?.classList.contains('good')", timeout=15)
    save = "[...document.querySelectorAll('.teamfilecard button')].find(b => /team\\.yaml/.test(b.textContent))"
    page.click_at(*page._center(save))
    page.wait(f"{save}.textContent.includes('Replace')", timeout=5, what="asked before replacing")
    page.click_at(*page._center(save))
    deadline = time.time() + 10
    page.wait("[...document.querySelectorAll('.teamfilecard button')].some(b => b.textContent.includes('Open in Team') && b.getClientRects().length)",
              timeout=10, what="replaced, and Open in Team offered")
    assert "Mind the edge cases." in team.read_text(), "the duty kept from the team.yaml it replaced"
    page.click_at(*page._center("[...document.querySelectorAll('.teamfilecard button')].find(b => b.textContent.includes('Open in Team'))"))
    page.wait("document.querySelector('.teamcard.on')?.textContent.includes('Drawn team')", timeout=20, what="Team, on the folder's new team")
    team.unlink()

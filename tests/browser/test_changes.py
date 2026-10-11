"""What changed in a repository, as a window beside a session and as a screen (static/js/changes.js).

The patch is drawn by the diff viewer pack, in its sandboxed frame; what the frame shows is read
from inside it (`frame_eval`). Nothing here writes to the repository but the test itself."""

from __future__ import annotations

import subprocess

from .test_flows import eventually

DRAWN = """new Promise((ok) => { const t0 = Date.now(); (function look() {
  const names = [...document.querySelectorAll('.d2h-file-name')].map((n) => n.textContent.trim());
  if (names.length || Date.now() - t0 > 8000) ok(names); else setTimeout(look, 100); })(); })"""


def make_repo(argus):
    repo = argus.root / "proj"
    if repo.exists():
        subprocess.run(["rm", "-rf", str(repo)], check=True)
    repo.mkdir()
    g = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True)
    g("init", "-q", "-b", "main")
    g("config", "user.email", "a@b")
    g("config", "user.name", "a")
    (repo / "score.py").write_text("def score(x):\n    return x\n")
    g("add", ".")
    g("commit", "-qm", "first")
    g("branch", "other")
    (repo / "score.py").write_text("def score(x, k=2):\n    return x * k\n")
    return repo


def test_the_screen_shows_the_patch_and_follows_new_files(make_page, argus):
    repo = make_repo(argus)
    page = make_page(route=f"#/changes?path={repo}")
    page.wait("!!document.querySelector('.changes iframe.packframe')", timeout=10, what="the diff in its frame")
    assert page.frame_eval("/viewers/diff/", DRAWN, timeout=15) == ["score.py"]
    assert page.text(".chsum").startswith("main · since "), page.text(".chsum")
    (repo / "added.py").write_text("print('hi')\n")
    eventually(lambda: "added.py" in (page.frame_eval("/viewers/diff/", DRAWN, timeout=15) or []),
               timeout=20, what="a file written by someone else shows up by itself")
    # The last commit, and the other branch.
    page.click_text("Last commit", within=".chseg button")
    eventually(lambda: "first" in page.text(".chsum"), timeout=10, what="the last commit's subject")
    page.click_text("Against", within=".chseg button")
    page.wait("!document.querySelector('.chref').hidden && document.querySelector('.chref').value === 'other'", timeout=10)


def test_a_folder_not_in_a_repository_says_so(make_page, argus):
    plain = argus.root / "docs"
    page = make_page(route=f"#/changes?path={plain}")
    page.wait("document.querySelector('.chempty')?.textContent.includes('not in a git repository')", timeout=10)


def test_a_session_in_a_repository_offers_its_changes_beside_it(make_page, argus):
    repo = make_repo(argus)
    argus.kill_sessions()
    argus.tmux("new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "-c", str(repo))
    argus.tmux("new-session", "-d", "-s", "elsewhere", "-x", "80", "-y", "24", "-c", str(argus.root / "docs"))
    argus.api("/api/prefs", "PATCH", {"changes": {"winFacts": True, "ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "work"}, {"kind": "term", "name": "elsewhere"}]}]}})
    page = make_page(route="#/wall?ws=1")
    btn = "[...document.querySelectorAll('.win[data-session=\"%s\"] .winbtn')].find(b => b.title === 'What changed here (git)')"
    page.wait(f"!!({btn % 'work'}) && !({btn % 'work'}).hidden", timeout=15, what="the button, for a session in a repo")
    # Pressed from script: in a narrow window the title bar tucks it into More.
    assert page.eval(f"!({btn % 'elsewhere'}) || ({btn % 'elsewhere'}).hidden"), "none for a folder outside a repository"
    page.eval(f"({btn % 'work'}).click()")
    page.wait("!!document.querySelector('.win[data-kind=\"changes\"] iframe.packframe')", timeout=10, what="a Changes window")
    assert page.frame_eval("/viewers/diff/", DRAWN, timeout=15) == ["score.py"]
    assert "Changes · proj" in page.text(".win[data-kind=\"changes\"] .wintitle")
    argus.kill_sessions()

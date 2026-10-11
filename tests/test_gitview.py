"""What changed in a repository, read only (app/gitview.py, /api/git/status, /api/git/diff)."""

from __future__ import annotations

import subprocess

import pytest
from fastapi.testclient import TestClient

from app import gitview, viewerpacks
from app.config import Config
from app.main import create_app

TOKEN = "t" * 64
H = {"authorization": f"Bearer {TOKEN}"}


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def repo(tmp_path):
    r = tmp_path / "repo"
    (r / "sub").mkdir(parents=True)
    git(r, "init", "-q", "-b", "main")
    git(r, "config", "user.email", "a@b")
    git(r, "config", "user.name", "a")
    (r / "keep.py").write_text("a = 1\nb = 2\n")
    (r / "gone.txt").write_text("bye\n")
    (r / "old.txt").write_text("".join(f"line {i}\n" for i in range(20)))
    (r / "sub" / "inner.py").write_text("x = 1\n")
    git(r, "add", ".")
    git(r, "commit", "-qm", "first")
    git(r, "branch", "other")
    (r / "keep.py").write_text("a = 1\nb = 3\nc = 4\n")
    (r / "gone.txt").unlink()
    git(r, "mv", "old.txt", "new.txt")
    (r / "fresh.py").write_text("print('new')\nprint('two')\n")
    (r / "sub" / "inner.py").write_text("x = 2\n")
    return r


def test_status_lists_every_kind_of_change(repo):
    s = gitview.status(repo)
    assert s["repo"] == str(repo) and s["branch"] == "main" and s["head"]["subject"] == "first"
    by = {f["path"]: f for f in s["files"]}
    assert by["keep.py"]["state"] == "modified" and (by["keep.py"]["add"], by["keep.py"]["del"]) == (2, 1)
    assert by["gone.txt"]["state"] == "deleted"
    assert by["new.txt"]["state"] == "renamed" and by["new.txt"]["was"] == "old.txt" and by["new.txt"]["staged"]
    assert by["fresh.py"]["state"] == "new" and by["fresh.py"]["add"] == 2
    assert "other" in s["branches"]


def test_a_folder_sees_only_what_is_under_it_and_relative_to_it(repo):
    s = gitview.status(repo / "sub")
    assert [f["path"] for f in s["files"]] == ["inner.py"] and s["under"] == "sub"
    text, cut = gitview.diff(repo / "sub")
    assert "+++ b/inner.py" in text and "keep.py" not in text and not cut


def test_the_patch_has_new_files_and_stages_nothing(repo):
    text, _ = gitview.diff(repo)
    assert "+b = 3" in text and "+++ b/fresh.py" in text and "+print('two')" in text
    assert "rename from old.txt" in text
    assert "fresh.py" not in git(repo, "diff", "--cached", "--name-only"), "read only: nothing added to the index"


def test_last_commit_and_against_a_branch(repo):
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "second")
    last, _ = gitview.diff(repo, "last")
    assert "+++ b/fresh.py" in last
    against, _ = gitview.diff(repo, "ref", "other")
    assert "+++ b/fresh.py" in against
    assert gitview.diff(repo, "work")[0] == "", "nothing left uncommitted"


@pytest.mark.parametrize("ref", ["--output=/tmp/x", "-p", "no-such-branch", "a b", ""])
def test_a_ref_that_is_not_a_commit_is_refused(repo, ref):
    with pytest.raises(gitview.GitError):
        gitview.diff(repo, "ref", ref)


def test_a_file_outside_is_refused_and_a_folder_outside_a_repo_says_so(repo, tmp_path):
    with pytest.raises(gitview.GitError):
        gitview.diff(repo, "work", "", "../../etc/passwd")
    plain = tmp_path / "plain"
    plain.mkdir()
    assert gitview.status(plain) == {"repo": None}
    assert gitview.status(repo, quick=True) == {"repo": str(repo)}


def test_the_routes_are_behind_the_jail(repo, tmp_path):
    c = TestClient(create_app(Config(token=TOKEN, roots=[repo / "sub"])))
    assert c.get("/api/git/status", params={"path": str(repo / "sub")}, headers=H).json()["files"][0]["path"] == "inner.py"
    r = c.get("/api/git/diff", params={"path": str(repo / "sub")}, headers=H)
    assert r.status_code == 200 and "+x = 2" in r.text and r.headers["content-type"].startswith("text/plain")
    assert c.get("/api/git/status", params={"path": str(repo)}, headers=H).status_code == 403
    assert c.get("/api/git/status", params={"path": str(repo), "quick": 1}, headers=H).json() == {"repo": None}, \
        "a terminal's folder outside the roots: no button, and no error in the console"
    assert c.get("/api/git/diff", params={"path": str(repo / "sub"), "what": "ref", "ref": "-p"}, headers=H).status_code == 400
    assert c.get("/api/git/status", params={"path": str(repo / "sub")}).status_code == 401


# ------------------------------------------------------------------------------ viewer packs

def pack(root, name, manifest, files=None):
    import json
    folder = root / name
    folder.mkdir(parents=True)
    (folder / "viewer.json").write_text(manifest if isinstance(manifest, str) else json.dumps(manifest))
    for rel, text in (files or {"index.html": "<p>hi</p>"}).items():
        (folder / rel).write_text(text)
    return folder


def test_packs_yours_replace_builtins_and_broken_ones_say_why(tmp_path):
    builtin, yours = tmp_path / "b", tmp_path / "y"
    pack(builtin, "diff", {"name": "diff", "files": ["*.diff"]})
    pack(yours, "diff", {"name": "diff", "title": "My diff", "files": ["*.diff", "*.patch"], "edits": True})
    pack(yours, "bad", "{nope")
    pack(yours, "other", {"name": "different", "files": ["*.x"]})
    pack(yours, "noentry", {"name": "noentry", "files": ["*.y"], "entry": "missing.html"})
    packs, broken = viewerpacks.available(builtin, yours)
    assert [(p["name"], p["source"], p["title"]) for p in packs] == [("diff", "yours", "My diff")]
    reasons = {b["folder"]: b["error"] for b in broken}
    assert "not JSON" in reasons["bad"] and "must be the same" in reasons["other"] and "not in the pack" in reasons["noentry"]
    assert viewerpacks.for_file(packs, "X.PATCH")["name"] == "diff"


def test_a_pack_file_never_comes_from_outside_its_folder(tmp_path):
    builtin, yours = tmp_path / "b", tmp_path / "y"
    folder = pack(yours, "p", {"name": "p", "files": ["*.p"]}, {"index.html": "ok", "a.js": "1"})
    (tmp_path / "secret").write_text("no")
    (folder / "link").symlink_to(tmp_path / "secret")
    assert viewerpacks.locate(builtin, yours, "p", "a.js") == (folder / "a.js").resolve()
    assert viewerpacks.locate(builtin, yours, "p", "../../secret") is None
    assert viewerpacks.locate(builtin, yours, "p", "link") is None
    assert viewerpacks.locate(builtin, yours, "../y/p", "a.js") is None


def test_pack_files_are_served_in_their_box(tmp_path):
    app = create_app(Config(token=TOKEN, roots=[tmp_path]))
    c = TestClient(app)
    r = c.get("/viewers/diff/index.html")                    # a built-in, no token needed
    assert r.status_code == 200 and "sandbox allow-scripts" in r.headers["content-security-policy"]
    assert "connect-src 'none'" in r.headers["content-security-policy"]
    assert c.get("/viewers/diff/..%2F..%2F..%2Fapp%2Fmain.py").status_code == 404
    assert "create_app" not in c.get("/viewers/diff/../../app/main.py").text
    assert c.get("/vendor/diff2html-3.4.56/diff2html.min.css").headers["access-control-allow-origin"] == "*"
    said = c.get("/api/viewers", headers=H).json()
    assert any(p["name"] == "diff" and p["source"] == "builtin" for p in said["packs"])
    assert c.get("/api/viewers").status_code == 401

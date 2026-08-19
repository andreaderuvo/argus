"""Worktrees: found from a file, added on a new or existing branch, and refused when it matters."""

from __future__ import annotations

import shutil
import subprocess

import pytest

from app import gitwork

HAS_GIT = shutil.which("git") is not None
pytestmark = pytest.mark.skipif(not HAS_GIT, reason="no git here")


@pytest.fixture
def repo(tmp_path):
    where = tmp_path / "project"
    where.mkdir()
    run = lambda *a: subprocess.run(["git", *a], cwd=where, capture_output=True, check=True)
    run("init", "-q", "-b", "main")
    run("config", "user.email", "nobody@example.invalid")
    run("config", "user.name", "Nobody")
    (where / "file.txt").write_text("one\n")
    run("add", ".")
    run("commit", "-qm", "first")
    return where


def test_the_repository_is_found_from_a_file_inside_it(repo):
    """`git -C` wants a directory, so a path to a *file* answered "not a repository" — which is
    exactly the path a browser has when it asks about the thing you just clicked."""
    assert gitwork.top_of(repo / "file.txt") == repo
    assert gitwork.top_of(repo) == repo


def test_somewhere_that_is_not_a_repository_says_so(tmp_path):
    assert gitwork.top_of(tmp_path) is None


def test_a_fresh_repository_has_one_worktree_and_it_is_the_repository(repo):
    found = gitwork.worktrees(repo)
    assert len(found) == 1
    assert found[0]["branch"] == "main"
    assert found[0]["head"] and len(found[0]["head"]) == 12


def test_a_worktree_is_added_beside_the_repository_with_the_files_in_it(repo):
    where = gitwork.suggested_path(repo, "feature/one")
    assert where.parent == repo.parent, "a checkout nested inside its own parent gets counted twice"
    made = gitwork.add(repo, where, "feature/one")
    assert made["branch"] == "feature/one"
    assert (where / "file.txt").read_text() == "one\n"
    assert {w["branch"] for w in gitwork.worktrees(repo)} == {"main", "feature/one"}


def test_an_existing_branch_is_checked_out_rather_than_refused(repo):
    subprocess.run(["git", "branch", "already"], cwd=repo, check=True, capture_output=True)
    where = gitwork.suggested_path(repo, "already")
    # `git worktree add -b already` would fail here; "it exists" is not a reason to refuse what
    # somebody asked for.
    assert gitwork.add(repo, where, "already")["branch"] == "already"


def test_a_path_that_is_already_there_is_refused(repo):
    where = gitwork.suggested_path(repo, "one")
    gitwork.add(repo, where, "one")
    with pytest.raises(gitwork.GitError):
        gitwork.add(repo, where, "two")


def test_removing_one_with_unsaved_work_in_it_is_refused_until_forced(repo):
    where = gitwork.suggested_path(repo, "one")
    gitwork.add(repo, where, "one")
    (where / "unsaved.txt").write_text("an afternoon\n")
    with pytest.raises(gitwork.GitError):
        gitwork.remove(repo, where)
    assert where.exists(), "git's refusal is the only thing between that file and a button"
    gitwork.remove(repo, where, force=True)
    assert not where.exists()


def test_the_branch_name_comes_back_without_its_refs_heads(repo):
    where = gitwork.suggested_path(repo, "deep/name")
    gitwork.add(repo, where, "deep/name")
    branches = {w["branch"] for w in gitwork.worktrees(repo)}
    assert "deep/name" in branches
    assert not any((b or "").startswith("refs/") for b in branches)

"""The jail is the module that must never regress. Ported 1:1 from the Rust suite."""

import os

import pytest

from app.safepath import Denied, Jail, NotFound


@pytest.fixture
def scratch(tmp_path):
    (tmp_path / "root" / "sub").mkdir(parents=True)
    (tmp_path / "root" / "sub" / "file.txt").write_bytes(b"hello")
    (tmp_path / "outside").mkdir()
    (tmp_path / "outside" / "secret.txt").write_bytes(b"nope")
    return tmp_path


@pytest.fixture
def jail(scratch):
    return Jail([scratch / "root"])


def test_accepts_paths_inside_the_root(scratch, jail):
    f = scratch / "root" / "sub" / "file.txt"
    assert jail.resolve(str(f)) == f.resolve()


def test_accepts_the_root_itself(scratch, jail):
    assert jail.resolve(str(scratch / "root")) == (scratch / "root").resolve()


def test_rejects_dotdot_traversal(scratch, jail):
    with pytest.raises(Denied):
        jail.resolve(str(scratch / "root" / ".." / "outside" / "secret.txt"))
    with pytest.raises(Denied):
        jail.resolve("/etc/passwd")
    with pytest.raises(Denied):
        jail.resolve("/root/../../etc/shadow")


def test_rejects_symlink_pointing_out_of_the_root(scratch, jail):
    os.symlink(scratch / "outside", scratch / "root" / "escape")
    # Both the link itself and anything under it must be refused.
    with pytest.raises(Denied):
        jail.resolve(str(scratch / "root" / "escape"))
    with pytest.raises(Denied):
        jail.resolve(str(scratch / "root" / "escape" / "secret.txt"))


def test_missing_path_inside_the_root_is_not_found_not_denied(scratch, jail):
    with pytest.raises(NotFound):
        jail.resolve(str(scratch / "root" / "sub" / "nope.txt"))


def test_missing_path_outside_the_root_is_denied_so_existence_never_leaks(scratch, jail):
    with pytest.raises(Denied):
        jail.resolve(str(scratch / "outside" / "nope.txt"))


def test_rejects_relative_and_empty_paths(jail):
    for bad in ("", "root/sub", "../etc"):
        with pytest.raises(Denied):
            jail.resolve(bad)


def test_sibling_root_prefix_is_not_a_match(scratch, jail):
    (scratch / "rootx").mkdir()
    (scratch / "rootx" / "f").write_bytes(b"x")
    with pytest.raises(Denied):
        jail.resolve(str(scratch / "rootx" / "f"))


def test_unusable_roots_are_a_startup_error(tmp_path):
    with pytest.raises(ValueError):
        Jail([tmp_path / "does-not-exist"])


def test_missing_roots_are_skipped_when_another_one_works(scratch):
    j = Jail([scratch / "root", scratch / "does-not-exist"])
    assert j.roots == [(scratch / "root").resolve()]

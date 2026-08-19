"""The workspace, on the machine: what merging means and what a version is for."""

from __future__ import annotations

import json

import pytest

from app import prefs


def test_nothing_there_is_version_zero_and_an_empty_document(tmp_path):
    assert prefs.load(tmp_path / "prefs.json") == (0, {})
    assert prefs.load(None) == (0, {})


def test_a_broken_file_is_empty_rather_than_an_exception(tmp_path):
    store = tmp_path / "prefs.json"
    store.write_text("{ not json", encoding="utf-8")
    assert prefs.load(store) == (0, {})
    # And it is left alone, so somebody can look at what went wrong.
    assert store.read_text(encoding="utf-8") == "{ not json"


def test_a_round_trip_keeps_the_version_and_the_mode(tmp_path):
    store = tmp_path / "prefs.json"
    prefs.save(store, 7, {"theme": "dark"})
    assert prefs.load(store) == (7, {"theme": "dark"})
    assert oct(store.stat().st_mode)[-3:] == "600"


def test_merging_keeps_the_keys_the_other_device_wrote():
    """The whole reason this is a merge and not a replacement.

    The laptop saving its copy of everything must not take away the desk made on the phone.
    """
    theirs = {"workspaces": ["the phone's desk"], "theme": "dark"}
    assert prefs.merge(theirs, {"theme": "light"}) == {
        "workspaces": ["the phone's desk"], "theme": "light",
    }


def test_a_null_removes_a_key_because_otherwise_nothing_can_be_forgotten():
    assert prefs.merge({"a": 1, "b": 2}, {"b": None}) == {"a": 1}


def test_merging_replaces_a_whole_key_rather_than_reaching_inside_it():
    """Not a deep merge, deliberately: `workspaces` is a list of desks and reaching inside it
    would mean deciding what a changed desk is — and guessing wrong loses a window."""
    before = {"winGeom": {"1:term:a": {"left": "10px"}, "1:term:b": {"left": "20px"}}}
    after = prefs.merge(before, {"winGeom": {"1:term:a": {"left": "99px"}}})
    assert after == {"winGeom": {"1:term:a": {"left": "99px"}}}


def test_something_far_too_large_is_refused_rather_than_written(tmp_path):
    store = tmp_path / "prefs.json"
    with pytest.raises(ValueError):
        prefs.save(store, 1, {"huge": "x" * (prefs.MAX_BYTES + 10)})
    assert not store.exists()


def test_a_document_that_is_not_a_map_is_ignored(tmp_path):
    store = tmp_path / "prefs.json"
    store.write_text(json.dumps({"version": 3, "prefs": ["not", "a", "map"]}), encoding="utf-8")
    assert prefs.load(store) == (0, {})

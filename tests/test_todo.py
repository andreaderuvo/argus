"""The little list: what it keeps, what it refuses, and the one thing it must never drop."""

from __future__ import annotations

import json

import pytest

from app import todo


def test_a_note_needs_words():
    with pytest.raises(ValueError):
        todo.add([], "   ")


def test_added_newest_first_because_that_is_how_it_is_read():
    items, _ = todo.add([], "first")
    items, _ = todo.add(items, "second")
    assert [x["note"] for x in items] == ["second", "first"]


def test_a_status_it_does_not_know_is_refused_rather_than_stored():
    items, made = todo.add([], "a thing")
    with pytest.raises(ValueError):
        todo.change(items, made["id"], None, "later")


def test_moving_it_records_when_but_editing_the_words_does_not():
    items, made = todo.add([], "a thing")
    was = made["moved"]
    items, edited = todo.change(items, made["id"], "the same thing, better said", None)
    assert edited["moved"] == was
    items, edited = todo.change(items, made["id"], None, "done")
    assert edited["moved"] > was


def test_the_cap_drops_finished_ones_and_never_an_open_one():
    """A list that silently forgets something you have not done is not a list you can rely on."""
    items = []
    for i in range(todo.KEEP + 20):
        items, made = todo.add(items, f"thing {i}", "done" if i % 2 else "open")
    assert len(items) == todo.KEEP
    assert sum(1 for x in items if x["status"] == "open") == (todo.KEEP + 20) // 2


def test_a_broken_file_reads_as_an_empty_list_and_is_left_alone(tmp_path):
    store = tmp_path / "todo.json"
    store.write_text("{ this is not json", encoding="utf-8")
    assert todo.load(store) == []
    assert store.read_text(encoding="utf-8") == "{ this is not json"


def test_it_survives_a_round_trip_through_the_file(tmp_path):
    store = tmp_path / "todo.json"
    items, _ = todo.add([], "remember the milk")
    todo.save(store, items)
    assert [x["note"] for x in todo.load(store)] == ["remember the milk"]
    assert oct(store.stat().st_mode)[-3:] == "600"


def test_junk_in_the_file_is_skipped_rather_than_crashing(tmp_path):
    store = tmp_path / "todo.json"
    store.write_text(json.dumps([{"note": "real"}, "nonsense", {"nothing": 1}]), encoding="utf-8")
    assert [x["note"] for x in todo.load(store)] == ["real"]


def test_removing_says_whether_it_removed_anything():
    items, made = todo.add([], "a thing")
    left, gone = todo.remove(items, made["id"])
    assert gone and left == []
    assert todo.remove(left, made["id"]) == ([], False)

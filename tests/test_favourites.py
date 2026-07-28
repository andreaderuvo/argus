import json
import stat

import pytest

from app.favourites import GROUPS, describe, describe_all, group_of, load, relocate, save, toggle


def test_a_missing_store_is_an_empty_group_map(tmp_path):
    assert load(tmp_path / "nope.json") == {g: [] for g in GROUPS}


def test_saving_and_loading_round_trips(tmp_path):
    store = tmp_path / "f.json"
    save(store, {"main": ["/home/a"], "sidebar": ["/mnt/disk2"], "windows": []})
    back = load(store)
    assert back["main"] == ["/home/a"]
    assert back["sidebar"] == ["/mnt/disk2"]
    assert back["windows"] == []


def test_the_old_flat_list_is_carried_into_every_group(tmp_path):
    """It used to be one shared list; nobody should log in to find it gone."""
    store = tmp_path / "f.json"
    store.write_text(json.dumps(["/home/a", "/mnt/disk2"]))
    back = load(store)
    for g in GROUPS:
        assert back[g] == ["/home/a", "/mnt/disk2"]


def test_a_corrupt_store_is_empty_not_a_crash(tmp_path):
    store = tmp_path / "f.json"
    store.write_text("{not json")
    assert load(store) == {g: [] for g in GROUPS}


def test_only_absolute_paths_survive_a_load(tmp_path):
    store = tmp_path / "f.json"
    store.write_text(json.dumps({"main": ["/good", "relative/bad", 42, None]}))
    assert load(store)["main"] == ["/good"]


def test_duplicates_collapse_but_order_is_kept(tmp_path):
    store = tmp_path / "f.json"
    store.write_text(json.dumps({"sidebar": ["/b", "/a", "/b"]}))
    assert load(store)["sidebar"] == ["/b", "/a"]


def test_the_store_is_private(tmp_path):
    store = tmp_path / "f.json"
    save(store, {"main": ["/home/a"]})
    assert stat.S_IMODE(store.stat().st_mode) == 0o600


def test_groups_do_not_leak_into_each_other():
    paths = {g: [] for g in GROUPS}
    paths, pinned = toggle(paths, "sidebar", "/home/a")
    assert pinned
    assert paths["sidebar"] == ["/home/a"]
    assert paths["main"] == [] and paths["windows"] == []


def test_toggle_pins_then_unpins():
    paths, _ = toggle({g: [] for g in GROUPS}, "windows", "/home/a")
    paths, pinned = toggle(paths, "windows", "/home/a")
    assert not pinned and paths["windows"] == []


def test_an_unknown_group_falls_back_to_main():
    assert group_of("nonsense") == "main"
    assert group_of(None) == "main"
    assert group_of("sidebar") == "sidebar"


def test_describe_marks_what_is_gone(tmp_path):
    (tmp_path / "here").mkdir()
    out = describe([str(tmp_path / "here"), str(tmp_path / "gone")])
    assert out[0]["type"] == "directory" and not out[0]["missing"]
    assert out[1]["missing"], "a pin whose target vanished is reported, not silently dropped"


def test_describe_all_covers_every_group(tmp_path):
    out = describe_all({"main": [str(tmp_path)]})
    assert set(out) == set(GROUPS)
    assert out["main"][0]["type"] == "directory"


def test_a_rename_carries_pins_in_every_group(tmp_path):
    store = tmp_path / "f.json"
    save(store, {"main": ["/data/runs"], "sidebar": ["/data/runs/one.txt"], "windows": ["/other"]})
    out = relocate(store, "/data/runs", "/data/archive")
    assert out["main"] == ["/data/archive"]
    assert out["sidebar"] == ["/data/archive/one.txt"]
    assert out["windows"] == ["/other"]

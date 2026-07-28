import json

from app.favourites import describe, load, relocate, save, toggle


def test_saving_and_loading_round_trips(tmp_path):
    store = tmp_path / "favourites.json"
    save(store, ["/home/a", "/mnt/disk2/runs"])
    assert load(store) == ["/home/a", "/mnt/disk2/runs"]


def test_a_missing_store_is_an_empty_list(tmp_path):
    assert load(tmp_path / "nope.json") == []


def test_a_corrupt_store_is_an_empty_list_not_a_crash(tmp_path):
    store = tmp_path / "favourites.json"
    store.write_text("{not json")
    assert load(store) == []
    store.write_text('{"unexpected": "shape"}')
    assert load(store) == []


def test_only_absolute_paths_survive_a_load(tmp_path):
    store = tmp_path / "favourites.json"
    store.write_text(json.dumps(["/good", "relative/bad", 42, None]))
    assert load(store) == ["/good"]


def test_duplicates_collapse_but_order_is_kept(tmp_path):
    store = tmp_path / "favourites.json"
    store.write_text(json.dumps(["/b", "/a", "/b"]))
    assert load(store) == ["/b", "/a"]


def test_the_store_is_private(tmp_path):
    import stat
    store = tmp_path / "favourites.json"
    save(store, ["/home/a"])
    assert stat.S_IMODE(store.stat().st_mode) == 0o600


def test_toggle_pins_then_unpins():
    paths, pinned = toggle([], "/home/a")
    assert paths == ["/home/a"] and pinned
    paths, pinned = toggle(paths, "/home/a")
    assert paths == [] and not pinned


def test_describe_marks_what_is_gone(tmp_path):
    (tmp_path / "here").mkdir()
    out = describe([str(tmp_path / "here"), str(tmp_path / "gone")])
    assert out[0]["type"] == "directory" and not out[0]["missing"]
    assert out[1]["missing"], "a pin whose target vanished is reported, not silently dropped"
    assert out[1]["name"] == "gone"


def test_a_rename_carries_its_pins_along(tmp_path):
    store = tmp_path / "favourites.json"
    save(store, ["/data/runs", "/data/runs/one.txt", "/other"])
    assert relocate(store, "/data/runs", "/data/archive") == [
        "/data/archive", "/data/archive/one.txt", "/other",
    ]


def test_relocating_something_unpinned_changes_nothing(tmp_path):
    store = tmp_path / "favourites.json"
    save(store, ["/a"])
    assert relocate(store, "/b", "/c") == ["/a"]

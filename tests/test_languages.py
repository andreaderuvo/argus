import json

import pytest

from app.languages import BadLanguage, available, check_code, locate, parse, read, save


def catalogue(tmp_path, folder, code, name="X", strings=None):
    d = tmp_path / folder
    d.mkdir(exist_ok=True)
    (d / f"{code}.json").write_text(json.dumps({
        "code": code, "name": name, "strings": strings or {"Save": "Save"},
    }))
    return d


def test_a_code_looks_like_a_language(tmp_path):
    assert check_code(" IT ") == "it"
    assert check_code("pt-br") == "pt-br"
    for bad in ("", "english", "../etc/passwd", "i", "it_IT"):
        with pytest.raises(BadLanguage):
            check_code(bad)


def test_a_code_cannot_walk_out_of_the_folder(tmp_path):
    """The code becomes a filename, so it is the only thing standing between an upload
    and any path on the machine."""
    with pytest.raises(BadLanguage):
        check_code("../../../tmp/evil")


def test_a_bare_mapping_is_accepted_as_a_catalogue():
    code, name, strings = parse({"code": "de", "Save": "Speichern"})
    assert code == "de" and strings["Save"] == "Speichern"


def test_the_wrapped_shape_is_accepted_too():
    code, name, strings = parse({"code": "de", "name": "Deutsch", "strings": {"Save": "Speichern"}})
    assert name == "Deutsch" and strings == {"Save": "Speichern"}


def test_rubbish_is_refused():
    for bad in ({}, {"code": "de"}, {"code": "de", "strings": {}}, [], "nope"):
        with pytest.raises(BadLanguage):
            parse(bad)


def test_an_enormous_file_is_refused():
    with pytest.raises(BadLanguage):
        parse({"code": "de", "strings": {str(i): "x" for i in range(5000)}})


def test_both_folders_are_listed(tmp_path):
    builtin = catalogue(tmp_path, "builtin", "en", "English")
    user = catalogue(tmp_path, "user", "de", "Deutsch")
    codes = {e["code"]: e["source"] for e in available(builtin, user)}
    assert codes == {"en": "builtin", "de": "user"}


def test_a_user_file_overrides_the_shipped_one(tmp_path):
    """That is how someone fixes a translation they disagree with."""
    builtin = catalogue(tmp_path, "builtin", "it", "Italiano")
    user = catalogue(tmp_path, "user", "it", "Il mio italiano")
    entries = available(builtin, user)
    assert len(entries) == 1
    assert entries[0]["name"] == "Il mio italiano" and entries[0]["source"] == "user"
    assert locate("it", builtin, user).parent.name == "user"


def test_a_broken_file_is_skipped_not_fatal(tmp_path):
    builtin = catalogue(tmp_path, "builtin", "en")
    (builtin / "broken.json").write_text("{ not json")
    assert [e["code"] for e in available(builtin, tmp_path / "missing")] == ["en"]


def test_saving_and_reading_back(tmp_path):
    path = save(tmp_path / "user", "pt-br", "Português", {"Save": "Salvar"})
    assert read(path)["strings"]["Save"] == "Salvar"
    assert not list((tmp_path / "user").glob("*.part")), "the temporary file is renamed away"

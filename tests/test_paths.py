"""Text in a terminal turned back into files.

The guessing is deliberately loose — the frontend sends every word that could be a path
— so what matters here is that nothing outside the jail is ever confirmed, and that the
punctuation real output wraps paths in does not stop them resolving.
"""

import pytest
from fastapi.testclient import TestClient

from app import paths, tmux
from app.config import Config
from app.main import create_app
from app.paths import expand, trim

TOKEN = "testtoken-0123456789abcdef"


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root" / "src").mkdir(parents=True)
    (tmp_path / "root" / "src" / "main.rs").write_text("fn main() {}\n")
    (tmp_path / "root" / "notes.md").write_text("# hi\n")
    (tmp_path / "secret").mkdir()
    (tmp_path / "secret" / "keys.txt").write_text("nope\n")
    return tmp_path


@pytest.fixture
def client(tree):
    return TestClient(create_app(Config(token=TOKEN, roots=[tree / "root"])))


def locate(client, paths, **rest):
    return client.post(
        "/api/fs/locate",
        json={"paths": paths, **rest},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )


def test_the_line_number_a_compiler_prints_is_not_part_of_the_name():
    assert trim("src/main.rs:12:5") == ("src/main.rs", 12)
    assert trim("app.py:41") == ("app.py", 41)
    assert trim("thing.c(88)") == ("thing.c", 88)


def test_punctuation_from_the_surrounding_prose_comes_off():
    assert trim("/etc/hosts.") == ("/etc/hosts", None)
    assert trim("('/tmp/ab')") == ("/tmp/ab", None)
    assert trim('"/var/log/x.log",') == ("/var/log/x.log", None)


def test_a_bracket_after_a_line_number_comes_off_too():
    """`File "x.py", line 3` and `at foo.js:9)` both happen; one pass is not enough."""
    assert trim("foo.js:9).") == ("foo.js", 9)


def test_a_plain_name_survives_intact():
    assert trim("/home/ada/report.2024.pdf") == ("/home/ada/report.2024.pdf", None)


def test_relative_paths_need_somewhere_to_be_relative_to():
    assert expand("src/main.rs", None) is None
    assert expand("src/main.rs", "/home/ada") == "/home/ada/src/main.rs"
    assert expand("/etc/hosts", None) == "/etc/hosts"


def test_a_tilde_is_a_path_not_a_file_called_tilde(monkeypatch):
    monkeypatch.setenv("HOME", "/home/ada")
    assert expand("~/notes.md", None) == "/home/ada/notes.md"


def test_an_absolute_path_in_the_jail_is_found(client, tree):
    r = locate(client, [str(tree / "root" / "notes.md")])
    assert r.status_code == 200
    hit = r.json()["found"][str(tree / "root" / "notes.md")]
    assert hit["type"] == "file"


def test_a_directory_says_so_because_it_opens_somewhere_else(client, tree):
    r = locate(client, [str(tree / "root" / "src")])
    assert r.json()["found"][str(tree / "root" / "src")]["type"] == "directory"


def test_a_relative_path_resolves_against_the_base(client, tree):
    r = locate(client, ["src/main.rs"], base=str(tree / "root"))
    assert r.json()["found"]["src/main.rs"]["path"] == str(tree / "root" / "src" / "main.rs")


def test_the_line_number_is_handed_back_for_the_viewer(client, tree):
    r = locate(client, ["src/main.rs:12"], base=str(tree / "root"))
    assert r.json()["found"]["src/main.rs:12"]["line"] == 12


def test_nothing_outside_the_roots_is_ever_confirmed(client, tree):
    """This endpoint answers "does this exist" for arbitrary text, so it must answer it
    only for what the server would serve anyway — otherwise it maps the filesystem."""
    r = locate(client, [str(tree / "secret" / "keys.txt"), "/etc/passwd", "/root"])
    assert r.json()["found"] == {}


def test_a_traversal_out_of_the_base_is_not_a_path(client, tree):
    r = locate(client, ["../secret/keys.txt"], base=str(tree / "root"))
    assert r.json()["found"] == {}


def test_words_that_are_not_paths_are_simply_absent(client, tree):
    r = locate(client, ["hello", "3.14", "node.js", "--flag", ""])
    assert r.json()["found"] == {}


def test_a_base_outside_the_roots_is_refused_rather_than_ignored(client, tree):
    r = locate(client, ["keys.txt"], base=str(tree / "secret"))
    assert r.status_code == 403


def test_an_unknown_session_is_refused(client):
    assert locate(client, ["x"], session="no-such-session-here").status_code == 404


def test_the_candidate_list_is_capped(client, tree):
    """A line of a thousand words must not become a thousand stat calls."""
    real = str(tree / "root" / "notes.md")
    r = locate(client, [f"/nope/{i}" for i in range(200)] + [real])
    assert r.status_code == 200
    assert real not in r.json()["found"], "everything past the cap is dropped, not stat'ed"


def test_locating_needs_the_token(client, tree):
    r = client.post("/api/fs/locate", json={"paths": [str(tree / "root" / "notes.md")]})
    assert r.status_code == 401


def test_a_read_only_server_still_locates(tree):
    """Nothing here mutates; a viewer-only deployment loses none of it."""
    ro = TestClient(create_app(Config(token=TOKEN, roots=[tree / "root"], allow_write=False)))
    r = locate(ro, [str(tree / "root" / "notes.md")])
    assert r.status_code == 200 and r.json()["found"]


def test_pane_cwd_prefers_what_something_told_us(monkeypatch):
    """A pane option beats the pane's process directory.

    The reason it exists: an agent that changes folder inside itself never calls `chdir()`,
    so `#{pane_current_path}` goes on naming where the process started. Anything that does
    know — a Claude Code statusLine hook, a shell's PROMPT_COMMAND — writes it into
    `@argus_cwd`, and that is what a browser is told.
    """
    asked = []

    class Answer:
        def __init__(self, out):
            self.returncode = 0
            self.stdout = out
            self.stderr = ""

    def fake_run(args, **kw):
        fmt = args[-1]
        asked.append(fmt)
        if fmt == "#{@argus_cwd}":
            return Answer("/told/you\n")
        return Answer("/where/the/process/is\n")

    monkeypatch.setattr(paths.subprocess, "run", fake_run)
    assert paths.pane_cwd(tmux.Socket(None), "one") == "/told/you"
    assert asked == ["#{@argus_cwd}"]


def test_pane_cwd_falls_back_to_the_process(monkeypatch):
    """With nothing set, the pane's own directory — right for a shell, honest for the rest."""

    class Answer:
        def __init__(self, out):
            self.returncode = 0
            self.stdout = out
            self.stderr = ""

    def fake_run(args, **kw):
        return Answer("" if args[-1] == "#{@argus_cwd}" else "/where/the/process/is\n")

    monkeypatch.setattr(paths.subprocess, "run", fake_run)
    assert paths.pane_cwd(tmux.Socket(None), "one") == "/where/the/process/is"

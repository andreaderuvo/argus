"""Word documents.

pandoc turns one into a document you can actually read; when it is missing or unhappy the
plain-text extraction has to still be there, because a report you cannot open on a phone
is the thing this was built to avoid.
"""

import zipfile

import pytest
from fastapi.testclient import TestClient

from app import files
from app.config import Config
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml"
 ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Target="word/document.xml"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/>
</Relationships>"""

DOCUMENT = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Prima riga con </w:t></w:r>
<w:r><w:rPr><w:b/></w:rPr><w:t>grassetto</w:t></w:r><w:r><w:t> dentro.</w:t></w:r></w:p>
</w:body></w:document>"""


@pytest.fixture
def tree(tmp_path):
    (tmp_path / "root").mkdir()
    with zipfile.ZipFile(tmp_path / "root" / "relazione.docx", "w") as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCUMENT)
    return tmp_path


@pytest.fixture
def client(tree):
    return TestClient(create_app(Config(token=TOKEN, roots=[tree / "root"])))


def get(client, path):
    return client.get(f"/api/file?path={path}", headers={"Authorization": f"Bearer {TOKEN}"})


needs_pandoc = pytest.mark.skipif(files.find_pandoc() is None, reason="pandoc is not installed here")


@needs_pandoc
def test_a_word_file_comes_back_as_a_document(client, tree):
    r = get(client, tree / "root" / "relazione.docx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["x-rendered"] == "document"
    assert "<strong>grassetto</strong>" in r.text, "the formatting is the whole point"


@needs_pandoc
def test_the_rendered_document_is_sandboxed_like_any_other_html(client, tree):
    """It is somebody else's document rendered into our origin's page: without the
    sandbox it could read the token out of localStorage."""
    r = get(client, tree / "root" / "relazione.docx")
    assert "sandbox" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"


@needs_pandoc
def test_the_name_is_not_printed_twice(client, tree):
    """The viewer already shows the file name in its header; pandoc's template would put
    it at the top of the page as a heading as well."""
    r = get(client, tree / "root" / "relazione.docx")
    assert 'class="title"' not in r.text


def test_without_pandoc_it_falls_back_to_plain_text(client, tree, monkeypatch):
    monkeypatch.setattr(files, "find_pandoc", lambda: None)
    r = get(client, tree / "root" / "relazione.docx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")
    assert "grassetto" in r.text, "the words survive even when the formatting cannot"


def test_a_pandoc_that_fails_falls_back_rather_than_erroring(client, tree, monkeypatch):
    monkeypatch.setattr(files, "pandoc_html", lambda *a: None)
    r = get(client, tree / "root" / "relazione.docx")
    assert r.status_code == 200
    assert "grassetto" in r.text


@needs_pandoc
def test_a_document_that_renders_enormous_falls_back(client, tree, monkeypatch):
    """Inlined figures can turn a small file into a page a phone cannot hold."""
    monkeypatch.setattr(files, "PANDOC_MAX_HTML", 10)
    r = get(client, tree / "root" / "relazione.docx")
    assert r.headers["content-type"].startswith("text/plain")


def test_pandoc_is_looked_for_beside_the_interpreter(monkeypatch, tmp_path):
    """A service started by systemd has a bare PATH, so `which` finds nothing on a machine
    where everything lives in a conda environment — and that is this machine."""
    fake = tmp_path / "bin"
    fake.mkdir()
    (fake / "pandoc").write_text("#!/bin/sh\n")
    (fake / "pandoc").chmod(0o755)

    monkeypatch.setattr(files.shutil, "which", lambda name: None)
    monkeypatch.setattr(files.sys, "executable", str(fake / "python3"))
    assert files.find_pandoc() == str(fake / "pandoc")


def test_nothing_is_claimed_when_there_is_no_pandoc_anywhere(monkeypatch, tmp_path):
    monkeypatch.setattr(files.shutil, "which", lambda name: None)
    monkeypatch.setattr(files.sys, "executable", str(tmp_path / "python3"))
    assert files.find_pandoc() is None

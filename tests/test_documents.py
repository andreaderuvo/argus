"""Preview of the formats a browser cannot open on its own."""

import zipfile

import pytest

from app.errors import ApiError
from app.files import document_text

DOCX = """<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Titolo del documento</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Prima riga, </w:t></w:r><w:r><w:t>continua.</w:t></w:r></w:p>
    <w:p/>
    <w:p><w:r><w:t>Dopo un paragrafo vuoto</w:t></w:r></w:p>
  </w:body>
</w:document>"""

ODT = """<?xml version="1.0"?>
<office:document-content
    xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0"
    xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
  <office:body><office:text>
    <text:h>Relazione</text:h>
    <text:p>Corpo del testo.</text:p>
  </office:text></office:body>
</office:document-content>"""


def make(path, member, xml):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr(member, xml)
    return path


def test_docx_becomes_readable_lines(tmp_path):
    text = document_text(make(tmp_path / "r.docx", "word/document.xml", DOCX))
    lines = text.strip().splitlines()
    assert lines[0] == "Titolo del documento"
    assert "Prima riga, continua." in lines, "runs inside one paragraph stay on one line"
    assert "Dopo un paragrafo vuoto" in lines


def test_docx_does_not_pile_up_blank_lines(tmp_path):
    text = document_text(make(tmp_path / "r.docx", "word/document.xml", DOCX))
    assert "\n\n\n" not in text


def test_odt_headings_and_paragraphs(tmp_path):
    text = document_text(make(tmp_path / "r.odt", "content.xml", ODT))
    assert text.strip().splitlines() == ["Relazione", "Corpo del testo."]


def test_a_document_that_is_not_a_zip_is_415_not_500(tmp_path):
    broken = tmp_path / "r.docx"
    broken.write_bytes(b"this is not a zip")
    with pytest.raises(ApiError) as e:
        document_text(broken)
    assert e.value.status == 415


def test_a_zip_without_the_expected_part_is_415(tmp_path):
    with pytest.raises(ApiError) as e:
        document_text(make(tmp_path / "r.docx", "other.xml", "<a/>"))
    assert e.value.status == 415


def test_base_tag_lands_after_the_doctype():
    """A tag before the doctype puts the whole document into quirks mode."""
    from app.proxy import with_base

    out = with_base(b"<!doctype html>\n<p>hi</p>", "/proxy/8123/")
    assert out.startswith(b"<!doctype html>")
    assert b'<base href="/proxy/8123/">' in out


def test_base_tag_prefers_the_head():
    from app.proxy import with_base

    out = with_base(b"<html><head><title>x</title></head>", "/proxy/9/")
    assert out.index(b"<base") > out.index(b"<head>")
    assert out.index(b"<base") < out.index(b"<title>")


def test_a_page_that_already_declares_a_base_is_left_alone():
    from app.proxy import with_base

    html = b'<html><head><base href="/somewhere/"></head>'
    assert with_base(html, "/proxy/9/") == html

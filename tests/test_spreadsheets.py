"""Spreadsheets.

Not routed through pandoc — see `SPREADSHEET_FORMATS` in app/files.py for why: pandoc
lists xlsx as a reader, but fails on a real file whose `.rels` targets are package-absolute
(`/xl/worksheets/sheet1.xml`), which is legal OPC and how real Excel writes them. This
reads the same zipped XML by hand and builds the table directly.
"""

import zipfile

import pytest
from fastapi.testclient import TestClient

from app import files
from app.config import Config
from app.files import spreadsheet_html
from app.main import create_app

TOKEN = "testtoken-0123456789abcdef"

WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
 xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>
<sheet name="Isolates" sheetId="1" r:id="rId1"/>
<sheet name="Empty" sheetId="2" r:id="rId2"/>
</sheets>
</workbook>"""

# rId1 is package-absolute — the exact form pandoc's reader gets wrong. rId2 is the
# ordinary relative form, so both resolution paths are exercised.
RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>
<Relationship Id="rId2" Target="worksheets/sheet2.xml"
 Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/>
</Relationships>"""

SHARED_STRINGS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>Sample</t></si>
<si><t>Cluster</t></si>
</sst>"""

# Row 1: two shared strings. Row 2: a shared string, a bare number, an inline string, and
# a deliberately empty self-closing cell (a real, common shape — a styled cell with no
# value) between B and D, to check the column-index gap is filled rather than shifting
# everything left.
SHEET1 = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>3</v></c><c r="C2" s="2"/>
<c r="D2" t="inlineStr"><is><t>right where it was typed</t></is></c></row>
</sheetData>
</worksheet>"""

SHEET2 = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData/>
</worksheet>"""


def make(path, shared=True):
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", RELS)
        if shared:
            z.writestr("xl/sharedStrings.xml", SHARED_STRINGS)
        z.writestr("xl/worksheets/sheet1.xml", SHEET1)
        z.writestr("xl/worksheets/sheet2.xml", SHEET2)
    return path


def test_sheets_come_back_in_workbook_order_with_their_own_names(tmp_path):
    out = spreadsheet_html(make(tmp_path / "r.xlsx")).decode()
    assert out.index("Isolates") < out.index("Empty")


def test_a_package_absolute_rels_target_resolves_the_way_pandoc_gets_wrong(tmp_path):
    """The regression this module exists for: `/xl/worksheets/sheet1.xml` must resolve to
    the member `xl/worksheets/sheet1.xml`, not `xl//xl/worksheets/sheet1.xml`."""
    out = spreadsheet_html(make(tmp_path / "r.xlsx")).decode()
    assert "Sample" in out and "Cluster" in out, "sheet1, reached via the absolute target, must render"


def test_shared_strings_numbers_and_inline_strings_all_land_in_the_right_cell(tmp_path):
    out = spreadsheet_html(make(tmp_path / "r.xlsx")).decode()
    assert "<td>Sample</td><td>3</td><td></td><td>right where it was typed</td>" in out, (
        "an empty styled cell between two others must not shift the rest of the row left"
    )


def test_a_sheet_with_no_rows_says_so_rather_than_an_empty_table(tmp_path):
    out = spreadsheet_html(make(tmp_path / "r.xlsx")).decode()
    assert "empty sheet" in out


def test_works_without_a_shared_strings_part_at_all(tmp_path):
    """A sheet built entirely of inline strings and numbers has no reason to carry one."""
    with zipfile.ZipFile(tmp_path / "r.xlsx", "w") as z:
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", RELS)
        z.writestr("xl/worksheets/sheet1.xml", SHEET1.replace('t="s"', 't="inlineStr"')
                   .replace("<v>0</v>", "<is><t>x</t></is>").replace("<v>3</v>", "<is><t>y</t></is>"))
        z.writestr("xl/worksheets/sheet2.xml", SHEET2)
    assert spreadsheet_html(tmp_path / "r.xlsx") is not None


def test_html_is_escaped(tmp_path):
    # As it would actually appear on disk: a real writer escapes markup in cell text, so
    # the XML parser hands this code a string that already contains a literal "<script>" —
    # the thing under test is whether *this* code escapes it again on the way into HTML.
    hostile = SHEET1.replace("right where it was typed", "&lt;script&gt;alert(1)&lt;/script&gt;")
    with zipfile.ZipFile(tmp_path / "r.xlsx", "w") as z:
        z.writestr("xl/workbook.xml", WORKBOOK)
        z.writestr("xl/_rels/workbook.xml.rels", RELS)
        z.writestr("xl/sharedStrings.xml", SHARED_STRINGS)
        z.writestr("xl/worksheets/sheet1.xml", hostile)
        z.writestr("xl/worksheets/sheet2.xml", SHEET2)
    out = spreadsheet_html(tmp_path / "r.xlsx").decode()
    assert "<script>" not in out
    assert "&lt;script&gt;" in out


def test_not_a_zip_at_all_is_none_not_a_crash(tmp_path):
    bad = tmp_path / "r.xlsx"
    bad.write_bytes(b"not a zip file")
    assert spreadsheet_html(bad) is None


def test_a_zip_missing_the_workbook_part_is_none_not_a_crash(tmp_path):
    empty = tmp_path / "r.xlsx"
    with zipfile.ZipFile(empty, "w") as z:
        z.writestr("hello.txt", "not a spreadsheet")
    assert spreadsheet_html(empty) is None


def test_output_over_the_cap_falls_back(tmp_path, monkeypatch):
    monkeypatch.setattr(files, "PANDOC_MAX_HTML", 10)
    assert spreadsheet_html(make(tmp_path / "r.xlsx")) is None


# --------------------------------------------------------------------- through the API


def get(client, path):
    return client.get(f"/api/file?path={path}", headers={"Authorization": f"Bearer {TOKEN}"})


@pytest.fixture
def client(tmp_path):
    (tmp_path / "root").mkdir()
    make(tmp_path / "root" / "isolati.xlsx")
    return TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))


def test_an_xlsx_comes_back_as_a_rendered_document(client, tmp_path):
    r = get(client, tmp_path / "root" / "isolati.xlsx")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/html")
    assert r.headers["x-rendered"] == "document"
    assert "Sample" in r.text


def test_the_rendered_sheet_is_sandboxed_like_any_other_document(client, tmp_path):
    r = get(client, tmp_path / "root" / "isolati.xlsx")
    assert "sandbox" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"


def test_a_corrupt_xlsx_is_a_415_not_a_crash(tmp_path):
    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "corrotto.xlsx").write_bytes(b"not actually a zip")
    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))
    r = get(client, tmp_path / "root" / "corrotto.xlsx")
    assert r.status_code == 415

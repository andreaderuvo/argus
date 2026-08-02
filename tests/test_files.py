from app.files import content_disposition, walk_for


def test_content_disposition_neutralises_hostile_filenames():
    cd = content_disposition('in"jec\nted.txt')
    assert "\n" not in cd
    assert cd.count('"') == 2, "only the wrapping quotes survive"
    assert "filename*=UTF-8''" in cd


def test_content_disposition_keeps_unicode_in_the_extended_form():
    cd = content_disposition("relazione-più.pdf")
    # The ASCII fallback substitutes per character, so `ù` becomes a single `_`.
    assert 'filename="relazione-pi_.pdf"' in cd
    assert "filename*=UTF-8''relazione-pi%C3%B9.pdf" in cd


def test_content_disposition_survives_a_fully_unprintable_name():
    assert 'filename="___"' in content_disposition("///")


def test_search_skips_noisy_directories_and_finds_by_substring(tmp_path):
    (tmp_path / "node_modules" / "deep").mkdir(parents=True)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "README.md").write_bytes(b"x")
    (tmp_path / "node_modules" / "deep" / "README.md").write_bytes(b"x")

    hits = walk_for(tmp_path, "readme")
    assert len(hits) == 1, "the node_modules copy must not be reported"
    assert hits[0]["path"].endswith("src/README.md")


def test_search_also_skips_dotted_directories(tmp_path):
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config.txt").write_bytes(b"x")
    (tmp_path / "config.txt").write_bytes(b"x")

    hits = walk_for(tmp_path, "config")
    assert [h["name"] for h in hits] == ["config.txt"]
    assert ".git" not in hits[0]["path"]


def test_search_reports_directories_too(tmp_path):
    (tmp_path / "reports").mkdir()
    hits = walk_for(tmp_path, "report")
    assert len(hits) == 1 and hits[0]["type"] == "directory"


def test_a_pdf_search_needs_a_pdf(tmp_path):
    """This file has no client fixture of its own; the endpoint check is worth its own
    small one rather than moving the other tests around it."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    (tmp_path / "notes.txt").write_text("not a pdf\n")
    client = TestClient(create_app(Config(token=token, roots=[tmp_path])))
    r = client.get(f"/api/pdf/search?path={tmp_path / 'notes.txt'}&q=x",
                   headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 400


def test_finding_a_word_reports_the_page_it_is_on(monkeypatch):
    """pdftotext separates pages with a form feed, which is what makes "which page" an
    answerable question without a PDF library."""
    from app import files

    pages = files.hits_in(["nothing here", "the word Salmonella appears", "nor here"], "salmonella")
    assert [h["page"] for h in pages] == [2]
    assert "Salmonella" in pages[0]["text"], "the snippet keeps the original case"


def test_every_occurrence_is_reported_but_a_page_does_not_flood_the_list():
    from app import files

    crowded = ["x " * 200 + ("hit " * 30)]
    assert len(files.hits_in(crowded, "hit")) <= 4


def test_the_whole_list_is_capped():
    from app import files

    many = [f"hit on page {i}" for i in range(500)]
    assert len(files.hits_in(many, "hit")) == files.PDF_MAX_HITS


def test_an_inline_file_still_carries_its_name():
    """The PDF viewer's own save button takes the name from the URL, and every URL here
    ends in /api/file — which is how every download came out called "file.pdf"."""
    cd = content_disposition("Relazione finale.pdf", inline=True)
    assert cd.startswith("inline; ")
    assert 'filename="Relazione finale.pdf"' in cd
    assert "filename*=UTF-8''Relazione%20finale.pdf" in cd


def test_inline_names_are_neutralised_the_same_way():
    cd = content_disposition('in"jec\nted.pdf', inline=True)
    assert "\n" not in cd and cd.count('"') == 2


def test_a_pdf_is_served_for_reading_with_its_name(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    # Enough of a PDF for the type to be guessed from the suffix; the bytes never matter
    # to the header.
    (tmp_path / "Relazione finale.pdf").write_bytes(b"%PDF-1.4\n%%EOF\n")
    client = TestClient(create_app(Config(token=token, roots=[tmp_path])))
    r = client.get(f"/api/file?path={tmp_path / 'Relazione finale.pdf'}",
                   headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "application/pdf"
    assert r.headers["content-disposition"].startswith("inline; ")
    assert "Relazione finale.pdf" in r.headers["content-disposition"]

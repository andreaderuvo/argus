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

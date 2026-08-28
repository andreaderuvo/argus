from app.files import content_disposition, walk_for

TOKEN = "testtoken-0123456789abcdef"


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


def test_a_pdf_is_stamped_with_its_version(tmp_path):
    """The address of a document names the version, so a rebuilt one is never mistaken
    for the one already on screen — and an unchanged one is not sent down twice."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    doc = tmp_path / "paper.pdf"
    doc.write_bytes(b"%PDF-1.4\n%%EOF\n")
    client = TestClient(create_app(Config(token=token, roots=[tmp_path])))
    auth = {"Authorization": f"Bearer {token}"}
    ask = f"/api/file?path={doc}"

    first = client.get(ask, headers=auth)
    tag = first.headers.get("etag")
    assert tag, "a document handed to the browser's own viewer must say which version it is"
    assert first.headers["cache-control"] == "no-cache"

    again = client.get(ask, headers={**auth, "if-none-match": tag})
    assert again.status_code == 304
    assert not again.content

    # latexmk has been at it. Same address, same question, different answer.
    import os
    doc.write_bytes(b"%PDF-1.4\n% rebuilt\n%%EOF\n")
    os.utime(doc, (0, 0))
    after = client.get(ask, headers={**auth, "if-none-match": tag})
    assert after.status_code == 200
    assert after.headers["etag"] != tag


def test_text_is_read_again_every_time(tmp_path):
    """A log that grew by a line must show that line: nothing here is cached."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    token = "testtoken-0123456789abcdef"
    note = tmp_path / "run.log"
    note.write_text("one\n")
    client = TestClient(create_app(Config(token=token, roots=[tmp_path])))
    r = client.get(f"/api/file?path={note}", headers={"Authorization": f"Bearer {token}"})
    assert "etag" not in r.headers


def test_a_folder_you_may_not_read_is_not_a_server_error(tmp_path, monkeypatch):
    """403, not 500.

    `/home/IZSNT` on a machine with domain accounts is exactly this: you walk through it to
    your own home every day and you may not list it. Reported as a 500 in the console while
    the file browser walked down to a file — which reads as "Argus is broken" and is not.
    """
    import errno as _errno
    import os as _os

    from fastapi.testclient import TestClient
    from app.config import Config
    from app.main import create_app

    (tmp_path / "root" / "shut").mkdir(parents=True)
    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))

    real = _os.scandir

    def refuse(where, *a, **k):
        if str(where).endswith("shut"):
            raise PermissionError(_errno.EACCES, "Permission denied", str(where))
        return real(where, *a, **k)

    monkeypatch.setattr(_os, "scandir", refuse)
    r = client.get(
        f"/api/files?path={tmp_path / 'root' / 'shut'}",
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert r.status_code == 403, r.text
    assert "not readable" in r.json()["error"]


def test_the_server_says_when_it_started(tmp_path):
    """So the page can tell a blip from a restart, and only reload for the second.

    Any failed request used to mean "the server is gone", and the next successful one
    reloaded the page — so a single dropped request threw away whatever was on screen. The
    page now asks twice before believing it, and when the server answers again it compares
    this: the same process is not a reason to start over.
    """
    from fastapi.testclient import TestClient
    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))
    said = client.get("/api/config", headers={"Authorization": f"Bearer {TOKEN}"}).json()
    assert isinstance(said["started"], float)
    assert said["started"] > 0


def _binary_stl(triangles: int = 1) -> bytes:
    """A minimal, valid binary STL: an 80-byte header, a triangle count, then that many
    50-byte records (a normal, three vertices, two bytes of attribute padding — all zero
    is a legal, if degenerate, triangle)."""
    import struct

    header = b"argus test fixture".ljust(80, b"\x00")
    body = b"\x00" * 50 * triangles
    return header + struct.pack("<I", triangles) + body


def test_a_binary_stl_is_served_as_a_model_not_refused_as_binary(tmp_path):
    """The old rule — a NUL byte in the first 8 KiB means refuse it — would catch nearly
    every binary STL there is, since the format's own header is eighty bytes that are
    typically all zero."""
    from fastapi.testclient import TestClient
    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "part.stl").write_bytes(_binary_stl())
    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))
    r = client.get("/api/file?path=" + str(tmp_path / "root" / "part.stl"),
                   headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("model/stl")
    assert "inline" in r.headers["content-disposition"]
    assert r.content == _binary_stl()


def test_an_ascii_stl_is_served_as_a_model_too(tmp_path):
    """Not routed to the text viewer, even though it contains no NUL byte and would pass
    as plain text: the point is the shape it describes, not the syntax it is written in."""
    from fastapi.testclient import TestClient
    from app.config import Config
    from app.main import create_app

    ascii_stl = (
        "solid test\n"
        " facet normal 0 0 1\n"
        "  outer loop\n"
        "   vertex 0 0 0\n"
        "   vertex 1 0 0\n"
        "   vertex 0 1 0\n"
        "  endloop\n"
        " endfacet\n"
        "endsolid test\n"
    )
    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "part.stl").write_text(ascii_stl)
    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))
    r = client.get("/api/file?path=" + str(tmp_path / "root" / "part.stl"),
                   headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("model/stl")


def test_an_oversized_stl_is_refused_rather_than_sliced(tmp_path):
    """A tail of a mesh is not a smaller mesh, it is a corrupt one — unlike a log, where the
    tail is exactly the part anyone wants. `model/stl` has to sit in `INLINE_TYPES` for the
    existing size guard to treat it that way."""
    from fastapi.testclient import TestClient
    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "big.stl").write_bytes(_binary_stl(triangles=100))
    client = TestClient(create_app(Config(
        token=TOKEN, roots=[tmp_path / "root"], max_preview_bytes=200,
    )))
    r = client.get("/api/file?path=" + str(tmp_path / "root" / "big.stl"),
                   headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 413
    assert "download" in r.json()["error"]


def test_a_step_file_is_served_as_a_model_not_as_text(tmp_path):
    """A STEP file is plain ASCII and would pass as text/plain untouched — the point is
    that it is routed to the model viewer regardless, not read as a document."""
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    step_text = "ISO-10303-21;\nHEADER;\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n"
    (tmp_path / "root").mkdir()
    for name in ("part.step", "part.stp"):
        (tmp_path / "root" / name).write_text(step_text)

    client = TestClient(create_app(Config(token=TOKEN, roots=[tmp_path / "root"])))
    for name in ("part.step", "part.stp"):
        r = client.get(f"/api/file?path={tmp_path / 'root' / name}",
                       headers={"Authorization": f"Bearer {TOKEN}"})
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("model/step"), name
        assert "inline" in r.headers["content-disposition"]


def test_an_oversized_step_file_is_refused_rather_than_sliced(tmp_path):
    from fastapi.testclient import TestClient

    from app.config import Config
    from app.main import create_app

    (tmp_path / "root").mkdir()
    (tmp_path / "root" / "big.step").write_text("ISO-10303-21;\n" + "X" * 500)
    client = TestClient(create_app(Config(
        token=TOKEN, roots=[tmp_path / "root"], max_preview_bytes=200,
    )))
    r = client.get(f"/api/file?path={tmp_path / 'root' / 'big.step'}",
                   headers={"Authorization": f"Bearer {TOKEN}"})
    assert r.status_code == 413

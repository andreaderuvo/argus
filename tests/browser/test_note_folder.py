"""Text into a file, opened on a folder: it goes into that folder, says so before it
saves, and can be sent elsewhere. Left unnamed, each save takes the next free note-N.txt —
a folder you chose refuses a name that is taken, and the second note would have been refused."""

from __future__ import annotations

from .test_flows import eventually

NOTE = "document.querySelector('.notebody')"
WHERE = "document.querySelector('.notewhere .notewherepath')?.textContent.replace(/\\u200E/g, '')"


def test_a_note_goes_into_the_desks_folder_and_says_where(make_page, argus):
    desk = argus.root / "docs"
    other = argus.root / "a"
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "home": str(desk), "desktop": []}]}})
    page = make_page(route="#/wall")
    # Opened as a folder's menu opens it (the desk's own button became Notes, in the rail).
    page.eval(f"import('/js/tray.js').then(m => m.openWindow({{ kind: 'note', id: m.nextWindowId(), path: {str(desk)!r} }}))")
    page.wait(f"!!{NOTE}", timeout=10, what="the note window")
    assert page.eval(WHERE) == str(desk), "the folder is shown before saving"

    for want in ("note-1.txt", "note-2.txt"):
        page.eval(f"(() => {{ const b = {NOTE}.querySelector('.notearea'); b.value = 'listeria {want}'; b.dispatchEvent(new Event('input')); }})()")
        # Pressed directly: the toast saying the last path sits over the corner the button is in.
        page.eval(f"{NOTE}.querySelector('.noterow .winbtn').click()")
        eventually(lambda: (desk / want).exists(), timeout=10, what=f"saved as {want}")
        assert (desk / want).read_text() == f"listeria {want}"

    # Somewhere else: the folder button asks, and the next save lands there.
    page.eval(f"{NOTE}.querySelector('.notewhere').click()")
    page.wait("!!document.querySelector('dialog[open] input')", timeout=5)
    page.eval(f"(() => {{ const i = document.querySelector('dialog[open] input'); i.value = {str(other)!r}; i.dispatchEvent(new Event('input')); }})()")
    page.click_text("Choose", within="dialog[open] button")
    page.wait(f"{WHERE} === {str(other)!r}", timeout=5, what="the new folder shown")
    page.eval(f"(() => {{ const b = {NOTE}.querySelector('.notearea'); b.value = 'elsewhere'; b.dispatchEvent(new Event('input')); }})()")
    page.eval(f"{NOTE}.querySelector('.noterow .winbtn').click()")
    eventually(lambda: (other / "note-1.txt").exists(), timeout=10, what="saved in the folder chosen")
    eventually(lambda: any(w.get("kind") == "note" and w.get("path") == str(other)
                           for w in argus.api("/api/prefs")["prefs"]["workspaces"][0]["desktop"]),
               timeout=10, what="and the window remembers it")

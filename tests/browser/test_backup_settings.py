"""Settings → Backup, as a person uses it: a folder added, the copy made and said, the backup looked at."""

from __future__ import annotations

import os

BOX = "document.querySelector('.settings .backup')"


def test_a_folder_is_added_copied_into_and_offered_back(make_page, argus):
    page = make_page(route="#/settings")
    page.wait(f"!!{BOX}", timeout=15, what="the Backup section")
    page.wait(f"{BOX}.querySelector('.backupline.off')", timeout=10, what="'not backed up yet' said")

    place = str(argus.root / "argus-backup")
    page.eval(f"""(() => {{ const i = document.getElementById('backupnew'); i.value = {place!r};
                           [...{BOX}.querySelectorAll('.backupadd button')][0].click(); }})()""")
    page.wait(f"!!{BOX}.querySelector('.backupline.good')", timeout=15, what="the first copy said")
    page.wait(f"{BOX}.querySelector('.backupplace .name')?.textContent === {place!r}", timeout=5)
    assert os.path.exists(os.path.join(place, "manifest.json"))
    assert os.path.exists(os.path.join(place, "README.txt"))
    # Inside the folders Argus shows: it can be kept on a computer through argus-bridge too.
    assert page.eval(f"[...{BOX}.querySelectorAll('.backupplace button')].length") == 2

    if os.environ.get("ARGUS_SHOTS"):
        page.eval(f"{BOX}.previousElementSibling.scrollIntoView()")
        page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "backup-settings.png"))

    page.eval(f"[...{BOX}.querySelectorAll('.backupfoot button')][1].click()")
    page.wait("!!document.querySelector('dialog.sheet .backuplook p')", timeout=10, what="the backup looked at")
    assert "Made" in page.eval("document.querySelector('dialog.sheet .backuplook p').textContent")
    if os.environ.get("ARGUS_SHOTS"):
        page.screenshot(os.path.join(os.environ["ARGUS_SHOTS"], "backup-restore.png"))

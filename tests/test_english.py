"""Argus is written in English: code, comments, test data, documentation.

Italian crept in more than once — a person's words quoted as they were said, test data copied from a
screenshot, example names (2026-10-23: "MAI!"). Words they said are quoted translated. Italian belongs
only where it is a translation: the catalogues, and the few places listed here with the reason.
"""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Words that are Italian and nothing else Argus would write (no English, Spanish or French twins).
ITALIAN = set("""che perché perchè sono della delle degli cartella cartelle quindi però già più può deve dovrebbe
sarebbe vorrei questo questa quando dove anche sempre nulla niente tutto tutti fatto finito grazie ancora
adesso funziona succede scopro caricando caso cosa così ecco qui sì oppure invece senza cioè vedo voglio
servono riga righe ciao stai grassetto relazione dentro""".split())

# Never read: translations by design.
CATALOGUES = re.compile(r"^(static/lang/|static/vendor/|node_modules/|static/themes/|docs/img/)|\.(png|webp|jpg|svg|ico|pdf|woff2?)$")
# Read, but these lines are Italian on purpose — each says why.
ALLOWED = {
    "static/viewers/diff/viewer.json": "the diff viewer's own translations, it beside es and fr",
    "docs/viewers.md": "shows how a viewer pack carries its translations, with an Italian one",
    "tests/browser/test_viewer_packs.py": "a pack's Italian translation, checked to be used",
    "tests/test_teams.py": "a goal written in Italian is understood (TEMPLATE_WORDS)",
    "tests/test_english.py": "this list of words",
}


def test_no_italian_outside_the_translations():
    files = subprocess.run(["git", "ls-files"], capture_output=True, text=True, cwd=ROOT).stdout.split()
    found = []
    for name in files:
        if CATALOGUES.search(name) or name in ALLOWED:
            continue
        try:
            text = (ROOT / name).read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for n, line in enumerate(text.splitlines(), 1):
            words = set(re.findall(r"[a-zàèéìòù]+", line.lower()))
            # TEMPLATE_WORDS holds each language's words for a goal, Italian among them, on purpose.
            if words & ITALIAN and "TEMPLATE_WORDS" not in text[: text.find(line)][-2000:]:
                found.append(f"{name}:{n}: {line.strip()[:100]}")
    assert not found, "Italian in the code (translate it, or list the file in ALLOWED with why):\n" + "\n".join(found)

"""The app moves between its screens without navigating.

WebKit on macOS 26 (argus-bridge's window) sometimes answers a navigation, even to a fragment, with a process
swap "due to EnhancedSecurity change" that loads the window's first address again: the page reloaded under
clicks and lost what had just been opened (2026-11-25/26). `go()` in router.js uses pushState instead; nothing
else may assign the address.
"""

from __future__ import annotations

import re

from frontend_source import frontend_files

ASSIGNS = re.compile(r"\blocation\.(hash|href)\s*=(?!=)|\blocation\.assign\(|\blocation\.replace\(")


def test_nothing_but_go_changes_the_address():
    found = []
    for path in frontend_files():
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("//")[0]
            if code.lstrip().startswith(("*", "/*")):
                continue                       # a comment
            if ASSIGNS.search(code):
                found.append(f"{path.name}:{n}: {line.strip()}")
    # inapp.js leaves for the main browser on purpose (another address, a real navigation).
    found = [f for f in found if not f.startswith("inapp.js:")]
    assert not found, "use go() from router.js:\n" + "\n".join(found)

"""The Links tray's lists: one preference key per desk, and none for a desk that is gone.

They were one key for every desk — 311 KB on a real machine, sent whole whenever any terminal
printed a new path (a save sends the keys that changed). Measured 2026-10-14."""

from __future__ import annotations

import json
import time

from .test_flows import eventually

ONE = {"text": "/data/run1", "path": "/data/run1", "dir": True, "from": "s", "at": 1, "count": 3}


def test_the_old_key_is_taken_apart_and_gone_desks_lose_theirs(make_page, argus):
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 10, "workspaces": [
        {"id": 1, "name": "Main", "desktop": []}, {"id": 2, "name": "Other", "desktop": []}],
        "links": {"1": [ONE], "2": [ONE, {**ONE, "text": "/x"}], "3": [ONE], "42": [ONE]}}})
    page = make_page(route="#/files")
    def stored():
        return argus.api("/api/prefs")["prefs"]
    eventually(lambda: "links" not in stored(), timeout=10, what="the old key gone from the machine")
    p = stored()
    assert len(p["links.1"]) == 1 and len(p["links.2"]) == 2
    assert "links.3" not in p, "desk 3 was made here (id <= wsSeq) and is gone: its links too"
    assert "links.42" in p, "a desk made elsewhere and not seen yet keeps its links"
    # A save of something else carries no link list at all.
    sent = []
    page._listeners.append(lambda m: m.get("method") == "Network.requestWillBeSent"
                           and m["params"]["request"]["url"].endswith("/api/prefs")
                           and m["params"]["request"].get("method") == "PATCH"
                           and sent.append(m["params"]["request"].get("postData", "")))
    page.eval("import('/js/state.js').then(s => { s.prefs.fontSize = 15; import('/js/core.js').then(c => c.savePrefs()); })")
    eventually(lambda: sent, timeout=5, what="the save")
    body = json.loads(sent[-1])
    assert list(body["changes"]) == ["fontSize"], body["changes"].keys()

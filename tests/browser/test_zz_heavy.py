import time
def timed(page, action, done, timeout=60):
    t = time.time(); page.eval(action) if action else None
    page.wait(done, timeout=timeout); return round(time.time() - t, 2)

def test_heavy(make_page, argus):
    argus.kill_sessions()
    big = argus.root / "big"; big.mkdir(exist_ok=True)
    for i in range(5000):
        (big / f"sample_{i:05d}.fastq.gz").write_bytes(b"")
    for i in range(50):
        argus.tmux("new-session", "-d", "-s", f"s{i:02d}", "-x", "100", "-y", "30")
    d1 = [{"kind": "term", "name": f"s{i:02d}"} for i in range(8)]
    d2 = [{"kind": "term", "name": f"s{i:02d}"} for i in range(8, 12)]
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 2, "workspaces": [
        {"id": 1, "name": "Eight", "desktop": d1}, {"id": 2, "name": "Four", "desktop": d2}]}})
    page = make_page(route="#/files")
    page.send("Emulation.setCPUThrottlingRate", {"rate": 6})
    page.send("Performance.enable")
    print("HEAVY desk of 8:", timed(page, "location.hash = '#/wall?ws=1'", "document.querySelectorAll('.deck .win .xterm-screen').length >= 8"), "s")
    time.sleep(2)
    print("HEAVY switch to desk of 4:", timed(page, "[...document.querySelectorAll('.wstab')].find(t => t.textContent.includes('Four')).click()", "[...document.querySelectorAll('.deck')].some(d => getComputedStyle(d).display !== 'none' && d.querySelectorAll('.win .xterm-screen').length >= 4)"), "s")
    time.sleep(1)
    print("HEAVY switch back:", timed(page, "[...document.querySelectorAll('.wstab')].find(t => t.textContent.includes('Eight')).click()", "[...document.querySelectorAll('.deck')].some(d => getComputedStyle(d).display !== 'none' && d.querySelectorAll('.win .xterm-screen').length >= 8)"), "s")
    print("HEAVY sessions (50):", timed(page, "location.hash = '#/sessions'", "document.querySelectorAll('.rowwrap.sess').length >= 50"), "s")
    print("HEAVY folder of 5000:", timed(page, f"location.hash = '#/files?path={big}'", "document.querySelectorAll('.row').length >= 100", 90), "s",
          "rows in DOM:", page.eval("document.querySelectorAll('.row').length"))
    m = {x["name"]: x["value"] for x in page.send("Performance.getMetrics")["metrics"]}
    print("HEAVY nodes", m["Nodes"], "heap MB", round(m["JSHeapUsedSize"] / 1e6, 1), "listeners", m["JSEventListeners"])
    page.send("Emulation.setCPUThrottlingRate", {"rate": 1})
    argus.kill_sessions()

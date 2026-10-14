import time
from .test_close_window import CROSS, MENU
def test_probe(make_page, argus):
    argus.kill_sessions()
    for name in ("busy", "calm"):
        argus.tmux("new-session", "-d", "-s", name, "-x", "80", "-y", "24")
    argus.tmux("send-keys", "-t", "busy", "while :; do date; sleep 0.05; done", "Enter")
    argus.api("/api/prefs", "PATCH", {"changes": {"ws": 1, "wsSeq": 1, "workspaces": [
        {"id": 1, "name": "Main", "desktop": [{"kind": "term", "name": "busy"}, {"kind": "term", "name": "calm"}]}]}})
    page = make_page(route="#/wall?ws=1")
    page.wait(f"!!{CROSS % 'calm'}", timeout=15)
    page.eval("[...document.querySelectorAll('button')].find(b => (b.title||'').includes('Arrange as a grid'))?.click()")
    time.sleep(1.5)
    out = []
    for s in ("busy", "calm"):
        page.click_at(*page._center(CROSS % s))
        time.sleep(1.0)
        out.append((s, page.eval(f"{MENU}.length"), page.eval("document.elementFromPoint(...(r => [r.x + r.width/2, r.y + r.height/2])(" + (CROSS % s) + ".getBoundingClientRect()))?.className")))
        page.key("Escape", "Escape")
    print("PROBE", out)
    argus.kill_sessions()

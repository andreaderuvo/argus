#!/usr/bin/env python3
"""The landing page's slideshow: Argus in use, in screenshots that can be taken again.

Built on the demo's invented world (scripts/demo.py — a Salmonella surveillance study and a small
web shop, four agents on it): every name, path, number and machine in the frames is made up. The
Argus that is photographed runs with HOME inside that world, on its own tmux socket, and reads a
fabricated machine for the System screen, so nothing of the computer it runs on can reach a frame —
and every frame's text is checked for it before it is kept (FORBIDDEN).

    python3 scripts/showcase.py                 # every slide, both themes -> docs/img/showcase/
    python3 scripts/showcase.py desk report     # some of them

Wants Chromium (ARGUS_CHROMIUM, else Playwright's) and Pillow.
"""

from __future__ import annotations

import io
import json
import os
import shlex
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(HERE / "scripts"))
sys.path.insert(0, str(HERE))
import demo  # noqa: E402
from tests.browser.cdp import Page, Session, http_json  # noqa: E402

ROOT = demo.ROOT
PORT = 8124
SOCKET = "argus-showcase"
TOKEN = demo.TOKEN
CONFIG = Path("/tmp/lab-showcase.yaml")
OUT = HERE / "docs" / "img" / "showcase"
WIDE = {"width": 1440, "height": 900, "deviceScaleFactor": 0, "mobile": False}   # 0: the browser's own, 2 (--force-device-scale-factor)
PHONE = {"width": 390, "height": 844, "deviceScaleFactor": 3, "mobile": True}

# Whatever of the machine this is made on must never be in a frame.
def _this_machine() -> list[str]:
    """Words that would identify the computer this runs on: its user, its names and domain, its home
    folder and its addresses — read from it, so no name is written into this file."""
    import socket
    words = {os.environ.get("USER", ""), str(Path.home()), Path.home().name, "/home/"}
    for name in (socket.gethostname(), socket.getfqdn()):
        words.add(name)
        words.update(part for part in name.split(".") if part not in ("local", "localdomain", "lan", "intra", "com", "org", "net"))
    try:
        words.update(subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=3).stdout.split())
    except (OSError, subprocess.SubprocessError):
        pass
    return sorted(w for w in words if w and len(w) > 2 and not w.startswith("127."))


FORBIDDEN = _this_machine()

# Agents at work: the transcript, then a spinner that keeps redrawing — which is exactly what makes
# Argus read a pane as "working" (app/agentstate.py), the same way a real Claude Code is read.
SPIN = ("i=37; while :; do printf '\\r\\033[38;5;179m✻\\033[0m %s \\033[2m(%ds)\\033[0m' "
        "\"{what}\" $i; i=$((i+1)); sleep 0.7; done")
WAIT = ("while :; do printf '\\n\\033[38;5;108m> \\033[0m'; IFS= read -r __line || break; done")


def tmux(*args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "HOME": str(ROOT)}
    return subprocess.run(["tmux", "-L", SOCKET, "-f", str(ROOT / ".tmux.conf"), *args],
                          capture_output=True, text=True, env=env)


def build() -> None:
    demo.build_files(ROOT)
    demo.build_web(ROOT)
    (ROOT / ".tmux.conf").write_text(demo.TMUXCONF)
    (ROOT / ".demorc").write_text(demo.RCFILE)
    tmux("kill-server")
    time.sleep(0.3)
    project, shop = ROOT / "salmonella-2026", ROOT / "shopfront"
    scripts = {
        "frontend": (demo.FRONTEND, shop, SPIN.format(what="Fixing add() too…"), ("claude", "Opus 5")),
        "backend": (demo.BACKEND, shop, SPIN.format(what="Writing the webhook…"), ("codex", "gpt-5.6-sol medium")),
        "tests": (demo.TESTER, shop, WAIT, ("claude", "Sonnet 5")),
        "db": (demo.DB_TRANSCRIPT, shop / "db", f"bash --rcfile {ROOT}/.demorc --noprofile -i", None),
        "review": (demo.CLAUDE, project, WAIT, ("claude", "Opus 5")),
        "apply": (demo.CODEX, project, SPIN.format(what="Rerunning C1…"), ("codex", "gpt-5.6-sol medium")),
        "pipeline": (None, project, f"tail -n 12 logs/pipeline.log; bash --rcfile {ROOT}/.demorc --noprofile -i", None),
    }
    # Argus knows an agent by the program in the pane (app/agentstate.py): a stand-in called
    # `claude` or `codex` — bash under that name — is read as one, working while it redraws and
    # waiting when it stops, exactly as the real thing is.
    agents = ROOT / ".bin"
    agents.mkdir(exist_ok=True)
    for who in ("claude", "codex"):
        link = agents / who
        if not link.exists():
            link.symlink_to("/bin/bash")
    for name, (said, cwd, then, who) in scripts.items():
        command = then
        if said is not None:
            (ROOT / f".said-{name}").write_text(said)
            command = f"printf '%b\\n' \"$(cat {ROOT}/.said-{name})\"; {then}"
        if who:
            command = f"{agents / who[0]} -c {shlex.quote(command)}"
        tmux("new-session", "-d", "-s", name, "-c", str(cwd), "-x", "120", "-y", "34", command)
    time.sleep(0.6)
    for name, (_s, _c, _t, who) in scripts.items():
        if who:
            tmux("set", "-p", "-t", name, "@argus_agent", who[0])
            tmux("set", "-p", "-t", name, "@argus_model", who[1])
    for name, note in (("frontend", "cart badge, then add()"), ("backend", "409 on the last item"),
                       ("tests", "coupon after tax?"), ("review", "C3 — weekly report"), ("apply", "applies the review")):
        tmux("set", "-t", name, "@argus_note", note)
    # Work in progress in the shop, so Changes has something to show.
    git = lambda *a: subprocess.run(["git", "-C", str(shop), *a], capture_output=True, text=True,  # noqa: E731
                                    env={**os.environ, "HOME": str(ROOT), "GIT_AUTHOR_NAME": "Lab", "GIT_AUTHOR_EMAIL": "lab@example.org",
                                         "GIT_COMMITTER_NAME": "Lab", "GIT_COMMITTER_EMAIL": "lab@example.org"})
    git("init", "-q", "-b", "main")
    git("add", "-A")
    git("commit", "-q", "-m", "shopfront as it was")
    (shop / "src" / "store" / "cart.ts").write_text((shop / "src" / "store" / "cart.ts").read_text().replace(
        "items.splice(at, 1)", "items = items.filter((_, i) => i !== at)"))
    (shop / "src" / "checkout" / "total.ts").write_text((shop / "src" / "checkout" / "total.ts").read_text().replace(
        "* (1 + TAX)", "* (1 + TAX)  // coupon now comes off first"))
    (shop / "api" / "routes" / "cart.ts").write_text((shop / "api" / "routes" / "cart.ts").read_text()
                                                     + "\n// 409 rather than 500: the last one has gone, nothing broke.\n")


def start() -> subprocess.Popen:
    CONFIG.write_text(f"listen: 127.0.0.1:{PORT}\ntoken: {TOKEN}\nroots:\n  - {ROOT}\ntmux_socket: {SOCKET}\n"
                      "allow_write: true\nallow_proxy: false\ninclude_mounts: false\ncheck_releases: false\n")
    pretend = Path("/tmp/lab-showcase-system.json")       # outside the folder the pictures show
    pretend.write_text(json.dumps(demo.FAKE_MACHINE), encoding="utf-8")
    env = {**os.environ, "HOME": str(ROOT), "ARGUS_PRETEND": str(pretend), "ARGUS_OLD_TOOLS": "off"}
    env.pop("TMUX", None)
    env.pop("TMUX_PANE", None)
    proc = subprocess.Popen([sys.executable, "-m", "app.main", "--config", str(CONFIG)], cwd=HERE, env=env,
                            stdout=open("/tmp/lab-showcase.log", "w"), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(60):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{PORT}/", timeout=1)
            return proc
        except OSError:
            time.sleep(0.25)
    sys.exit("the showcase Argus did not start — /tmp/lab-showcase.log")


def api(path: str, method: str = "GET", body: dict | None = None):
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {TOKEN}", "content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read() or b"null")


WORKING = ("frontend", "backend", "apply")
WAITING = ("tests", "review")


def settled(timeout: float = 25) -> None:
    """Until Argus reads the agents as the picture means them: the spinners working, the others waiting."""
    end = time.time() + timeout
    while time.time() < end:
        states = api("/api/tmux/states").get("states", {})
        if all(states.get(n, {}).get("state") == "working" for n in WORKING) and \
                all(states.get(n, {}).get("state") == "waiting" for n in WAITING):
            return
        time.sleep(1)


def chromium() -> tuple[subprocess.Popen, Session, int]:
    from tests.browser.conftest import find_chromium
    path = find_chromium()
    if not path:
        sys.exit("no Chromium (ARGUS_CHROMIUM)")
    profile = Path("/tmp/lab-showcase-chromium")
    subprocess.run(["rm", "-rf", str(profile)])
    proc = subprocess.Popen([path, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
                             "--hide-scrollbars", "--force-device-scale-factor=2", "--disable-3d-apis", "--remote-debugging-port=0", f"--user-data-dir={profile}",
                             "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
                             "about:blank"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    port_file = profile / "DevToolsActivePort"
    for _ in range(100):
        if port_file.exists():
            break
        time.sleep(0.1)
    port = int(port_file.read_text().split()[0])
    return proc, Session(http_json(f"http://127.0.0.1:{port}/json/version")["webSocketDebuggerUrl"]), port


class Shooter:
    def __init__(self):
        self.proc, self.browser, self.port = chromium()

    def page(self, viewport=WIDE, theme="dark", route="#/files") -> Page:
        ctx = self.browser.send("Target.createBrowserContext", {"disposeOnDetach": True})["browserContextId"]
        target = self.browser.send("Target.createTarget", {"url": "about:blank", "browserContextId": ctx})["targetId"]
        page = Page(f"ws://127.0.0.1:{self.port}/devtools/page/{target}", f"http://127.0.0.1:{PORT}")
        page.viewport(viewport)
        if viewport.get("mobile"):
            page.send("Emulation.setTouchEmulationEnabled", {"enabled": True, "maxTouchPoints": 5})
            page.touch = True
        api("/api/prefs", "PATCH", {"changes": {"theme": theme, "lang": "en"}})
        page.goto(f"http://127.0.0.1:{PORT}/#token={TOKEN}")
        page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden", timeout=20)
        page.eval(f"location.hash = {route!r}")
        time.sleep(1.2)
        return page

    def keep(self, page: Page, name: str, theme: str) -> Path:
        settled()
        time.sleep(3.5)                 # one more round of the page's own reading of the states
        # Passing notices ("is waiting for you") cover what the picture is of; the question cards stay.
        page.eval("document.querySelectorAll('.toast:not(.askcard)').forEach(n => n.remove())")
        text = page.eval("document.body.innerText + ' ' + [...document.querySelectorAll('[title]')].map(n => n.title).join(' ')")
        leaks = [w for w in FORBIDDEN if w.lower() in text.lower()]
        if leaks:
            low = text.lower()
            where = [text[max(0, low.find(w.lower()) - 60): low.find(w.lower()) + 60].replace("\n", " ") for w in leaks]
            raise SystemExit(f"{name}/{theme}: the frame names {leaks} — not kept:\n  " + "\n  ".join(where))
        OUT.mkdir(parents=True, exist_ok=True)
        raw = OUT / f".{name}-{theme}.png"
        page.screenshot(raw)
        return raw

    def close(self):
        self.browser.close()
        os.killpg(self.proc.pid, signal.SIGTERM)


def webp(src: Path, dest: Path, width: int = 1600) -> None:
    from PIL import Image
    im = Image.open(src).convert("RGB")
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    im.save(dest, "WEBP", quality=84, method=6)
    src.unlink()


def desks(*spaces) -> None:
    api("/api/prefs", "PATCH", {"changes": {"ws": spaces[0]["id"], "wsSeq": len(spaces) + 1,
                                            "workspaces": list(spaces), "sidebar": False, "railWide": True,
                                            "fontSize": 11.5}})


def arrange(page: Page, how: str) -> None:
    page.eval(f"[...document.querySelectorAll('#walltools button')].find(b => (b.title || '').includes({how!r}))?.click()")
    time.sleep(1.2)


# ------------------------------------------------------------------------------- the slides

def slide_desk(s: Shooter, theme: str) -> Path:
    shop = str(ROOT / "shopfront")
    desks({"id": 1, "name": "shopfront", "home": shop, "desktop": [
        {"kind": "term", "name": n} for n in ("frontend", "backend", "tests", "db")]},
        {"id": 2, "name": "salmonella", "home": str(ROOT / "salmonella-2026"), "desktop": [{"kind": "term", "name": "review"}]})
    ask = api("/api/ask", "POST", {"session": "tests", "options": ["Fix it now", "Later"], "text":
        "The coupon is applied **after tax** in `src/checkout/total.ts:8` — every order with a coupon "
        "paid tax on the discount.\n\n- one line to fix\n- the failing test already covers it\n\nShall I fix it before anything else?"})
    page = s.page(theme=theme, route="#/wall?ws=1")
    page.wait("document.querySelectorAll('.win .xterm-screen').length >= 4", timeout=20)
    arrange(page, "Arrange as a grid")
    time.sleep(4)                                   # the sampler sees the spinners: working
    out = s.keep(page, "desk", theme)
    api(f"/api/ask/{ask['id']}/answer", "POST", {"answer": "Later"})
    return out


def slide_report(s: Shooter, theme: str) -> Path:
    project = ROOT / "salmonella-2026"
    desks({"id": 2, "name": "salmonella", "home": str(project), "desktop": [
        {"kind": "term", "name": "review"},
        {"kind": "file", "path": str(project / "results" / "report.md")},
        {"kind": "term", "name": "apply"}]})
    page = s.page(theme=theme, route="#/wall?ws=2")
    page.wait("document.querySelectorAll('.win').length >= 3", timeout=20)
    arrange(page, "Arrange as columns")
    page.wait("!!document.querySelector('.win .md img')", timeout=15)
    time.sleep(2.5)
    return s.keep(page, "report", theme)


def slide_changes(s: Shooter, theme: str) -> Path:
    shop = ROOT / "shopfront"
    desks({"id": 1, "name": "shopfront", "home": str(shop), "desktop": [
        {"kind": "term", "name": "frontend"},
        {"kind": "changes", "path": str(shop), "what": "work"}]})
    page = s.page(theme=theme, route="#/wall?ws=1")
    page.wait("document.querySelectorAll('.win').length >= 2", timeout=20)
    arrange(page, "Arrange as columns")
    time.sleep(3)
    return s.keep(page, "changes", theme)


def slide_system(s: Shooter, theme: str) -> Path:
    page = s.page(theme=theme, route="#/system")
    time.sleep(2.5)
    return s.keep(page, "system", theme)


def slide_team(s: Shooter, theme: str) -> Path:
    shop = ROOT / "shopfront"
    desks({"id": 1, "name": "shopfront", "home": str(shop), "desktop": [{"kind": "term", "name": "tests"}]})
    page = s.page(theme=theme, route="#/wall?ws=1")
    page.eval("[...document.querySelectorAll('#walltools button')].find(b => /team/i.test(b.textContent))?.click()")
    page.wait("!!document.querySelector('dialog[open] textarea')", timeout=15)
    page.eval("""(() => { const goal = document.querySelector('dialog[open] textarea');
      goal.value = 'The coupon is applied after tax in src/checkout/total.ts — make tests/checkout.test.ts pass without touching the test.';
      goal.dispatchEvent(new Event('input', { bubbles: true })); goal.blur(); })()""")
    page.wait("document.querySelectorAll('dialog[open] button.teamcard').length >= 4", timeout=15, what="the shapes")
    time.sleep(0.5)
    page.eval("[...document.querySelectorAll('dialog[open] button.teamcard')].find(n => n.textContent.trim().startsWith('Fix a bug'))?.click()")
    page.wait("[...document.querySelectorAll('dialog[open] button.teamcard.on')].some(n => n.textContent.trim().startsWith('Fix a bug'))", timeout=10)
    page.wait("!!document.querySelector('dialog[open] svg')", timeout=15)
    time.sleep(1.5)
    raw = s.keep(page, "team", theme)
    # Down to the goal, the shapes and the graph: below is what this machine has installed.
    from PIL import Image
    im = Image.open(raw)
    cut = page.eval("(() => { const g = [...document.querySelectorAll('dialog[open] svg')].sort((a, b) => b.getBoundingClientRect().height - a.getBoundingClientRect().height)[0]; return g ? g.getBoundingClientRect().bottom : 0; })()")
    box = page.eval("(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return [r.left, r.top, r.right]; })()")
    if cut:
        scale = im.height / 900
        im.crop((int(box[0] * scale) + 1, int(box[1] * scale) + 1, int(box[2] * scale) - 1, int((cut + 24) * scale))).save(raw)
    return raw


def slide_sessions(s: Shooter, theme: str) -> Path:
    page = s.page(theme=theme, route="#/sessions")
    time.sleep(4)                                   # the sampler's first readings
    return s.keep(page, "sessions", theme)


def slide_since(s: Shooter, theme: str) -> Path:
    for session, why, text in (("frontend", "done", "The cart badge clears now — 3 tests passed"),
                               ("backend", "done", "POST /api/cart answers 409 out_of_stock"),
                               ("review", "asking", "Shall I rerun C1 without the four isolates?"),
                               ("tests", "asking", "needs your permission to use Bash")):
        try:
            api("/api/bell", "POST", {"session": session, "why": why, "text": text})
        except Exception:
            pass
    page = s.page(theme=theme, route="#/since")
    time.sleep(2)
    return s.keep(page, "since", theme)


def slide_phone(s: Shooter, theme: str) -> Path:
    from PIL import Image, ImageDraw
    shots = []
    report = ROOT / "salmonella-2026" / "results" / "report.md"
    for route in ("#/sessions", "#/term?s=tests", f"#/preview?path={report}"):
        page = s.page(viewport=PHONE, theme=theme, route=route)
        time.sleep(2.5)
        shots.append(s.keep(page, f"phone{len(shots)}", theme))
    bg = (15, 24, 32) if theme == "dark" else (234, 240, 238)
    canvas = Image.new("RGB", (2400, 1500), bg)
    frame = (40, 52, 60) if theme == "dark" else (200, 210, 208)
    for i, shot in enumerate(shots):
        im = Image.open(shot).convert("RGB")
        h = 1300
        im = im.resize((round(im.width * h / im.height), h), Image.LANCZOS)
        x = 240 + i * 700
        y = 100
        d = ImageDraw.Draw(canvas)
        d.rounded_rectangle([x - 18, y - 18, x + im.width + 18, y + h + 18], radius=70, fill=frame)
        mask = Image.new("L", im.size, 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, im.width, im.height], radius=54, fill=255)
        canvas.paste(im, (x, y), mask)
        shot.unlink()
    out = OUT / f".phone-{theme}.png"
    canvas.save(out)
    return out


SLIDES = {"desk": slide_desk, "report": slide_report, "phone": slide_phone, "team": slide_team,
          "changes": slide_changes, "sessions": slide_sessions, "system": slide_system}


def main() -> None:
    wanted = [a for a in sys.argv[1:] if a in SLIDES] or list(SLIDES)
    build()
    argus = start()
    shooter = Shooter()
    try:
        for name in wanted:
            for theme in ("dark", "light"):
                raw = SLIDES[name](shooter, theme)
                webp(raw, OUT / f"{name}-{theme}.webp")
                print(f"  {name}-{theme}.webp")
    finally:
        shooter.close()
        os.killpg(argus.pid, signal.SIGTERM)
        tmux("kill-server")


if __name__ == "__main__":
    main()

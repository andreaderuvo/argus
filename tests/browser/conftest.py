"""The browser harness: a real Argus, a real Chromium, and nothing shared with the machine.

- **Argus** runs as a subprocess, exactly as a person starts it (`python -m app.main`), with a
  config of its own in a temporary directory, one root full of sample files, and a tmux socket
  named `argus-t-<pid>-<n>`. Never the default socket: a tmux server that dies takes every
  session on its socket with it (see CLAUDE.md).
- **Chromium** is headless, with a throwaway profile. Every test gets a fresh browser *context*
  — its own localStorage, cookies and service worker — so a preference one test sets cannot
  change what the next one sees.
- **The `page` fixture fails any test that leaves a problem behind**: an uncaught exception, a
  console error, a request of ours that failed or answered 4xx/5xx. That is the part that makes
  the suite hard to fool — a test written to check one button also catches the ReferenceError
  that clicking it set off somewhere else.

Chromium is looked for in $ARGUS_CHROMIUM, then Playwright's cache, then the PATH. Without one
the browser tests are skipped — unless ARGUS_BROWSER_REQUIRED=1, which CI sets, so a runner
that lost its browser fails loudly instead of passing by doing nothing.
"""

from __future__ import annotations

import glob
import itertools
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import urlopen

import pytest
import yaml

from .cdp import DESKTOP, Page, Session, http_json

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "browser-test-token-0123456789abcdef"
_socket_n = itertools.count(1)


# What does not pass in WebKit yet, each with why: expected to fail there (not strictly — a pass is welcome),
# so the WebKit run catches anything new while these stay in sight. Remove a line once it passes.
WEBKIT_GAPS = {
    "test_also.py::test_a_press_sends_it_to_the_other_agent_now": "the typed line is sometimes not recognised in WebKit (unsteady), under investigation",
    "test_also.py::test_after_the_enter_it_offers_to_send_it_too": "the same",
    "test_also.py::test_a_line_it_cannot_be_sure_of_is_not_offered": "the same",
    "test_teameditor.py::test_a_team_is_drawn_with_the_mouse_and_its_text_written_as_it_goes": "Delete after picking a step on the canvas does not reach it in WebKit yet",
    "test_file_icons.py::test_files_and_links_wear_the_icon_of_their_kind": "the link tray sometimes misses a line of the terminal in WebKit (unsteady), under investigation",
}


def pytest_collection_modifyitems(items):
    """Everything under tests/browser is a browser test, without each file having to say so."""
    here = Path(__file__).parent
    for item in items:
        if here in Path(str(item.fspath)).parents:
            item.add_marker(pytest.mark.browser)
            if os.environ.get("ARGUS_ENGINE") == "webkit":
                why = WEBKIT_GAPS.get(f"{Path(str(item.fspath)).name}::{item.name}")
                if why:
                    item.add_marker(pytest.mark.xfail(reason=f"WebKit gap: {why}", strict=False))


# ------------------------------------------------------------------------ finding a browser

def find_chromium() -> str | None:
    said = os.environ.get("ARGUS_CHROMIUM")
    if said:
        return said if os.access(said, os.X_OK) else None
    home = Path.home()
    for pattern in (
        # chrome-linux64 since Playwright's chromium-1243 (2026-10); chrome-linux before it. Found
        # the day the new one landed: every browser test here was skipped, quietly, as missing.
        str(home / ".cache/ms-playwright/chromium-*/chrome-linux*/chrome"),
        str(home / "Library/Caches/ms-playwright/chromium-*/chrome-mac/Chromium.app/Contents/MacOS/Chromium"),
    ):
        found = sorted(glob.glob(pattern))
        if found:
            return found[-1]
    for name in ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"):
        path = shutil.which(name)
        if path:
            return path
    return None


def _need(what: str, have: bool) -> None:
    if have:
        return
    if os.environ.get("ARGUS_BROWSER_REQUIRED") == "1":
        pytest.fail(f"browser tests are required here (ARGUS_BROWSER_REQUIRED=1) but {what}")
    pytest.skip(f"browser tests skipped: {what}")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_http(url: str, timeout: float = 20.0) -> None:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            urlopen(url, timeout=1).read()
            return
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f"{url} did not come up in {timeout}s")


# ------------------------------------------------------------------------ sample files

def minimal_pdf(text: str) -> bytes:
    """A one-page PDF with one line of real text, byte offsets and all — enough for pdf.js to
    render it and for pdftotext to find the words."""
    stream = f"BT /F1 24 Tf 72 720 Td ({text}) Tj ET".encode()
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R "
        b"/Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


# A 1x1 red PNG, so a markdown figure has something real to resolve.
PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108020000009077"
    "53de0000000c4944415408d763f8cfc000000301010018dd8db00000000049454e44ae426082"
)


def make_tree(root: Path) -> None:
    (root / "docs" / "img").mkdir(parents=True)
    (root / "docs" / "report.md").write_text(
        "# Report heading\n\nSome **bold** text and a [link](https://example.org).\n\n"
        "![figure](img/dot.png)\n\n```python\nprint('hi')\n```\n\n<script>window.__pwned = 1</script>\n",
        encoding="utf-8")
    (root / "docs" / "img" / "dot.png").write_bytes(PNG)
    (root / "docs" / "paper.pdf").write_bytes(minimal_pdf("Listeria monocytogenes"))
    (root / "notes.txt").write_text("line one\nline two\nneedle in a haystack\n", encoding="utf-8")
    (root / "data.csv").write_text("sample,st\nA,1\nB,9\n", encoding="utf-8")
    (root / "script.py").write_text("def f(x):\n    return x * 2\n", encoding="utf-8")
    (root / "empty-dir").mkdir()
    (root / ".hidden").write_text("secret\n", encoding="utf-8")
    deep = root / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (deep / "deep.txt").write_text("deep\n", encoding="utf-8")
    (root / "big.log").write_text("".join(f"log line {i}\n" for i in range(20000)), encoding="utf-8")


# ------------------------------------------------------------------------ fixtures

class Argus:
    """The running test instance: where it is, what it serves, and its own tmux socket."""

    def __init__(self, url: str, root: Path, socket_name: str, config: Path, proc: subprocess.Popen):
        self.url, self.root, self.socket, self.config, self.proc = url, root, socket_name, config, proc

    def tmux(self, *args: str, check: bool = True) -> subprocess.CompletedProcess:
        assert self.socket.startswith("argus-t-"), "refusing to drive a tmux socket that is not a test one"
        env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
        env["HOME"] = str(self.root / "home")
        return subprocess.run(["tmux", "-L", self.socket, *args], capture_output=True,
                              text=True, check=check, env=env, timeout=10)

    def sessions(self) -> list[str]:
        r = self.tmux("list-sessions", "-F", "#{session_name}", check=False)
        return r.stdout.split() if r.returncode == 0 else []

    def kill_sessions(self) -> None:
        self.tmux("kill-server", check=False)

    def api(self, path: str, method: str = "GET", body: dict | None = None):
        import json
        from urllib.request import Request
        data = json.dumps(body).encode() if body is not None else None
        req = Request(self.url + path, data=data, method=method, headers={
            "Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
        with urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode() or "null")

    def reset_prefs(self) -> None:
        """Preferences live on the server too (/api/prefs), shared by every browser context —
        so a theme one test chose would be the next test's starting point. Every key goes."""
        doc = self.api("/api/prefs")["prefs"]
        if doc:
            self.api("/api/prefs", "PATCH", {"changes": {k: None for k in doc}})
        # And agents "lost" when a previous test killed its tmux server are not this test's.
        lost = [x["name"] for x in self.api("/api/resume")["lost"]]
        if lost:
            self.api("/api/resume/forget", "POST", {"names": lost})


FAKE_CLAUDE = """#!/usr/bin/env python3
import sys, time
if "--help" in sys.argv:
    print("  --dangerously-skip-permissions   Bypass all permission checks.")
    print('  --permission-mode <mode>         (choices: "acceptEdits", "auto", "plan")')
    print("  --model <model>                  an alias (e.g. 'fable', 'opus', or 'sonnet')")
    print("  -c, --continue                   Continue the most recent conversation")
elif "--version" in sys.argv:
    print("9.9.9 (stand-in)")
else:
    print("stand-in agent, waiting", flush=True)
    time.sleep(600)
"""


@pytest.fixture(scope="session")
def argus(tmp_path_factory) -> Argus:
    base = tmp_path_factory.mktemp("argus-browser")
    root = base / "root"
    root.mkdir()
    make_tree(root)
    # A home of its own, inside the root: the tmux config screen edits ~/.tmux.conf, and the
    # shells the tests open in tmux must not run the real ~/.bashrc.
    home = root / "home"
    home.mkdir()
    (home / ".tmux.conf").write_text("set -g history-limit 5000\n", encoding="utf-8")
    # A stand-in for Claude Code: answers --help with the flags the New session box offers, and
    # otherwise sits there like an agent waiting.
    (home / "bin").mkdir()
    fake = home / "bin" / "claude"
    fake.write_text(FAKE_CLAUDE, encoding="utf-8")
    fake.chmod(0o755)
    cfg_dir = base / "config"
    cfg_dir.mkdir()
    config = cfg_dir / "config.yaml"
    port = free_port()
    config.write_text(yaml.safe_dump({
        "token": TOKEN,
        "roots": [str(root)],
        "listen": f"127.0.0.1:{port}",
        "allow_write": True,
        "check_releases": False,
        # Deterministic, and independent of what this machine has installed.
        "launchers": [
            {"name": "A shell", "command": ""},
            {"name": "Echo", "command": "echo argus-launched"},
            {"name": "Missing tool", "command": "argus-no-such-binary-anywhere"},
            {"name": "Claude", "command": str(fake)},
        ],
    }), encoding="utf-8")
    config.chmod(0o600)

    socket_name = f"argus-t-{os.getpid()}-{next(_socket_n)}"
    env = {k: v for k, v in os.environ.items() if k not in ("TMUX", "TMUX_PANE")}
    env["PYTHONUNBUFFERED"] = "1"
    env["HOME"] = str(home)
    # The tests kill their tmux server all the time; the register has to keep up with them.
    env["ARGUS_REGISTER_EVERY"] = "1"
    env["ARGUS_OLD_TOOLS"] = "off"          # the real machine's old copies are not this test's
    log = (base / "argus.log").open("w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "app.main", "--config", str(config), "--socket", socket_name,
         "--listen", f"127.0.0.1:{port}"],
        cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True,
    )
    url = f"http://127.0.0.1:{port}"
    try:
        wait_http(url + "/")
    except RuntimeError:
        proc.kill()
        raise RuntimeError(f"test Argus did not start:\n{(base / 'argus.log').read_text()}")
    instance = Argus(url, root, socket_name, config, proc)
    yield instance
    instance.kill_sessions()
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
    log.close()


ENGINE = os.environ.get("ARGUS_ENGINE", "chromium")


@pytest.fixture(scope="session")
def chromium(tmp_path_factory):
    if ENGINE == "webkit":
        # The same suite in WebKit — Safari, iPhones, argus-bridge's window on a Mac (wkpage.py).
        try:
            from .wkpage import start_webkit
            pw, browser = start_webkit()
        except Exception as e:
            _need(f"no WebKit ({str(e).splitlines()[0]})", False)
        yield {"engine": "webkit", "browser": browser}
        browser.close()
        pw.stop()
        return
    path = find_chromium()
    _need("no Chromium found (set ARGUS_CHROMIUM)", path is not None)
    # Started up to three times: on a busy CI runner one start in a few hundred never opened its port, and
    # every test of that worker errored (the flake hunter, 2026-11-10). Its own output is kept for the message.
    for attempt in range(3):
        profile = tmp_path_factory.mktemp("chromium-profile")
        said = open(profile.parent / f"{profile.name}.log", "wb")
        proc = subprocess.Popen(
            [path, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run",
             "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0",
             # A mouse, as far as CSS can tell: (hover: hover) and (pointer: fine). Without it the
             # desktop layout loses every control that only exists where there is a pointer.
             "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
             f"--user-data-dir={profile}", "--window-size=1400,900", "about:blank"],
            stdout=said, stderr=subprocess.STDOUT, start_new_session=True,
        )
        port_file = profile / "DevToolsActivePort"
        end = time.monotonic() + 20
        # Written in two lines (port, path): read once both are there, not while half written.
        while time.monotonic() < end and not (port_file.exists() and port_file.read_text().count("\n") >= 1):
            time.sleep(0.05)
        said.close()
        if port_file.exists() and port_file.read_text().split():
            break
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        if attempt == 2:
            tail = (profile.parent / f"{profile.name}.log").read_text(errors="replace")[-2000:]
            raise RuntimeError(f"Chromium did not open its debugging port (three tries):\n{tail}")
    port = int(port_file.read_text().split()[0])
    version = http_json(f"http://127.0.0.1:{port}/json/version")
    browser = Session(version["webSocketDebuggerUrl"])
    yield {"port": port, "browser": browser}
    browser.close()
    os.killpg(proc.pid, signal.SIGTERM)
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)


def open_page(chromium, argus: Argus, viewport=DESKTOP, login: bool = True) -> tuple[Page, str, str]:
    if chromium.get("engine") == "webkit":
        from .wkpage import open_webkit_page
        page = open_webkit_page(chromium["browser"], argus.url, viewport)
        page.goto(argus.url + (f"/#token={TOKEN}" if login else "/"))
        return page, f"wk{id(page):x}", ""
    b: Session = chromium["browser"]
    ctx = b.send("Target.createBrowserContext", {"disposeOnDetach": True})["browserContextId"]
    target = b.send("Target.createTarget", {"url": "about:blank", "browserContextId": ctx})["targetId"]
    page = Page(f"ws://127.0.0.1:{chromium['port']}/devtools/page/{target}", argus.url)
    page.viewport(viewport)
    page.goto(argus.url + (f"/#token={TOKEN}" if login else "/"))
    return page, target, ctx


@pytest.hookimpl(wrapper=True)
def pytest_runtest_makereport(item, call):
    """The test's own outcome, kept on it: a page is pictured when its test failed, not only when the page
    itself reported a problem — in CI that picture is the one thing that says what was on screen."""
    report = yield
    if report.when == "call":
        item.failed_call = report.failed
    return report


@pytest.fixture
def make_page(chromium, argus, request, tmp_path):
    """Open as many clean pages as a test needs; each is checked for problems at the end."""
    opened: list[tuple[Page, str, str]] = []

    def make(viewport=DESKTOP, login: bool = True, route: str | None = "#/files") -> Page:
        page, target, ctx = open_page(chromium, argus, viewport, login)
        opened.append((page, target, ctx))
        if login:
            page.wait("!!document.querySelector('#nav') && !document.querySelector('#nav').hidden",
                      what="the app to accept the token")
        if route:
            page.route(route)
        return page

    yield make

    failures = []
    # ARGUS_FAIL_SHOTS (set in CI, uploaded with a failing run): where the pictures of failed tests go.
    shots = Path(os.environ["ARGUS_FAIL_SHOTS"]) if os.environ.get("ARGUS_FAIL_SHOTS") else tmp_path
    for page, target, ctx in opened:
        page.settle(quiet=0.3, timeout=3)
        left = page.problems
        if getattr(request.node, "failed_call", False) and not left:
            try:
                shots.mkdir(parents=True, exist_ok=True)
                page.screenshot(shots / f"{request.node.name}-{target[:6]}.png")
            except Exception:
                pass
        if left:
            shots.mkdir(parents=True, exist_ok=True)
            shot = shots / f"{request.node.name}-{target[:6]}.png"
            try:
                page.screenshot(shot)
            except Exception:
                shot = None
            failures.append("\n    ".join(left) + (f"\n    (screenshot: {shot})" if shot else ""))
        page.close()
        if chromium.get("engine") == "webkit":
            continue
        b: Session = chromium["browser"]
        for method, params in (("Target.closeTarget", {"targetId": target}),
                               ("Target.disposeBrowserContext", {"browserContextId": ctx})):
            try:
                b.send(method, params, timeout=5)
            except Exception:
                pass
    if failures:
        pytest.fail("the page reported problems:\n    " + "\n  ---\n    ".join(failures), pytrace=False)


@pytest.fixture
def page(make_page) -> Page:
    return make_page()


@pytest.fixture(autouse=True)
def _fresh_state(argus):
    """No test inherits another's sessions or preferences."""
    argus.kill_sessions()
    argus.reset_prefs()
    yield
    argus.kill_sessions()
    argus.reset_prefs()

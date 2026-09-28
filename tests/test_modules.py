"""The frontend's module graph, checked without a browser.

static/ is plain ES modules served as files: there is no bundler to refuse a broken import, and
the server answers a missing file with index.html (so an installed PWA can deep-link) — which
the browser then rejects as "not a module", on whichever screen first needed it. And the service
worker keeps a fixed list of files for offline use: a module left off it works online and breaks
an installed app on a train. These are the checks a build step would have made.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

from frontend_source import STATIC, frontend_files

ROOT = STATIC.parent
IMPORT = re.compile(r"""^\s*(?:import|export)\s[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]""", re.M)
DYNAMIC = re.compile(r"""\bimport\(\s*['"]([^'"]+)['"]\s*\)""")


def importmap() -> dict[str, str]:
    html = (STATIC / "index.html").read_text(encoding="utf-8")
    m = re.search(r'<script type="importmap">\s*(\{.*?\})\s*</script>', html, re.S)
    return json.loads(m.group(1))["imports"] if m else {}


def resolve(spec: str, importer: Path) -> Path | None:
    """Where the browser would fetch `spec` from, as a file under static/ — or None for a URL."""
    spec = importmap().get(spec, spec)
    if re.match(r"^[a-z]+:", spec):
        return None
    if spec.startswith("/"):
        return STATIC / spec.lstrip("/")
    if spec.startswith("."):
        return (importer.parent / spec).resolve()
    raise AssertionError(f"{importer.relative_to(ROOT)} imports the bare name {spec!r}, which no import map resolves")


def imports_of(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8")
    return [a or b for a, b in IMPORT.findall(text)] + DYNAMIC.findall(text)


def graph() -> dict[Path, list[Path]]:
    """Every module reachable from app.js, and what each imports (vendor files included)."""
    seen: dict[Path, list[Path]] = {}
    todo = [STATIC / "app.js"]
    while todo:
        here = todo.pop()
        if here in seen:
            continue
        seen[here] = []
        if "vendor" in here.relative_to(STATIC).parts:
            continue                      # a vendored library's own imports are its business
        for spec in imports_of(here):
            there = resolve(spec, here)
            if there is None:
                continue
            seen[here].append(there)
            todo.append(there)
    return seen


def test_every_import_is_a_file_that_exists():
    for here, targets in graph().items():
        for there in targets:
            assert there.is_file(), f"{here.relative_to(ROOT)} imports {there.relative_to(ROOT)}, which does not exist"
            assert STATIC in there.parents, f"{here.relative_to(ROOT)} imports from outside static/: {there}"


def test_every_module_of_ours_is_reachable_from_app_js():
    """A module nobody imports is dead code — or a move that forgot its import line."""
    reachable = set(graph())
    for path in frontend_files():
        assert path in reachable, f"{path.relative_to(ROOT)} is not imported by anything reachable from app.js"


def test_the_service_worker_caches_every_module_the_app_loads_at_start():
    sw = (STATIC / "sw.js").read_text(encoding="utf-8")
    shell = set(re.findall(r"^\s*'(/[^']*)',?\s*$", sw.split("const SHELL = [", 1)[1].split("];", 1)[0], re.M))
    for path in graph():
        rel = "/" + path.relative_to(STATIC).as_posix()
        if rel.startswith("/vendor/") and rel not in {"/vendor/xterm-6.0.0/xterm.mjs", "/vendor/xterm-6.0.0/addon-fit.mjs"}:
            continue                      # big libraries loaded on demand are fetched, not precached
        assert rel in shell, f"{rel} is loaded by the app but missing from SHELL in static/sw.js"
    for rel in shell:
        assert (STATIC / rel.lstrip("/")).is_file() or rel == "/", f"SHELL in sw.js lists {rel}, which does not exist"


def test_no_import_cycle_touches_app_js():
    """app.js is the boot: it runs last and may import anything, but nothing may import it back.
    A module that imports app.js would run before app.js finished — every top-level `const` in
    app.js is then in its temporal dead zone, and the page dies at load."""
    for here, targets in graph().items():
        assert STATIC / "app.js" not in targets or here == STATIC / "app.js", \
            f"{here.relative_to(ROOT)} imports app.js — that is a cycle through the boot module"


def eslint() -> Path | None:
    local = ROOT / "node_modules" / ".bin" / "eslint"
    return local if local.exists() else None


def test_eslint_finds_nothing():
    """Correctness rules only (eslint.config.js): above all `no-undef` — a name a module uses but
    neither declares nor imports — and `no-import-assign`, both of which otherwise fail only
    when that line runs."""
    found = eslint()
    if not found:
        if os.environ.get("ARGUS_BROWSER_REQUIRED") == "1" or os.environ.get("ARGUS_LINT_REQUIRED") == "1":
            pytest.fail("eslint is required here but node_modules is missing: run `npm ci`")
        if not shutil.which("node"):
            pytest.skip("no node on this machine; the lint runs where there is one")
        pytest.skip("eslint not installed: run `npm ci` (development only, the app needs none of it)")
    done = subprocess.run([str(found), "--max-warnings=0", "static"], cwd=ROOT,
                          capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, "eslint:\n" + done.stdout + done.stderr


def test_code_that_runs_at_load_reads_other_modules_only_if_they_are_leaves():
    """The sections import each other in circles, so evaluation order is no longer file order.
    Top-level code that reads a const/let of a module that imports things of ours may run before
    that module has initialised it — "Cannot access 'prefs' before initialization", and a page
    that never starts. Reads at load are only safe from a leaf (static/js/state.js), which is
    evaluated completely the first time anything reaches it. See tests/js/loadorder.mjs."""
    node = shutil.which("node")
    if not node or not (ROOT / "node_modules" / "espree").exists():
        if os.environ.get("ARGUS_BROWSER_REQUIRED") == "1" or os.environ.get("ARGUS_LINT_REQUIRED") == "1":
            pytest.fail("the load-order check is required here: run `npm ci`")
        pytest.skip("needs node and `npm ci` (espree), development only")
    done = subprocess.run([node, str(ROOT / "tests" / "js" / "loadorder.mjs"), str(STATIC)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, (
        "top-level code reads another module's binding while modules are still loading — move "
        "the binding into a leaf module (state.js) or read it inside a function:\n" + done.stdout + done.stderr)

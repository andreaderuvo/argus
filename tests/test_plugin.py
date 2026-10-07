"""The Argus plugin (`plugin/`, `.claude-plugin/marketplace.json`): one directory that installs in
Claude Code and in Codex (which reads `.claude-plugin/plugin.json`, measured on 0.160), plus a
Gemini extension manifest.

What was measured, on 2026-10-06: Claude Code loaded it with `--plugin-dir`, its hooks rang a
throwaway Argus and its MCP `who` answered; Codex installed it from this repository as a local
marketplace, its hooks rang (with hook review bypassed for the run), and its MCP server started —
but only once the command no longer depended on `${CLAUDE_PLUGIN_ROOT}`, which Codex expands in
hooks and not in `.mcp.json`. That is why the MCP command is a small `sh -c` that finds the
plugin either way. These tests keep what was measured from drifting.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin"


def test_the_scripts_in_the_plugin_are_the_ones_in_tools():
    """Copies, not links: an installed plugin is copied into the agent's cache, and a link out of
    the plugin's directory would point at nothing there."""
    for name in ("argus-bell", "argus_client.py", "argus_mcp.py"):
        assert (PLUGIN / "bin" / name).read_bytes() == (ROOT / "tools" / name).read_bytes(), \
            f"plugin/bin/{name} differs from tools/{name}: cp tools/{name} plugin/bin/"
    for name in ("argus-bell", "argus-mcp"):
        assert os.access(PLUGIN / "bin" / name, os.X_OK)


def test_the_manifests_agree():
    plugin = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())
    market = json.loads((ROOT / ".claude-plugin" / "marketplace.json").read_text())
    gemini = json.loads((PLUGIN / "gemini-extension.json").read_text())
    assert plugin["name"] == market["name"] == gemini["name"] == "argus"
    assert market["plugins"][0] == {**market["plugins"][0], "name": "argus", "source": "./plugin"}
    assert plugin["version"] == gemini["version"]
    assert gemini["mcpServers"]["argus"]["command"] == "${extensionPath}/bin/argus-mcp"


def test_the_hooks_say_start_done_and_asking():
    hooks = json.loads((PLUGIN / "hooks" / "hooks.json").read_text())["hooks"]
    said = {event: groups[0]["hooks"][0]["command"] for event, groups in hooks.items()}
    assert said == {
        "UserPromptSubmit": '"${CLAUDE_PLUGIN_ROOT}/bin/argus-bell" start',
        "Stop": '"${CLAUDE_PLUGIN_ROOT}/bin/argus-stop"',              # a team's guard, else the bell
        "Notification": '"${CLAUDE_PLUGIN_ROOT}/bin/argus-bell" asking',      # Claude
        "PermissionRequest": '"${CLAUDE_PLUGIN_ROOT}/bin/argus-bell" asking',  # Codex (and Claude)
        "SessionStart": '"${CLAUDE_PLUGIN_ROOT}/bin/argus-check"',            # a newer plugin? say so
    }


def run_mcp_command(env_extra: dict, cwd: Path) -> dict:
    """Start the plugin's MCP command the way an agent would and ask it to initialize."""
    spec = json.loads((PLUGIN / ".mcp.json").read_text())["mcpServers"]["argus"]
    env = {k: v for k, v in os.environ.items() if k not in ("CLAUDE_PLUGIN_ROOT", "CODEX_HOME")} | env_extra
    hello = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18"}})
    done = subprocess.run([spec["command"], *spec["args"]], input=hello + "\n", capture_output=True, text=True,
                          env=env, cwd=cwd, timeout=20)
    return json.loads(done.stdout.splitlines()[0])


def test_the_mcp_command_as_claude_runs_it(tmp_path):
    """Claude replaces ${CLAUDE_PLUGIN_ROOT} in the arguments before anything runs."""
    spec = json.loads((PLUGIN / ".mcp.json").read_text())["mcpServers"]["argus"]
    args = [a.replace("${CLAUDE_PLUGIN_ROOT}", str(PLUGIN)) for a in spec["args"]]
    hello = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    done = subprocess.run([spec["command"], *args], input=hello + "\n", capture_output=True, text=True, cwd=tmp_path, timeout=20)
    assert json.loads(done.stdout.splitlines()[0])["result"]["serverInfo"]["name"] == "argus"


def test_the_mcp_command_as_codex_runs_it(tmp_path):
    """Codex leaves ${CLAUDE_PLUGIN_ROOT} to the shell, where it is empty: the command finds the
    copy Codex installed under $CODEX_HOME/plugins/cache/argus/argus/<version>/."""
    cache = tmp_path / "codex" / "plugins" / "cache" / "argus" / "argus" / "0.1.0"
    shutil.copytree(PLUGIN, cache)
    said = run_mcp_command({"CODEX_HOME": str(tmp_path / "codex")}, tmp_path)
    assert said["result"]["serverInfo"]["name"] == "argus"


@pytest.mark.skipif(shutil.which("claude") is None, reason="needs Claude Code")
def test_claude_validates_both_manifests():
    for target in (PLUGIN, ROOT):
        done = subprocess.run(["claude", "plugin", "validate", "--strict", str(target)], capture_output=True,
                              text=True, timeout=60, stdin=subprocess.DEVNULL)
        assert done.returncode == 0, done.stdout + done.stderr


# What the plugin's files hashed to, per version. An agent updates an installed plugin only when its
# version changes: on 2026-10-06 rename_desk was added under the same 0.1.0 and '/plugin update'
# kept the old copy, without the tool. Change anything in plugin/ and this fails until the version
# goes up and its hash is added here.
RELEASED = {"0.1.1": "0c47653f71ed8691", "0.1.2": "119c80ea223b38c1", "0.1.3": "6a94fa2f84f0fb7f", "0.1.4": "c2d4b0c927f765f0", "0.1.5": "825cf3dc981918fe", "0.1.6": "b25847a26f5cbf2f", "0.1.7": "d88abaa232d82332", "0.1.8": "206de9ba5939dd39", "0.1.9": "9085fca9d6aca6d7", "0.1.10": "e96fde2fe3ff36ed", "0.1.11": "ccede2ff0451c374", "0.1.12": "b887cd2a7560c29c", "0.1.13": "5e270e6f6f88fab5"}


def plugin_hash() -> str:
    import hashlib
    # What is in git, not what running it leaves behind: the tests import plugin/bin/argus_client,
    # and the __pycache__ that leaves differs per Python, so GitHub's two Pythons never agreed.
    files = sorted(f for f in PLUGIN.rglob("*") if f.is_file() and f.name not in ("plugin.json", "gemini-extension.json")
                   and "__pycache__" not in f.parts and f.suffix != ".pyc")
    lines = "".join(f"{hashlib.sha256(f.read_bytes()).hexdigest()}  ./{f.relative_to(PLUGIN)}\n" for f in files)
    return hashlib.sha256(lines.encode()).hexdigest()[:16]


def test_a_changed_plugin_has_a_new_version():
    version = json.loads((PLUGIN / ".claude-plugin" / "plugin.json").read_text())["version"]
    assert version in RELEASED, f"plugin/ is at {version}, which is not in RELEASED: add it with its hash {plugin_hash()}"
    assert RELEASED[version] == plugin_hash(), \
        f"plugin/ changed since {version} was released: raise the version in plugin.json and gemini-extension.json, and add its hash {plugin_hash()}"


def _serve(answer):
    """A stand-in Argus on loopback answering every GET with `answer` and recording what it got."""
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer
    got = []

    class H(BaseHTTPRequestHandler):
        def do_GET(self):
            got.append(("GET", self.path))
            body = json.dumps(answer).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            got.append(("POST", self.path, self.rfile.read(int(self.headers.get("content-length") or 0)).decode()))
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *a):
            pass

    server = HTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, got


def test_the_stop_guard_holds_an_agent_with_a_turn_to_report(tmp_path):
    server, got = _serve({"expecting": True, "reason": "You are quant in the Argus team K and have not reported this turn."})
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "ARGUS_TOKEN": "t", "ARGUS_SESSION": "K-quant",
           "ARGUS_URL": f"http://127.0.0.1:{server.server_port}"}
    out = subprocess.run([str(PLUGIN / "bin" / "argus-stop")], input="{}", capture_output=True, text=True, env=env, timeout=15).stdout
    said = json.loads(out)
    assert said["decision"] == "block" and "not reported this turn" in said["reason"]
    assert got[0][0] == "GET" and got[0][1].startswith("/api/teams/expecting?session=K-quant")
    assert not any(g[0] == "POST" for g in got), "held: no bell rung"
    server.shutdown()


def test_the_stop_guard_otherwise_rings_as_before(tmp_path):
    server, got = _serve({"expecting": False})
    env = {"PATH": "/usr/bin:/bin", "HOME": str(tmp_path), "ARGUS_TOKEN": "t", "ARGUS_SESSION": "K-quant",
           "ARGUS_URL": f"http://127.0.0.1:{server.server_port}"}
    out = subprocess.run([str(PLUGIN / "bin" / "argus-stop")], input='{"hook_event_name": "Stop", "last_assistant_message": "done it"}',
                         capture_output=True, text=True, env=env, timeout=15).stdout
    assert out.strip() == ""
    posts = [g for g in got if g[0] == "POST"]
    assert posts and posts[0][1] == "/api/bell" and '"why":"done"' in posts[0][2] and "done it" in posts[0][2]
    server.shutdown()


def test_the_scripts_find_argus_from_its_config(tmp_path):
    """Its own listen line, and https when it has a certificate — not a fixed http://127.0.0.1:8090."""
    conf = tmp_path / "c.yaml"
    seen = tmp_path / "seen"
    curl = tmp_path / "curl"
    curl.write_text(f'#!/bin/sh\nfor a; do case "$a" in http*) echo "$a" >> {seen};; esac; done\n')
    curl.chmod(0o755)
    env = {"PATH": f"{tmp_path}:/usr/bin:/bin", "HOME": str(tmp_path), "ARGUS_CONFIG": str(conf), "ARGUS_TOKEN": "t"}
    conf.write_text("listen: 0.0.0.0:8443\ntls_cert: /etc/x.pem\ntls_key: /etc/x.key\n")
    subprocess.run([str(PLUGIN / "bin" / "argus-bell"), "done"], input="", env=env, timeout=10)
    conf.write_text("listen: 127.0.0.1:9000\ntls_cert: null\n")
    subprocess.run([str(PLUGIN / "bin" / "argus-bell"), "done"], input="", env=env, timeout=10)
    calls = seen.read_text().split()
    assert [c for c in calls if c.endswith("/api/bell")] == ["https://127.0.0.1:8443/api/bell", "http://127.0.0.1:9000/api/bell"]
    # Outside tmux, the session is asked of the same Argus by pid first.
    assert [c.split("?")[0] for c in calls if "whoami" in c] == ["https://127.0.0.1:8443/api/tmux/whoami", "http://127.0.0.1:9000/api/tmux/whoami"]

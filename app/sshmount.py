"""Mounting a folder of this machine on your own computer, over SSH — what the wizard needs.

The browser asks where to reach this machine (`info`: the user Argus runs as, the names and
addresses it answers to, the SSH port) to write the commands for macOS, Linux and Windows; and can
hand over a public key so that ssh, sshfs and Mutagen never ask for a password (`authorize`).

Authorizing a key gives that key a shell here. Whoever holds Argus's full token has a terminal on
this machine already, so it is no new power — but it is only for that token (never an agent's,
never a watcher's), only a well-formed public key, appended once, and the journal records the call.
"""

from __future__ import annotations

import getpass
import os
import re
import socket
from pathlib import Path

KEY = re.compile(r"^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|"
                 r"sk-ecdsa-sha2-nistp256@openssh\.com) ([A-Za-z0-9+/]{40,}={0,3})(?: ([^\r\n]{0,200}))?$")


class BadKey(Exception):
    """Not one public key we can add."""


def ssh_port(config: Path = Path("/etc/ssh/sshd_config")) -> int:
    """The port sshd listens on, when its config says and we may read it; 22 otherwise."""
    try:
        for line in config.read_text(encoding="utf-8", errors="replace").splitlines():
            m = re.match(r"\s*Port\s+(\d+)", line)
            if m:
                return int(m.group(1))
    except OSError:
        pass
    return 22


def info(addresses: list[str], preferred: str = "") -> dict:
    """`{user, hosts, host, port}` — `host` the one to write in the commands first."""
    hosts = [h for h in [preferred, *addresses, socket.getfqdn()] if h]
    hosts = list(dict.fromkeys(hosts))
    # A name before an address: it survives a change of IP, and it is what a person recognises.
    named = [h for h in hosts if not re.match(r"^\d+\.\d+\.\d+\.\d+$", h)]
    return {"user": getpass.getuser(), "hosts": hosts, "host": preferred or (named or hosts or ["localhost"])[0],
            "port": ssh_port()}


def authorize(key_text: str, home: Path | None = None) -> dict:
    """Append one public key to ~/.ssh/authorized_keys of the user Argus runs as, unless it is
    there already. `{added, already, fingerprint_hint}`."""
    line = " ".join(str(key_text or "").strip().split())
    m = KEY.match(line)
    if not m or "\n" in str(key_text).strip():
        raise BadKey("that is not a public key — paste the one line of your id_ed25519.pub (or id_rsa.pub)")
    kind, body, comment = m.group(1), m.group(2), (m.group(3) or "").strip()
    home = home or Path.home()
    ssh = home / ".ssh"
    ssh.mkdir(mode=0o700, exist_ok=True)
    os.chmod(ssh, 0o700)
    keys = ssh / "authorized_keys"
    have = keys.read_text(encoding="utf-8", errors="replace") if keys.exists() else ""
    hint = f"{kind} …{body[-12:]}" + (f" {comment}" if comment else "")
    if any(f"{kind} {body}" in existing for existing in have.splitlines()):
        return {"added": False, "already": True, "key": hint}
    entry = f"{kind} {body} {comment or 'added through Argus'}".rstrip()
    with keys.open("a", encoding="utf-8") as f:
        if have and not have.endswith("\n"):
            f.write("\n")
        f.write(entry + "\n")
    os.chmod(keys, 0o600)
    return {"added": True, "already": False, "key": hint}


# ------------------------------------------------------------------- one command does it all
#
# The wizard's fastest way: a link made for one folder, used once, for fifteen minutes. The script
# behind it makes a key if there is none, hands the public half back to the link (which lets it in,
# once), installs the mounting tool if missing, and mounts the folder. The link is the secret; it
# carries nothing secret, and it can let in one public key, no more.

import secrets
import time as _time

SETUP_TTL = 15 * 60


class Setups:
    def __init__(self) -> None:
        self.live: dict[str, dict] = {}

    def make(self, spec: dict) -> str:
        now = _time.time()
        for k in [k for k, v in self.live.items() if v["until"] < now]:
            del self.live[k]
        ident = secrets.token_hex(16)
        self.live[ident] = {**spec, "until": now + SETUP_TTL, "keyed": False}
        return ident

    def get(self, ident: str) -> dict | None:
        one = self.live.get(ident)
        if not one or one["until"] < _time.time():
            self.live.pop(ident, None)
            return None
        return one


def _sh_quote(s: str) -> str:
    return "'" + str(s).replace("'", "'\\''") + "'"


def script_sh(spec: dict, base: str, ident: str) -> str:
    """macOS and Linux: one `curl … | sh`."""
    at = f"{spec['user']}@{spec['host']}"
    port = int(spec.get("port") or 22)
    point = spec["point"].replace("~", "$HOME", 1) if spec["point"].startswith("~") else spec["point"]
    name = spec["name"]
    return f"""#!/bin/sh
# Argus: mount {spec['path']} from {spec['host']} here. Made for you, usable once, for 15 minutes.
set -e
KEY="$HOME/.ssh/id_ed25519"
mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
if [ ! -f "$KEY.pub" ]; then
  echo "· making an SSH key (no passphrase) in $KEY"
  ssh-keygen -t ed25519 -N "" -f "$KEY" -q
fi
echo "· letting the key in on {spec['host']}"
curl -fsS -k -X POST --data-binary @"$KEY.pub" {_sh_quote(base + '/ssh-setup/' + ident + '/key')} >/dev/null
if ! command -v sshfs >/dev/null 2>&1; then
  echo "· installing sshfs"
  if [ "$(uname)" = Darwin ]; then
    command -v brew >/dev/null 2>&1 || {{ echo "Homebrew is needed first: https://brew.sh"; exit 1; }}
    brew install macos-fuse-t/homebrew-cask/fuse-t macos-fuse-t/homebrew-cask/fuse-t-sshfs
  elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y sshfs
  elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y fuse-sshfs
  else echo "install sshfs with your package manager, then run this again"; exit 1
  fi
fi
POINT="{point}"
mkdir -p "$POINT"
echo "· mounting {spec['path']} at $POINT"
if [ "$(uname)" = Darwin ]; then OPTS="volname={name},noappledouble,"; else OPTS=""; fi
sshfs -p {port} {at}:{_sh_quote(spec['path'])} "$POINT" -o "${{OPTS}}reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,StrictHostKeyChecking=accept-new,IdentityFile=$KEY"
echo "✓ mounted at $POINT — unmount with: umount \\"$POINT\\""
[ "$(uname)" = Darwin ] && open "$POINT" || true
"""


def script_ps1(spec: dict, base: str, ident: str) -> str:
    """Windows: one `irm … | iex` in PowerShell. SSHFS-Win reads the key from id_rsa."""
    at = f"{spec['user']}@{spec['host']}"
    port = int(spec.get("port") or 22)
    win = spec["path"].lstrip("/").replace("/", "\\")
    drive = spec.get("drive") or "Z:"
    host_part = at + (f"!{port}" if port != 22 else "")
    return f"""# Argus: mount {spec['path']} from {spec['host']} as {drive}. Made for you, usable once, for 15 minutes.
$ErrorActionPreference = 'Stop'
$key = "$env:USERPROFILE\\.ssh\\id_rsa"
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\\.ssh" | Out-Null
if (!(Test-Path "$key.pub")) {{
  Write-Host "· making an SSH key in $key"
  ssh-keygen -t rsa -b 4096 -N '""' -f $key -q
}}
Write-Host "· letting the key in on {spec['host']}"
try {{ [System.Net.ServicePointManager]::ServerCertificateValidationCallback = {{ $true }} }} catch {{}}
Invoke-RestMethod -Method Post -Uri '{base}/ssh-setup/{ident}/key' -InFile "$key.pub" -ContentType 'text/plain' | Out-Null
if (!(Test-Path "$env:ProgramFiles\\SSHFS-Win")) {{
  Write-Host "· installing WinFsp and SSHFS-Win"
  winget install -e --id WinFsp.WinFsp --accept-source-agreements --accept-package-agreements
  winget install -e --id SSHFS-Win.SSHFS-Win --accept-source-agreements --accept-package-agreements
}}
Write-Host "· mounting {spec['path']} as {drive}"
net use {drive} '\\\\sshfs.kr\\{host_part}\\{win}'
Write-Host "✓ mounted as {drive} — unmount with: net use {drive} /delete"
explorer.exe {drive}\\
"""

<div align="center">

<img src="static/icon-512.png" width="112" alt="Argus — the hundred-eyed watchman">

# Argus

### The workspace around your existing AI agents

**Any CLI. Any tmux session. Terminal, files, reports and hand-offs together — on your
desktop or your phone.**

Argus does not replace tmux or wrap your agent in a new runtime. It attaches to the sessions
you already run, whether they contain Claude Code, Codex, Gemini, a test suite or a long shell
script. Stop Argus and every session carries on.

![Three agents working on one job, with their files beside them](docs/img/desks.gif)

[![tests](https://github.com/andreaderuvo/argus/actions/workflows/tests.yml/badge.svg)](https://github.com/andreaderuvo/argus/actions/workflows/tests.yml)
[![install](https://github.com/andreaderuvo/argus/actions/workflows/install.yml/badge.svg)](https://github.com/andreaderuvo/argus/actions/workflows/install.yml)
[![Python 3.11+](https://img.shields.io/badge/python-3.11%2B-3776ab?logo=python&logoColor=white)](https://www.python.org/)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[See the product tour](https://andreaderuvo.github.io/argus/)** ·
**[Install](#install)** · **[Documentation](https://github.com/andreaderuvo/argus/wiki)**

</div>

## Why Argus

Coding agents increasingly work for minutes or hours while your job becomes supervising,
unblocking and reviewing. An editor is excellent while you write code; it is a poor control
room for several terminals and the artifacts they produce.

Argus keeps tmux as the source of truth and adds the missing workspace around it:

- attach to real, already-running sessions through a PTY;
- see which agent is working, finished or waiting for you, with optional ntfy delivery when
  the browser is closed;
- open a path printed in the terminal with one click;
- inspect Markdown, PDF, Word, logs, images and source beside the session;
- launch agents in a folder or isolated git worktree with the first prompt ready;
- hand work between different agents without requiring a shared SDK;
- arrange sessions and files into persistent desks;
- use the same workspace from a phone, including a mobile terminal keyboard;
- expose no repository, prompt or session to a hosted control plane.

| | Argus | Agent-specific remote control | Browser terminal |
|---|---|---|---|
| Existing tmux sessions | Yes | Usually no | Sometimes |
| Claude, Codex, Gemini and any CLI | Yes | One ecosystem | Yes |
| Files and rendered reports beside the terminal | Yes | Limited | No |
| Multi-agent hand-offs and worktrees | Yes | No | No |
| Self-hosted, no account or cloud relay | Yes | No | Varies |

## Install

Argus needs Python 3.11+ and tmux. Linux and macOS run it natively; Windows runs it inside
WSL.

### Installer

Inspect the script, then run it:

```bash
curl -fsSLO https://raw.githubusercontent.com/andreaderuvo/argus/master/install.sh
less install.sh
bash install.sh
argus --allow-write
```

It installs under `~/.local/share/argus`, uses no `sudo`, and leaves configuration in
`~/.config/argus`. Run it again to update, add `--service` for a systemd user service, or run
`bash install.sh uninstall` to remove the application.

### From source

```bash
git clone https://github.com/andreaderuvo/argus.git
cd argus
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m app.main --allow-write
```

### Container

```bash
ARGUS_UID=$(id -u) ARGUS_GID=$(id -g) docker compose up -d
docker compose logs argus
```

The container is packaging, not a sandbox: to reach the host's tmux sessions it needs the
host tmux socket, matching user ID, process namespace and home-directory path. Read the
[container notes](docker-compose.yml) before deploying it.
Versioned `amd64`/`arm64` images are public at
[`ghcr.io/andreaderuvo/argus`](https://github.com/andreaderuvo/argus/pkgs/container/argus);
the Compose file shows how to switch from a local build to the released image.

The first run prints a URL containing a fresh 64-character token. `--qr` prints a QR code for
opening it on a phone.

## Safe by default

> [!WARNING]
> Argus is remote shell access in a browser. Anyone holding a full access token can act as the
> account running it. Keep it on loopback, a trusted LAN, behind a VPN such as Tailscale, or
> behind an SSH tunnel. Never expose its HTTP port directly to the public internet.

Argus starts on `127.0.0.1`, file writes and the local-port proxy are disabled by default,
paths are confined to configured roots, and phones can receive individually revocable device
tokens. Separate restricted tokens let agents ring, ask questions and hand off work without
receiving browser or shell authority.

Read the [security model](https://github.com/andreaderuvo/argus/wiki/Security) and the
[private vulnerability policy](SECURITY.md) before making it reachable from another machine.

## Argus Fleet, powered by Panoptes

Argus is the workspace for one machine. **[Panoptes](https://github.com/andreaderuvo/panoptes)**
is its fleet board: every Argus machine on one page, ordered by which one needs you. It holds
restricted watcher keys and never sends a machine key to the browser.

Use Argus alone first. Add Panoptes when opening one tab per machine stops scaling.

## Project status

Argus is pre-1.0 and used daily, with 500+ tests across supported Python versions plus
installer checks on Linux and macOS. Configuration keys and API shapes may still change
between minor releases; the tmux sessions and files being observed remain independent of
Argus.

- [Changelog](CHANGELOG.md)
- [0.2 adoption roadmap](https://github.com/andreaderuvo/argus/milestone/1)
- [Full documentation](https://github.com/andreaderuvo/argus/wiki)
- [OpenAPI reference](https://andreaderuvo.github.io/argus/api.html)
- [Report a bug](https://github.com/andreaderuvo/argus/issues/new?template=bug_report.yml)
- [Contribute](CONTRIBUTING.md)

If Argus improves your workflow, a GitHub star helps other people find it. More importantly,
tell us what was confusing or broke on your machine.

## License

MIT. Vendored browser libraries retain their upstream MIT, BSD-3-Clause or Apache-2.0
licenses under `static/vendor/`.

<div align="center">

<img src="static/icon-512.png" width="128" alt="Argus — the hundred-eyed watchman">

# Argus

**The cockpit for work you no longer type yourself.**

*Your agents run in tmux. Argus is where you watch them, answer them, and look at what
they produced — the log, the plot, the report — from a desk or from a phone.*

[![tests](https://github.com/andreaderuvo/argus/actions/workflows/tests.yml/badge.svg)](https://github.com/andreaderuvo/argus/actions/workflows/tests.yml)
[![python](https://img.shields.io/badge/python-3.11%2B-3776ab?logo=python&logoColor=white)](https://www.python.org/)
[![licence](https://img.shields.io/badge/licence-MIT-blue)](LICENSE)
[![no build step](https://img.shields.io/badge/build%20step-none-8fd6a0)](#running-it)
[![tmux](https://img.shields.io/badge/tmux-real%20PTY-1bb91f)](#sessions-and-the-terminal)

*Named for the herdsman of a hundred eyes, who was set to watch and never slept.*

</div>

> [!WARNING]
> **Early days.** It is used daily on the machine it was written for, and it changes most
> days: expect rough edges, expect settings to move. More importantly, **Argus is remote
> shell access** — anyone with the token can run anything you can. Read
> [Security](#security) and [Reaching it from outside](#reaching-it-from-outside) before
> putting it anywhere but a trusted network.

![Two agents working in tmux, the folder they are writing into, and the report they produced, all in one workspace](docs/img/agents.png)

## In a minute

```bash
pip install -r requirements.txt
python3 -m app.main --allow-write        # prints a URL with a token in it
```

Open that URL, or scan the QR code it can print, and the phone is in. That is the whole
setup: no build step, no database, no agent to install anywhere, and **nothing changes
about how you use tmux** — Argus attaches to the sessions you already have, the same way
another terminal window would, and leaves them running when you close the tab.

## Why this exists

An editor is built for the hours you spend writing code. More and more of that work is
now done by an agent that runs for two hours in a tmux session, and what is left for you
is a different job: keeping an eye on it, unblocking it when it asks something, and
judging what came out — the log, the table, the figure, the document.

That job needs almost nothing an editor is good at, and one thing it is bad at: being
somewhere else. The work carries on when you close the laptop, so the useful question is
what you can do from the train. Today the answer is an SSH client on a phone — a keyboard
that eats a third of the screen, a terminal that turns to confetti when you rotate it, no
way to look at the log *and* the plot at once, and no answer at all to "is the disk full
again?".

Argus is the other way round. The machine serves a small web app; the phone is just a
browser. You reattach to the session that was already running — not a new one — read what
it printed, answer it, and close the tab. The session never notices.

**The point is what sits next to the terminal.** An agent's output is mostly *references*
to things: a path it wrote, a report it generated, a number in a file. So the terminal and
the filesystem are the same room here:

- a path printed in the session is **clickable** — it opens beside the terminal, and the
  file browser jumps to it and marks it
- a file the agent writes **appears on its own**, without you refreshing anything
- the thing it wrote is **readable in place**: markdown with its figures, PDF with a
  search box, Word, images, a log that starts at the end
- a screenshot you paste lands in the folder you are looking at and **hands you back its
  path**, ready to paste into the session as the next instruction

None of this runs the agent or knows anything about it. Argus attaches to the tmux session
it already lives in, the way another terminal window would.

## What it is not

- **Not a tmux replacement.** It attaches as an ordinary client. Kill Argus and every
  session carries on; the app has no state your work depends on.
- **Not multi-user.** One token, one machine, one person's work. There are no accounts.
- **Not a hardened public service.** It is remote shell access wearing a browser. Run it
  on a LAN or behind a VPN, and read the [security](#security) section before anything
  else.

## Screenshots

| | |
|---|---|
| ![A workspace holding a terminal, a file browser and a log](docs/img/desk.png) | ![A session attached, with a key bar for the modifiers a phone lacks](docs/img/terminal.png) |
| Windows you arrange yourself, snapping to each other | A real PTY, not a poll of `capture-pane` |
| ![The file tree](docs/img/files.png) | ![A rendered markdown document](docs/img/preview.png) |
| Files as a list or a tree, with icons and sizes on demand | Markdown, PDF, Word, images, logs — rendered, not downloaded |
| ![The machine at a glance](docs/img/system.png) | ![A session on a phone](docs/img/phone-terminal.png) |
| CPU, memory, swap, GPUs, disks, listening ports | The same session, on the device you actually have with you |

<sub>The screenshots come from a demo instance with fabricated sessions, files and
services.</sub>

## Features

### Sessions and the terminal

- **Attach to the sessions that already exist**, or start new ones. Detaching leaves
  everything running; a dropped connection reattaches by itself.
- **A real pseudo-terminal.** `pty.openpty` → `login_tty` → `tmux attach`, so anything
  that works in a terminal works here: full-screen programs, colour, mouse mode.
- **A key bar for what a phone has not got** — Esc, Tab, arrows, `^B` (the tmux prefix),
  `^C`, `^D`, and a sticky Ctrl for everything else.
- **Sizing you decide.** Two clients on one session cannot both pick the size, so the
  size is *claimed*: ⤢ takes it for the screen you are looking at, and the lock beside it
  says "I am only watching" — the desk keeps its geometry and the phone shrinks the type
  to fit the whole grid.
- **Copy out of tmux.** A selection made with tmux's mouse mode lands in a paste buffer
  on the server, where a browser cannot reach it. The copy button brings it to the
  clipboard of the device in your hand — even over plain HTTP, where the clipboard API
  does not exist.
- **Clickable paths.** Hovering a line asks the server which of its words are real files;
  those get underlined, and opening one shows it in the viewer *and* points the file
  browser at it. Relative paths resolve against the pane's own working directory. On a
  phone, a long press does the same.

### Files

- Browse, search, rename, move, copy, delete, upload (drag and drop), make folders.
  All of it off by default: `allow_write` turns it on.
- **Paste a screenshot straight into a folder.** Ctrl+V in a listing writes the clipboard
  image where you are looking, named `screenshot-1.png`, `screenshot-2.png` — the number
  is the server's, so nothing is ever overwritten and two devices cannot collide.
- **List or tree**, hidden files on or off, favourites — kept on the server, so both
  devices see the same ones.
- **Two panes** side by side; either one can be a window in a workspace.
- **What a folder weighs**, on request: a button per folder, because finding out means
  walking it. It stops at 400k entries or twenty seconds and says "at least" rather than
  presenting a partial sum as the total.
- **Text files are editable**, with a save that refuses if the file changed underneath —
  the normal case when a job is writing to it.

### Documents

- **Markdown** rendered, with a source toggle, and the figures beside it on disk shown
  where they belong — `![](results/plot.png)` resolves against the document's own folder.
- **PDF** in the browser's own viewer, with a search box that Argus answers itself:
  inside an iframe Ctrl+F searches the page around the document, and a phone has no
  Ctrl+F at all, so the text is extracted here and each hit jumps the viewer to its page.
- **Word/ODT/RTF** rendered through pandoc when the machine has it, with figures inlined
  — and the plain-text extraction as a fallback when it does not.
- **Logs**: a file too big to send whole arrives as its tail, which is the part anyone
  wants, and says so.
- Every previewed document is sandboxed into an opaque origin, so a stray HTML report
  cannot read the access token.

### Workspaces and windows

- **Desks (tabs)** you can name, colour, reorder by dragging, and pin. Each holds its own
  set of windows, has its own address (`#/wall?ws=3`, copyable from the tab menu) and its
  own starting folder, and survives a reload.
- **Windows** for terminals, file browsers, documents and proxied web pages. Move or
  duplicate them between desks.
- **Magnetic layout**: windows snap to each other and to the wall's edges, with a preview
  of where the drop will land — including into the gap between two windows, which it
  fills exactly.
- **Shared edges behave as splitters**: widen one column and the next gives up precisely
  what the first one took.
- Tile as a grid, columns or rows when you want to start over.

### The machine

- CPU, load, memory, swap, GPUs (temperature and memory), every disk, and uptime — each
  with a plain reading of whether it is fine, and a note on *why* swap under pressure is
  the number that matters.
- **Listening ports**, with what is holding them. A service bound to `127.0.0.1` is
  unreachable from a phone by design; Argus will stand in front of it (`--allow-proxy`,
  then open that port by hand) and serve it under `/proxy/<port>/`.

### Everything else

- **Editing the tmux config** and handing it to every session at once. Sourcing a config
  *runs* it, so the file is tried on a throwaway tmux server first and only applied if it
  survives — a bad line ends the server it is sourced into, and that server holds all
  your work.
- **Four languages** (en, it, fr, es) and anyone can add a fifth: a catalogue is a flat
  JSON file keyed by the English strings, importable from Settings.
- **A phone-shaped interface**: bottom navigation, thumb-sized targets, drag-to-scroll in
  the terminal, a full-screen button (F11 is not on a phone), light and dark themes.
- **A QR code** to pair a phone, and an installable PWA over HTTPS.
- **No build step.** The frontend is plain ES modules; xterm.js, marked and the QR
  library are vendored. `pip install -r requirements.txt` and run it.

## Reaching it from outside

Argus listens on plain HTTP and has one token. That is fine on a LAN or a VPN and not
fine on the open internet, so the question is how the phone gets to the machine. In rough
order of how little you have to think about it:

**Tailscale** — the one to pick for a phone. Install it on the machine and on the phone,
and they are on the same private network wherever either of them is. Then:

```bash
tailscale serve --bg 8090          # https://<machine>.<tailnet>.ts.net → your Argus
```

`serve` puts a real certificate in front of it, which also gets you the things HTTPS
unlocks: an installable PWA, the clipboard API, the in-app QR scanner. Nothing is exposed
to the internet — only devices on your tailnet can reach it. (`tailscale funnel` *does*
expose it publicly; don't, not with a shell behind it.)

**An SSH tunnel** — nothing to install anywhere:

```bash
ssh -N -L 8090:127.0.0.1:8090 you@machine     # then open http://127.0.0.1:8090
```

Perfect from a laptop, awkward from a phone.

**A reverse proxy with TLS**, if the machine already has a name and a certificate. Caddy
needs no WebSocket configuration:

```caddy
argus.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

nginx does, and it needs the read timeout raised or a quiet terminal drops every minute:

```nginx
location / {
    proxy_pass http://127.0.0.1:8090;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
```

Serve it at the **root of a name**, not under a path: the app asks for `/api/...`
absolutely, so `example.com/argus/` will not work. And if the proxy is reachable from the
internet, put a second lock in front — basic auth, an identity provider, Cloudflare
Access — because Argus's own lock is a single token with no rate limiting behind it.

**Cloudflare Tunnel** (`cloudflared tunnel --url http://127.0.0.1:8090`) works and takes
a minute, but it publishes a shell to the whole internet behind that one token. If you
use it, put Cloudflare Access in front of it.

## Running it

```bash
git clone <this repo> argus && cd argus
pip install -r requirements.txt
python3 -m app.main                        # 127.0.0.1:8080, read-only, prints a token
```

The first run writes `~/.config/argus/config.yaml` with a fresh token and prints the URL
to open. Useful flags — all of them also config keys:

```bash
python3 -m app.main \
  --listen 0.0.0.0:8090 \
  --root ~ --root /mnt/data \
  --allow-write \                # rename, move, delete, upload, save
  --allow-proxy \                # stand in front of loopback-only ports
  --include-mounts \             # offer every mount point as a root
  --socket my-tmux \             # a tmux socket other than the default
  --qr                           # print a QR code to photograph
```

| Key | Default | What it does |
|---|---|---|
| `listen` | `127.0.0.1:8080` | address and port |
| `token` | generated | 64 hex characters; the only credential |
| `roots` | `~` | the only paths that can be read at all |
| `allow_write` | `false` | every mutating file operation |
| `allow_proxy` | `false` | reverse-proxy a loopback port |
| `include_mounts` | `false` | add mount points to the roots |
| `tmux_socket` | tmux's default | which tmux server to drive |
| `resize_policy` | `adapt` | `adapt`, `preserve` or `auto` — who gets to set the window size |
| `max_preview_bytes` | 2 MiB | past this, a text file arrives as its tail |
| `max_upload_bytes` | 0 (no cap) | per uploaded file |

Run it under systemd so it survives logging out:

```ini
[Service]
ExecStart=/usr/bin/python3 -m app.main
WorkingDirectory=/path/to/argus
Restart=always
```

...plus `loginctl enable-linger $USER`, or the user manager stops at your last logout.

## Security

**Argus is remote shell access.** Anyone holding the token can run anything the user
running Argus can run. Treat it exactly like an SSH private key.

What protects it:

- **One token**, 64 hex characters from `secrets.token_hex`, compared in constant time.
  Every route and every WebSocket is behind it.
- **Safe defaults**: loopback only, read-only, no proxying, no extra mounts. Everything
  that can change the machine is opt-in.
- **A path jail** that canonicalizes before comparing, so neither `../../etc/passwd` nor
  a symlink pointing out of a root gets through. A path outside the roots is refused
  identically whether or not it exists, so the API cannot be used to probe the
  filesystem.
- **Previewed HTML and rendered documents** are served under a CSP sandbox, in an opaque
  origin, so somebody else's report cannot read the token out of localStorage. Markdown
  is escaped before rendering and `javascript:` links are stripped.
- **The tmux config is validated on a throwaway server** before being applied to the one
  holding your sessions.

What does not:

- **No TLS.** Over plain HTTP the token crosses the network in the clear and so does
  everything you type. On anything but a trusted LAN, put it behind a reverse proxy with
  a certificate, or reach it through a VPN or an SSH tunnel.
- **The token appears in the pairing URL**, so it lands in browser history and in server
  logs. Rotate it by editing the config and restarting.
- **No rate limiting, no audit log, no second factor.** One credential, no accounts.
- Anyone with the token can read every file under the configured roots, and — with
  `--allow-write` — change them.

## Development

```bash
python3 -m pytest -q          # 221 tests, no network, no tmux server of their own
```

The tests never touch tmux's default socket. Neither should anything else you run
against this code: a tmux server that dies takes every session on it with it, which is
how this repository learned the rule the hard way.

## Third-party code

Vendored under `static/vendor/`, unmodified, each keeping its own copyright header:

- [xterm.js](https://github.com/xtermjs/xterm.js) 6.0.0 — MIT
- [marked](https://github.com/markedjs/marked) 18.0.7 — MIT
- [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 — MIT

Optional at runtime: [pandoc](https://pandoc.org) for Word documents, and `pdftotext`
(poppler) to search inside PDFs. Without either, those files still open — they are just
plainer.

## Licence

MIT — see [LICENSE](LICENSE).

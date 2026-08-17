"""Configuration: one YAML file, created with a fresh token on first run."""

from __future__ import annotations

import os
import re
import secrets
from dataclasses import dataclass, field
from pathlib import Path

import yaml

DEFAULT_LISTEN = "127.0.0.1:8080"
DEFAULT_MAX_PREVIEW = 2 * 1024 * 1024
RESIZE_POLICIES = ("adapt", "preserve", "auto")
# A runnable's name becomes a tmux session name and appears in a URL path, so it is kept to
# the characters that are unambiguous in both.
RUNNABLE_NAME = re.compile(r"[A-Za-z0-9._-]{1,64}")


class ConfigError(Exception):
    """The config exists but cannot be used as written."""


def home() -> Path:
    return Path(os.environ.get("HOME") or "/")


def generate_token() -> str:
    """32 random bytes, hex-encoded: URL-safe by construction, so it drops straight
    into the ``?token=`` query string the WebSocket and download links need."""
    return secrets.token_hex(32)


def default_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME")
    root = Path(base) if base else home() / ".config"
    return root / "argus" / "config.yaml"


@dataclass
class Config:
    token: str
    roots: list[Path]
    listen: str = DEFAULT_LISTEN
    # What happens to the tmux window size when the phone attaches to a session someone
    # else is already on. `adapt` resizes the window to the phone (what plain `tmux
    # attach` does); `preserve` attaches with `-f ignore-size`, so other clients keep
    # their geometry and the phone sees a cropped viewport onto the larger grid.
    #
    # tmux has no per-client sizing, and grouped sessions do not change that — they
    # share the windows, so they share the size. Whether our client's size counts at
    # all is the only real lever.
    resize_policy: str = "adapt"
    max_preview_bytes: int = DEFAULT_MAX_PREVIEW
    # Which tmux server to drive: a socket name (`-L`) or, with a `/`, a socket path
    # (`-S`). Unset means tmux's default socket — the sessions you already have open.
    # Set it to something disposable when testing: a tmux server can and does crash,
    # and it takes every session on that socket with it.
    tmux_socket: str | None = None
    # Mutating file operations (mkdir/rename/move/copy/delete) are refused unless this is
    # on. A read-only viewer is a safe thing to leave listening on a network; a file
    # manager reachable with one token is a different proposition, so it is a decision
    # you make on purpose.
    allow_write: bool = False
    # Add every real filesystem on the machine to `roots`. A workstation's data is rarely
    # all under $HOME — here it is spread across /mnt/disk2, /mnt/backup and so on.
    include_mounts: bool = False
    # Reverse-proxying a port makes a service someone deliberately bound to 127.0.0.1
    # reachable by anyone holding the token. Off unless asked for, and then still one
    # port at a time.
    allow_proxy: bool = False
    # Cap on a single uploaded file. 0 means no cap; the default keeps a stray drag of
    # something enormous from filling a disk that is already at 94%.
    max_upload_bytes: int = 2 * 1024 * 1024 * 1024
    # Tokens that may ask what is happening here and nothing else: no shell, no files, no
    # writes, no proxy. A board watching several machines holds one of these per machine,
    # so losing the board loses a list of session names rather than every box it can see.
    watchers: list[dict] = field(default_factory=list)
    # Things a board is allowed to start and stop here, listed by hand.
    #
    # A watcher token is meant to be worth almost nothing: a board holds one per machine in
    # a file, and the board's own token is in the storage of every browser that has opened
    # it. So no command ever arrives in a request. Instead each entry names a session and
    # says what to run in it, and a board may only ask for one of these names — the worst
    # anything holding that key can do is start or stop something you wrote down.
    #
    # {name, run, cwd}. Stopping means killing that session, and only a session named here
    # can be killed, so a board can never touch the work you did not list.
    runnable: list[dict] = field(default_factory=list)
    # Ask github.com once a day whether a newer tag exists. It sends nothing — not even
    # which version is running — and it never updates anything. Off is a supported answer.
    check_releases: bool = True
    # Where this machine announces itself, for a board it cannot be reached *from*.
    # {url, token, name, reach, every}. Empty means it announces itself nowhere, which is
    # the default: a machine that phones a board you did not set up is a surprise.
    report_to: dict = field(default_factory=dict)
    # Whether the board this machine announces itself to may also ask it to start and stop
    # things, in the reply to that announcement. Off by default and deliberately separate
    # from `report_to`: telling a board what you are doing is not agreeing to take orders
    # from it, and the two decisions belong to different people often enough to matter.
    #
    # Even on, the answer is bounded by `runnable`: a reply can name one of those and nothing
    # else. There is no path by which a command reaches this machine.
    obey_board: bool = False
    # Whether the board may also stop this Argus, over that same reply. Separate again, and
    # for the sharpest reason on this page: it is the only instruction that cannot be
    # reversed from the board, because afterwards there is nothing there to ask.
    board_may_stop_argus: bool = False
    tls_cert: Path | None = None
    tls_key: Path | None = None

    def attach_flags(self) -> list[str]:
        """Extra arguments for ``tmux attach-session``. `auto` is decided per attach,
        in term.py, since it depends on who else is already there."""
        return ["-f", "ignore-size"] if self.resize_policy == "preserve" else []

    def tls(self) -> tuple[Path, Path] | None:
        if self.tls_cert and self.tls_key:
            return self.tls_cert, self.tls_key
        return None

    def validate(self) -> None:
        if not self.token.strip():
            raise ConfigError("`token` is empty — refusing to start without authentication")
        if len(self.token) < 16:
            raise ConfigError("`token` is shorter than 16 characters — pick something unguessable")
        if self.report_to:
            for needed in ("url", "token"):
                if not str(self.report_to.get(needed) or "").strip():
                    raise ConfigError(f"`report_to` needs a {needed}")
            if not str(self.report_to["url"]).startswith(("http://", "https://")):
                raise ConfigError("`report_to.url` must start with http:// or https://")
        for w in self.watchers:
            if len(w["token"]) < 16:
                raise ConfigError(
                    f"the watcher token for {w['name']!r} is shorter than 16 characters"
                )
            if w["token"] == self.token:
                # Otherwise the weak key is the strong one and the whole point is lost.
                raise ConfigError(
                    f"the watcher token for {w['name']!r} is the same as the main token"
                )
        seen_runnable = set()
        for r in self.runnable:
            if not r["run"]:
                raise ConfigError(f"the runnable {r['name']!r} has nothing to run")
            if r["name"] == "argus":
                raise ConfigError(
                    "`argus` is reserved: a board uses that name for the server itself, so a "
                    "runnable called it could never be reached"
                )
            if r["name"] in seen_runnable:
                raise ConfigError(f"two runnables are both called {r['name']!r}")
            seen_runnable.add(r["name"])
            # The name becomes a tmux session name, and tmux is particular about those.
            if not RUNNABLE_NAME.fullmatch(r["name"]):
                raise ConfigError(
                    f"the runnable name {r['name']!r} may only hold letters, digits, "
                    "dots, dashes and underscores"
                )
        if self.obey_board and not self.runnable:
            raise ConfigError(
                "`obey_board` is on but `runnable` is empty — the board would have nothing "
                "it could ask for"
            )
        if self.board_may_stop_argus and not self.obey_board:
            raise ConfigError(
                "`board_may_stop_argus` is on but `obey_board` is not — it would never be read"
            )
        if self.obey_board and not self.report_to:
            raise ConfigError("`obey_board` is on but this machine announces itself nowhere")
        for w in self.watchers:
            if w.get("may_stop_argus") and not w.get("may_run"):
                raise ConfigError(
                    f"the watcher {w['name']!r} may stop Argus but not run anything — "
                    "`may_stop_argus` needs `may_run` as well"
                )
        if any(w.get("may_run") for w in self.watchers) and not self.runnable:
            raise ConfigError(
                "a watcher is allowed to run things but `runnable` is empty — it would have "
                "nothing it could ask for"
            )
        if not self.roots:
            raise ConfigError("`roots` is empty — nothing would be browsable")
        if self.resize_policy not in RESIZE_POLICIES:
            raise ConfigError(
                f"`resize_policy` must be one of {' | '.join(RESIZE_POLICIES)}, "
                f"not {self.resize_policy!r}"
            )
        if bool(self.tls_cert) != bool(self.tls_key):
            missing = "tls_key" if self.tls_cert else "tls_cert"
            have = "tls_cert" if self.tls_cert else "tls_key"
            raise ConfigError(f"`{have}` set without `{missing}`")

    @classmethod
    def from_dict(cls, raw: dict) -> Config:
        if not isinstance(raw, dict):
            raise ConfigError("the config file must contain a YAML mapping")
        roots = raw.get("roots") or []
        if isinstance(roots, (str, Path)):  # a single root written without a list
            roots = [roots]
        cert, key = raw.get("tls_cert"), raw.get("tls_key")
        return cls(
            token=str(raw.get("token", "")),
            roots=[Path(r) for r in roots],
            listen=str(raw.get("listen", DEFAULT_LISTEN)),
            resize_policy=str(raw.get("resize_policy", "adapt")).lower(),
            max_preview_bytes=int(raw.get("max_preview_bytes", DEFAULT_MAX_PREVIEW)),
            tmux_socket=raw.get("tmux_socket") or None,
            allow_write=bool(raw.get("allow_write", False)),
            include_mounts=bool(raw.get("include_mounts", False)),
            allow_proxy=bool(raw.get("allow_proxy", False)),
            max_upload_bytes=int(raw.get("max_upload_bytes", 2 * 1024 * 1024 * 1024)),
            check_releases=bool(raw.get("check_releases", True)),
            report_to=dict(raw.get("report_to") or {}),
            obey_board=bool(raw.get("obey_board", False)),
            board_may_stop_argus=bool(raw.get("board_may_stop_argus", False)),
            watchers=[
                {"name": str(w.get("name") or "watcher"), "token": str(w.get("token") or ""),
                 # Off unless asked for: a watcher that could restart things without anyone
                 # saying so would make every existing board more powerful than its owner
                 # agreed to when they set it up.
                 "may_run": bool(w.get("may_run", False)),
                 # Stopping the server is the one thing a board cannot undo: nothing is
                 # listening afterwards, so it takes an SSH session to bring back. Its own
                 # flag, and it means nothing without `may_run`.
                 "may_stop_argus": bool(w.get("may_stop_argus", False))}
                for w in (raw.get("watchers") or [])
                if isinstance(w, dict) and str(w.get("token") or "").strip()
            ],
            runnable=[
                {"name": str(r.get("name") or "").strip(),
                 "run": str(r.get("run") or "").strip(),
                 "cwd": str(r.get("cwd") or "").strip()}
                for r in (raw.get("runnable") or [])
                if isinstance(r, dict) and str(r.get("name") or "").strip()
            ],
            tls_cert=Path(cert) if cert else None,
            tls_key=Path(key) if key else None,
        )

    def to_dict(self) -> dict:
        return {
            "listen": self.listen,
            "token": self.token,
            "roots": [str(r) for r in self.roots],
            "resize_policy": self.resize_policy,
            "max_preview_bytes": self.max_preview_bytes,
            "tmux_socket": self.tmux_socket,
            "check_releases": self.check_releases,
            "report_to": self.report_to,
            "allow_write": self.allow_write,
            "include_mounts": self.include_mounts,
            "allow_proxy": self.allow_proxy,
            "max_upload_bytes": self.max_upload_bytes,
            "tls_cert": str(self.tls_cert) if self.tls_cert else None,
            "tls_key": str(self.tls_key) if self.tls_key else None,
        }

    def write_to(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(yaml.safe_dump(self.to_dict(), sort_keys=False), encoding="utf-8")
        # The file holds the access token — keep it off other users' eyes.
        path.chmod(0o600)

    @classmethod
    def load_or_create(cls, path: Path) -> tuple[Config, bool]:
        """Loads the config, creating it with a fresh random token on first run.
        Returns ``(config, was_just_created)``."""
        if path.exists():
            try:
                raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
            except yaml.YAMLError as e:
                raise ConfigError(f"parsing {path}: {e}") from e
            cfg = cls.from_dict(raw)
            cfg.validate()
            return cfg, False

        cfg = cls(token=generate_token(), roots=[home()])
        cfg.write_to(path)
        return cfg, True

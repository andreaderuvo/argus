"""Configuration: one YAML file, created with a fresh token on first run."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from pathlib import Path

import yaml

DEFAULT_LISTEN = "127.0.0.1:8080"
DEFAULT_MAX_PREVIEW = 2 * 1024 * 1024
RESIZE_POLICIES = ("adapt", "preserve", "auto")


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

use anyhow::{Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default = "default_listen")]
    pub listen: String,

    pub token: String,

    pub roots: Vec<PathBuf>,

    /// What happens to the tmux window size when the phone attaches to a session that
    /// someone else is already attached to. See [`ResizePolicy`].
    #[serde(default)]
    pub resize_policy: ResizePolicy,

    #[serde(default = "default_max_preview")]
    pub max_preview_bytes: u64,

    /// Which tmux server to drive: a socket name (`-L`) or, with a `/`, a socket path
    /// (`-S`). Unset means tmux's default socket — the sessions you already have open.
    /// Set it to something disposable when testing: a tmux server can and does crash,
    /// and it takes every session on that socket with it.
    #[serde(default)]
    pub tmux_socket: Option<String>,

    #[serde(default)]
    pub tls_cert: Option<PathBuf>,
    #[serde(default)]
    pub tls_key: Option<PathBuf>,
}

/// tmux has no per-client window sizing: every client attached to a window sees the
/// same grid. Grouped sessions do **not** change this — they share the windows, so they
/// share the size. The only real lever is whether our client's size counts at all.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResizePolicy {
    /// Resize the tmux window to the phone. Best readability, and harmless in the common
    /// case where nothing else is attached. If a desktop client *is* attached, its view
    /// shrinks too (this is exactly what plain `tmux attach` does).
    #[default]
    Adapt,
    /// Attach with `-f ignore-size`: other clients keep their size and the phone shows a
    /// cropped viewport onto the larger grid. Pick this if you keep a desktop client open.
    Preserve,
}

impl ResizePolicy {
    /// Extra arguments for `tmux attach-session`.
    pub fn attach_flags(self) -> &'static [&'static str] {
        match self {
            ResizePolicy::Adapt => &[],
            ResizePolicy::Preserve => &["-f", "ignore-size"],
        }
    }
}

fn default_listen() -> String {
    "127.0.0.1:8080".to_string()
}
fn default_max_preview() -> u64 {
    2 * 1024 * 1024
}

impl Config {
    pub fn default_path() -> PathBuf {
        let base = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home().join(".config"));
        base.join("tmux-companion").join("config.yaml")
    }

    /// Loads the config, creating it with a fresh random token on first run.
    /// Returns `true` alongside it when the file was just created.
    pub fn load_or_create(path: &Path) -> Result<(Self, bool)> {
        if path.exists() {
            let text = std::fs::read_to_string(path)
                .with_context(|| format!("reading {}", path.display()))?;
            let cfg: Config = serde_yaml_ng::from_str(&text)
                .with_context(|| format!("parsing {}", path.display()))?;
            cfg.validate()?;
            return Ok((cfg, false));
        }

        let cfg = Config {
            listen: default_listen(),
            token: generate_token(),
            roots: vec![home()],
            resize_policy: ResizePolicy::Adapt,
            max_preview_bytes: default_max_preview(),
            tmux_socket: None,
            tls_cert: None,
            tls_key: None,
        };
        cfg.write_to(path)?;
        Ok((cfg, true))
    }

    pub fn write_to(&self, path: &Path) -> Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)
                .with_context(|| format!("creating {}", dir.display()))?;
        }
        let text = serde_yaml_ng::to_string(self)?;
        std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))?;

        // The file holds the access token — keep it off other users' eyes.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
        Ok(())
    }

    pub fn validate(&self) -> Result<()> {
        if self.token.trim().is_empty() {
            anyhow::bail!("`token` is empty — refusing to start without authentication");
        }
        if self.token.len() < 16 {
            anyhow::bail!("`token` is shorter than 16 characters — pick something unguessable");
        }
        if self.roots.is_empty() {
            anyhow::bail!("`roots` is empty — nothing would be browsable");
        }
        match (&self.tls_cert, &self.tls_key) {
            (Some(_), None) => anyhow::bail!("`tls_cert` set without `tls_key`"),
            (None, Some(_)) => anyhow::bail!("`tls_key` set without `tls_cert`"),
            _ => {}
        }
        Ok(())
    }

    pub fn tls(&self) -> Option<(&Path, &Path)> {
        match (&self.tls_cert, &self.tls_key) {
            (Some(c), Some(k)) => Some((c.as_path(), k.as_path())),
            _ => None,
        }
    }
}

pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// 32 random bytes, hex-encoded: URL-safe by construction, so it drops straight into
/// the `?token=` query string the WebSocket and `<img>`/download links need.
pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    let mut s = String::with_capacity(64);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(s, "{b:02x}");
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_64_hex_chars_and_not_repeated() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn round_trips_through_yaml() {
        let cfg = Config {
            listen: "0.0.0.0:9000".into(),
            token: generate_token(),
            roots: vec!["/tmp".into(), "/var/log".into()],
            resize_policy: ResizePolicy::Preserve,
            max_preview_bytes: 4096,
            tmux_socket: Some("tmuxc-test".into()),
            tls_cert: None,
            tls_key: None,
        };
        let text = serde_yaml_ng::to_string(&cfg).unwrap();
        let back: Config = serde_yaml_ng::from_str(&text).unwrap();
        assert_eq!(back.listen, cfg.listen);
        assert_eq!(back.token, cfg.token);
        assert_eq!(back.roots, cfg.roots);
        assert_eq!(back.resize_policy, ResizePolicy::Preserve);
        assert_eq!(back.max_preview_bytes, 4096);
        assert_eq!(back.tmux_socket.as_deref(), Some("tmuxc-test"));
    }

    #[test]
    fn omitted_fields_fall_back_to_defaults() {
        let text = "token: 0123456789abcdef0123\nroots:\n  - /tmp\n";
        let cfg: Config = serde_yaml_ng::from_str(text).unwrap();
        assert_eq!(cfg.listen, "127.0.0.1:8080");
        assert_eq!(cfg.resize_policy, ResizePolicy::Adapt);
        assert_eq!(cfg.max_preview_bytes, 2 * 1024 * 1024);
        assert_eq!(cfg.tmux_socket, None, "omitted means tmux's default socket");
        cfg.validate().unwrap();
    }

    #[test]
    fn refuses_weak_or_missing_tokens() {
        let mk = |tok: &str| Config {
            listen: default_listen(),
            token: tok.into(),
            roots: vec!["/tmp".into()],
            resize_policy: ResizePolicy::Adapt,
            max_preview_bytes: 1024,
            tmux_socket: None,
            tls_cert: None,
            tls_key: None,
        };
        assert!(mk("").validate().is_err());
        assert!(mk("   ").validate().is_err());
        assert!(mk("short").validate().is_err());
        assert!(mk(&generate_token()).validate().is_ok());
    }

    #[test]
    fn refuses_half_configured_tls() {
        let mut cfg = Config {
            listen: default_listen(),
            token: generate_token(),
            roots: vec!["/tmp".into()],
            resize_policy: ResizePolicy::Adapt,
            max_preview_bytes: 1024,
            tmux_socket: None,
            tls_cert: Some("/tmp/cert.pem".into()),
            tls_key: None,
        };
        assert!(cfg.validate().is_err());
        cfg.tls_key = Some("/tmp/key.pem".into());
        assert!(cfg.validate().is_ok());
    }
}

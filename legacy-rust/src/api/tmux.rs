use axum::{extract::State, Json};
use serde::Serialize;
use std::process::Command;

use super::{ApiError, ApiResult};
use crate::AppState;

/// An explicit format string, so we parse fields we chose rather than tmux's
/// human-readable layout (which changes between versions).
const FORMAT: &str = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}";

/// Which tmux server every command in this process talks to.
///
/// `None` is tmux's default socket — the one a bare `tmux` in a shell reaches, holding
/// the user's real work. Point this at a throwaway socket (`tmux_socket:` in the config,
/// or `--socket`) and nothing this process does can reach those sessions: not a stray
/// command, not a crash of the server we drive. Tests and dev runs must always set it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Socket(Option<String>);

impl Socket {
    pub fn new(spec: Option<&str>) -> Self {
        Self(spec.map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned))
    }

    /// Global flags, which tmux only accepts *before* the command name. A spec with a
    /// `/` is a socket path (`-S`), anything else a socket name under tmux's tmpdir (`-L`).
    pub fn args(&self) -> Vec<&str> {
        match self.0.as_deref() {
            None => Vec::new(),
            Some(s) if s.contains('/') => vec!["-S", s],
            Some(s) => vec!["-L", s],
        }
    }

    /// For the startup banner, so which server we drive is never a guess.
    pub fn label(&self) -> &str {
        self.0.as_deref().unwrap_or("default")
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Session {
    pub name: String,
    pub windows: u32,
    pub attached: u32,
    pub created: i64,
}

pub async fn sessions(State(st): State<AppState>) -> ApiResult<Json<Vec<Session>>> {
    let sock = st.socket.clone();
    let list = tokio::task::spawn_blocking(move || list_sessions(&sock))
        .await
        .map_err(|e| ApiError::Tmux(e.to_string()))??;
    Ok(Json(list))
}

pub fn list_sessions(sock: &Socket) -> Result<Vec<Session>, ApiError> {
    let out = Command::new("tmux")
        .args(sock.args())
        .args(["list-sessions", "-F", FORMAT])
        .output()
        .map_err(|e| ApiError::Tmux(format!("could not run tmux: {e}")))?;

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        // "no server running" is the normal state when nothing is open — an empty
        // list, not an error the UI should shout about.
        if is_no_server(&stderr) {
            return Ok(Vec::new());
        }
        return Err(ApiError::Tmux(stderr.trim().to_string()));
    }

    Ok(parse_sessions(&String::from_utf8_lossy(&out.stdout)))
}

fn is_no_server(stderr: &str) -> bool {
    let s = stderr.to_lowercase();
    s.contains("no server running")
        || s.contains("error connecting")
        || s.contains("no current client")
        || s.contains("failed to connect to server")
}

fn parse_sessions(stdout: &str) -> Vec<Session> {
    stdout
        .lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| {
            // Session names may contain anything except a tab, so split from the right:
            // the last three fields are always ours.
            let mut it = line.rsplitn(4, '\t');
            let created = it.next()?.trim().parse().unwrap_or(0);
            let attached = it.next()?.trim().parse().unwrap_or(0);
            let windows = it.next()?.trim().parse().unwrap_or(0);
            let name = it.next()?.to_string();
            if name.is_empty() {
                return None;
            }
            Some(Session { name, windows, attached, created })
        })
        .collect()
}

/// True when a session with exactly this name exists right now. The WebSocket handler
/// gates on this so a client can never name a session we did not enumerate ourselves.
pub fn session_exists(sock: &Socket, name: &str) -> bool {
    list_sessions(sock)
        .map(|s| s.iter().any(|s| s.name == name))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_standard_output() {
        let out = "claude\t2\t1\t1753000000\ncodex\t1\t0\t1753000100\n";
        assert_eq!(
            parse_sessions(out),
            vec![
                Session { name: "claude".into(), windows: 2, attached: 1, created: 1753000000 },
                Session { name: "codex".into(), windows: 1, attached: 0, created: 1753000100 },
            ]
        );
    }

    #[test]
    fn keeps_session_names_that_contain_spaces_and_dashes() {
        let out = "my session-1\t3\t0\t1\n";
        assert_eq!(parse_sessions(out)[0].name, "my session-1");
    }

    #[test]
    fn ignores_blank_and_malformed_lines() {
        let out = "\ngood\t1\t0\t5\nnotenoughfields\n\n";
        let s = parse_sessions(out);
        assert_eq!(s.len(), 1);
        assert_eq!(s[0].name, "good");
    }

    #[test]
    fn recognises_the_no_server_condition() {
        assert!(is_no_server("no server running on /tmp/tmux-1000/default"));
        assert!(is_no_server("error connecting to /tmp/tmux-1000/default (No such file)"));
        assert!(!is_no_server("session not found: bogus"));
    }

    #[test]
    fn empty_output_is_an_empty_list() {
        assert!(parse_sessions("").is_empty());
    }

    #[test]
    fn no_socket_configured_means_the_default_server() {
        assert!(Socket::new(None).args().is_empty());
        assert!(Socket::new(Some("  ")).args().is_empty());
        assert_eq!(Socket::new(None).label(), "default");
    }

    #[test]
    fn a_plain_name_is_a_socket_name_and_a_path_is_a_socket_path() {
        assert_eq!(Socket::new(Some("tmuxc-test")).args(), vec!["-L", "tmuxc-test"]);
        assert_eq!(Socket::new(Some("/tmp/t/sock")).args(), vec!["-S", "/tmp/t/sock"]);
        assert_eq!(Socket::new(Some("tmuxc-test")).label(), "tmuxc-test");
    }
}

//! Real PTY attached to `tmux attach-session`, bridged to a WebSocket.
//!
//! Wire protocol
//! - client → server: **binary** frames are raw keystrokes; **text** frames are JSON control
//!   messages (`{"type":"resize","cols":N,"rows":N}`).
//! - server → client: **binary** frames are raw PTY output; **text** frames are JSON status
//!   (`{"type":"ready"}` / `{"type":"exit","reason":"…"}`).

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use crate::{api::tmux, config::ResizePolicy, AppState};

const READ_BUF: usize = 8192;
/// Bounded so a client that stops reading applies backpressure to the PTY instead of
/// letting a runaway `cat` of a huge file balloon our memory.
const OUTPUT_QUEUE: usize = 512;

#[derive(Deserialize)]
pub struct TermQuery {
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
}

fn default_cols() -> u16 {
    80
}
fn default_rows() -> u16 {
    24
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientControl {
    Resize { cols: u16, rows: u16 },
}

pub async fn handler(
    ws: WebSocketUpgrade,
    Path(session): Path<String>,
    Query(q): Query<TermQuery>,
    State(st): State<AppState>,
) -> Response {
    // Only names tmux itself reported are acceptable. The PTY spawn takes an argv (no
    // shell), so this is not about injection — it is about not handing tmux a target we
    // never listed, and about returning a clean 404 before upgrading the connection.
    let name = session.clone();
    let sock = st.socket.clone();
    let probe = sock.clone();
    let exists = tokio::task::spawn_blocking(move || tmux::session_exists(&probe, &name))
        .await
        .unwrap_or(false);
    if !exists {
        return (StatusCode::NOT_FOUND, format!("no tmux session named {session:?}")).into_response();
    }

    let policy = st.cfg.resize_policy;
    let cols = q.cols.clamp(2, 1000);
    let rows = q.rows.clamp(2, 1000);

    ws.on_upgrade(move |socket| async move {
        if let Err(e) = bridge(socket, session, cols, rows, policy, sock).await {
            eprintln!("terminal session ended with an error: {e:#}");
        }
    })
}

async fn bridge(
    socket: WebSocket,
    session: String,
    cols: u16,
    rows: u16,
    policy: ResizePolicy,
    sock: tmux::Socket,
) -> anyhow::Result<()> {
    let pty = portable_pty::native_pty_system().openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let mut child = pty.slave.spawn_command(attach_command(&session, policy, &sock))?;
    // The slave fd must go, otherwise the master never sees EOF when tmux exits.
    drop(pty.slave);

    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pty.master));
    let mut reader = master.lock().unwrap().try_clone_reader()?;
    let mut writer = master.lock().unwrap().take_writer()?;

    // portable-pty gives us blocking handles, so each direction gets its own thread and
    // talks to the async side through a channel.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::channel::<Vec<u8>>(OUTPUT_QUEUE);
    std::thread::spawn(move || {
        let mut buf = [0u8; READ_BUF];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(data) = in_rx.recv() {
            if writer.write_all(&data).is_err() || writer.flush().is_err() {
                break;
            }
        }
    });

    let (mut ws_tx, mut ws_rx) = socket.split();
    let _ = ws_tx.send(Message::Text(r#"{"type":"ready"}"#.into())).await;

    let reason = loop {
        tokio::select! {
            chunk = out_rx.recv() => match chunk {
                Some(data) => {
                    if ws_tx.send(Message::Binary(data.into())).await.is_err() {
                        break "client went away";
                    }
                }
                // tmux exited or the PTY closed — tell the client instead of leaving it
                // staring at a frozen terminal.
                None => break "tmux exited",
            },
            msg = ws_rx.next() => match msg {
                Some(Ok(Message::Binary(b))) => {
                    if in_tx.send(b.to_vec()).is_err() {
                        break "pty closed";
                    }
                }
                // A browser that sends keystrokes as text still works.
                Some(Ok(Message::Text(t))) => match serde_json::from_str::<ClientControl>(&t) {
                    Ok(ClientControl::Resize { cols, rows }) => {
                        let size = PtySize {
                            rows: rows.clamp(2, 1000),
                            cols: cols.clamp(2, 1000),
                            pixel_width: 0,
                            pixel_height: 0,
                        };
                        if let Ok(m) = master.lock() {
                            let _ = m.resize(size);
                        }
                    }
                    Err(_) => {
                        if in_tx.send(t.as_bytes().to_vec()).is_err() {
                            break "pty closed";
                        }
                    }
                },
                Some(Ok(Message::Close(_))) | None => break "client closed",
                Some(Err(_)) => break "connection error",
                Some(Ok(_)) => {} // ping/pong handled by axum
            },
        }
    };

    let _ = ws_tx
        .send(Message::Text(
            serde_json::json!({ "type": "exit", "reason": reason }).to_string().into(),
        ))
        .await;
    let _ = ws_tx.send(Message::Close(None)).await;

    // Detaching the client is enough — the tmux *session* and everything running in it
    // must survive, that is the entire point of the product.
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

fn attach_command(session: &str, policy: ResizePolicy, sock: &tmux::Socket) -> CommandBuilder {
    let mut cmd = CommandBuilder::new("tmux");
    // Socket selection is a global flag: it has to precede the command, and it decides
    // which server we attach to at all.
    for a in sock.args() {
        cmd.arg(a);
    }
    cmd.arg("-u"); // force UTF-8 regardless of the server's locale
    cmd.arg("attach-session");
    for f in policy.attach_flags() {
        cmd.arg(f);
    }
    cmd.arg("-t");
    cmd.arg(session);

    // Build the environment explicitly rather than inheriting: `env_clear` first, then
    // copy across what we want. Overriding alone is not enough — an inherited value we
    // never mention would still reach the child.
    //
    // TMUX/TMUX_PANE is the one that matters: tmux-companion is very likely started from
    // inside a tmux pane, and tmux refuses to attach when it thinks it would nest.
    cmd.env_clear();
    for (k, v) in std::env::vars() {
        if k == "TMUX" || k == "TMUX_PANE" || k == "TERM" {
            continue;
        }
        cmd.env(k, v);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.cwd(crate::config::home());
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    fn argv(cmd: &CommandBuilder) -> Vec<String> {
        cmd.get_argv().iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    fn env_of(cmd: &CommandBuilder, key: &str) -> Option<String> {
        cmd.iter_full_env_as_str()
            .find(|(k, _)| *k == key)
            .map(|(_, v)| v.to_string())
    }

    #[test]
    fn adapt_attaches_plainly() {
        let c = attach_command("claude", ResizePolicy::Adapt, &tmux::Socket::default());
        assert_eq!(argv(&c), vec!["tmux", "-u", "attach-session", "-t", "claude"]);
    }

    #[test]
    fn preserve_adds_ignore_size_so_other_clients_keep_their_geometry() {
        let c = attach_command("claude", ResizePolicy::Preserve, &tmux::Socket::default());
        assert_eq!(
            argv(&c),
            vec!["tmux", "-u", "attach-session", "-f", "ignore-size", "-t", "claude"]
        );
    }

    #[test]
    fn session_name_is_passed_as_a_single_argument_never_a_shell_string() {
        let c = attach_command("weird; rm -rf /", ResizePolicy::Adapt, &tmux::Socket::default());
        let a = argv(&c);
        assert_eq!(a.last().unwrap(), "weird; rm -rf /");
        assert_eq!(a.len(), 5);
    }

    #[test]
    fn a_configured_socket_is_what_we_attach_to() {
        let c = attach_command("claude", ResizePolicy::Adapt, &tmux::Socket::new(Some("tmuxc-test")));
        assert_eq!(
            argv(&c),
            vec!["tmux", "-L", "tmuxc-test", "-u", "attach-session", "-t", "claude"],
            "-L must precede the command, or tmux drives the default server instead"
        );
    }

    #[test]
    fn tmux_env_is_stripped_so_attaching_from_inside_tmux_works() {
        std::env::set_var("TMUX", "/tmp/tmux-1000/default,123,4");
        std::env::set_var("TMUX_PANE", "%7");
        let c = attach_command("claude", ResizePolicy::Adapt, &tmux::Socket::default());
        let leaked = env_of(&c, "TMUX").or_else(|| env_of(&c, "TMUX_PANE"));
        std::env::remove_var("TMUX");
        std::env::remove_var("TMUX_PANE");
        assert_eq!(leaked, None, "TMUX must not reach the child, or tmux refuses to nest");
    }

    #[test]
    fn term_is_forced_to_a_256_colour_value() {
        std::env::set_var("TERM", "dumb");
        let c = attach_command("claude", ResizePolicy::Adapt, &tmux::Socket::default());
        assert_eq!(env_of(&c, "TERM").as_deref(), Some("xterm-256color"));
    }

    #[test]
    fn ordinary_environment_still_reaches_the_child() {
        std::env::set_var("TMUXC_PROBE", "kept");
        let c = attach_command("claude", ResizePolicy::Adapt, &tmux::Socket::default());
        let got = env_of(&c, "TMUXC_PROBE");
        std::env::remove_var("TMUXC_PROBE");
        assert_eq!(got.as_deref(), Some("kept"), "clearing the env must not strip PATH/HOME/LANG");
    }

    #[test]
    fn resize_control_messages_parse() {
        let m: ClientControl = serde_json::from_str(r#"{"type":"resize","cols":100,"rows":30}"#).unwrap();
        let ClientControl::Resize { cols, rows } = m;
        assert_eq!((cols, rows), (100, 30));
        assert!(serde_json::from_str::<ClientControl>(r#"{"type":"nope"}"#).is_err());
        assert!(serde_json::from_str::<ClientControl>("ls -la\n").is_err());
    }
}

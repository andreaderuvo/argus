mod api;
mod auth;
mod config;
mod safepath;
mod static_files;
mod ws;

use anyhow::{Context, Result};
use axum::{middleware, routing::get, Router};
use clap::Parser;
use config::Config;
use safepath::Jail;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use tower_http::compression::CompressionLayer;

#[derive(Clone)]
pub struct AppState {
    pub cfg: Arc<Config>,
    pub jail: Arc<Jail>,
    /// Resolved once at startup: every tmux command in the process goes through it.
    pub socket: api::tmux::Socket,
}

#[derive(Parser, Debug)]
#[command(
    name = "tmux-companion",
    version,
    about = "Browse files and attach to tmux sessions from your phone"
)]
struct Cli {
    /// Config file (created with a fresh token on first run)
    #[arg(short, long)]
    config: Option<PathBuf>,

    /// Override `listen`, e.g. 0.0.0.0:8080
    #[arg(short, long)]
    listen: Option<String>,

    /// Override `roots` (repeatable)
    #[arg(short = 'r', long = "root")]
    roots: Vec<PathBuf>,

    /// Drive a specific tmux server: socket name (`-L`) or socket path if it contains `/`
    /// (`-S`). Use a throwaway one when testing — a crashing tmux server takes every
    /// session on its socket down with it.
    #[arg(long)]
    socket: Option<String>,

    /// Print the URL with the access token and exit
    #[arg(long)]
    print_url: bool,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let config_path = cli.config.clone().unwrap_or_else(Config::default_path);

    let (mut cfg, created) = Config::load_or_create(&config_path)?;
    if let Some(l) = cli.listen {
        cfg.listen = l;
    }
    if !cli.roots.is_empty() {
        cfg.roots = cli.roots;
    }
    if let Some(s) = cli.socket {
        cfg.tmux_socket = Some(s);
    }
    cfg.validate()?;

    let addr: SocketAddr = cfg
        .listen
        .parse()
        .with_context(|| format!("`listen` is not a host:port address: {}", cfg.listen))?;

    if cli.print_url {
        println!("{}", url_for(&addr, &cfg));
        return Ok(());
    }

    let jail = Jail::new(&cfg.roots)?;
    let socket = api::tmux::Socket::new(cfg.tmux_socket.as_deref());
    let state = AppState { cfg: Arc::new(cfg), jail: Arc::new(jail), socket };

    let protected = Router::new()
        .route("/api/config", get(api::files::server_info))
        .route("/api/files", get(api::files::list))
        .route("/api/file", get(api::files::read))
        .route("/api/download", get(api::files::download))
        .route("/api/search", get(api::files::search))
        .route("/api/tmux/sessions", get(api::tmux::sessions))
        .route("/ws/tmux/{session}", get(ws::term::handler))
        .route_layer(middleware::from_fn_with_state(state.clone(), auth::require_token));

    let app = Router::new()
        .merge(protected)
        .fallback(static_files::handler)
        .layer(CompressionLayer::new())
        .with_state(state.clone());

    banner(&config_path, created, &addr, &state.cfg, &state.socket);

    match state.cfg.tls() {
        Some((cert, key)) => {
            install_crypto_provider();
            let tls = axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
                .await
                .with_context(|| {
                    format!("loading TLS cert {} / key {}", cert.display(), key.display())
                })?;
            axum_server::bind_rustls(addr, tls)
                .serve(app.into_make_service())
                .await?;
        }
        None => {
            axum_server::bind(addr).serve(app.into_make_service()).await?;
        }
    }
    Ok(())
}

fn install_crypto_provider() {
    // rustls 0.23 refuses to build a config until a provider is chosen process-wide.
    // An error here just means something else already installed one.
    let _ = rustls::crypto::ring::default_provider().install_default();
}

fn url_for(addr: &SocketAddr, cfg: &Config) -> String {
    let scheme = if cfg.tls().is_some() { "https" } else { "http" };
    // 0.0.0.0 is not a usable destination — show a loopback URL and let the banner
    // mention that it is reachable from the network too.
    let host = if addr.ip().is_unspecified() {
        "127.0.0.1".to_string()
    } else {
        addr.ip().to_string()
    };
    format!("{scheme}://{host}:{}/?token={}", addr.port(), cfg.token)
}

fn banner(
    config_path: &std::path::Path,
    created: bool,
    addr: &SocketAddr,
    cfg: &Config,
    socket: &api::tmux::Socket,
) {
    println!("tmux-companion {}", env!("CARGO_PKG_VERSION"));
    if created {
        println!("  created {} with a fresh token", config_path.display());
    } else {
        println!("  config  {}", config_path.display());
    }
    println!("  roots   {}", cfg.roots.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", "));
    println!("  resize  {:?}", cfg.resize_policy);
    println!("  tmux    socket {}", socket.label());
    println!();
    println!("  open    {}", url_for(addr, cfg));
    if addr.ip().is_unspecified() {
        println!("          (bound to {addr} — reachable from the network; put it behind Tailscale)");
    }
    println!();
}

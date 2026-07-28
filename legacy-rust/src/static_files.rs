//! The compiled frontend, baked into the binary.

use axum::{
    http::{header, StatusCode, Uri},
    response::{Html, IntoResponse, Response},
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "frontend/dist"]
struct Assets;

pub async fn handler(uri: Uri) -> Response {
    let path = uri.path().trim_start_matches('/');
    let path = if path.is_empty() { "index.html" } else { path };

    if let Some(file) = Assets::get(path) {
        return serve(path, file);
    }

    // Single-page app: unknown paths are client-side routes, not 404s.
    match Assets::get("index.html") {
        Some(index) => serve("index.html", index),
        None => (StatusCode::SERVICE_UNAVAILABLE, Html(PLACEHOLDER)).into_response(),
    }
}

fn serve(path: &str, file: rust_embed::EmbeddedFile) -> Response {
    let mime = mime_guess::from_path(path).first_or_octet_stream();

    // Vite fingerprints everything under /assets/, so those are safe to pin forever.
    // index.html must not be, or an update never reaches an installed PWA.
    let cache = if path.starts_with("assets/") {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };

    (
        [
            (header::CONTENT_TYPE, mime.as_ref()),
            (header::CACHE_CONTROL, cache),
        ],
        file.data.into_owned(),
    )
        .into_response()
}

const PLACEHOLDER: &str = r#"<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tmux-companion</title>
<style>
  body { font-family: ui-monospace, monospace; background:#0b0e14; color:#c5cad3;
         display:grid; place-items:center; min-height:100vh; margin:0; padding:1.5rem; }
  div { max-width: 34rem; line-height: 1.6; }
  code { background:#151a23; padding:.15rem .4rem; border-radius:.25rem; color:#8fd6a0; }
  h1 { font-size:1.1rem; color:#e6e9ef; }
</style>
<div>
  <h1>Frontend not built</h1>
  <p>The API and the WebSocket are running, but no UI was embedded in this binary.</p>
  <p>Build it and recompile:</p>
  <p><code>cd frontend &amp;&amp; npm ci &amp;&amp; npm run build &amp;&amp; cd .. &amp;&amp; cargo build --release</code></p>
</div>
"#;

use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::UNIX_EPOCH;

use super::{ApiError, ApiResult};
use crate::AppState;

/// Directories that never carry anything a phone user is looking for, and that would
/// otherwise dominate the walk. Skipping them is what keeps search interactive.
const SEARCH_SKIP: &[&str] = &[
    ".git", "node_modules", "target", ".cargo", ".rustup", ".conda", "miniconda3",
    ".nextflow", "work", ".cache", ".venv", "__pycache__", ".npm", ".nvm",
];
const SEARCH_MAX_HITS: usize = 200;
const SEARCH_MAX_VISITED: usize = 300_000;
const SEARCH_MAX_DEPTH: usize = 12;
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Deserialize)]
pub struct PathQuery {
    pub path: String,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub path: String,
    pub q: String,
}

#[derive(Serialize)]
pub struct Entry {
    pub name: String,
    /// `"directory"` or `"file"`, as specified by the API contract.
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub path: String,
    pub size: u64,
    /// Unix seconds; the client does the formatting.
    pub mtime: i64,
    /// True when the entry is a symlink, whatever it resolves to. The UI shows a hint,
    /// and opening it still goes through the jail — a link out of the roots gets 403.
    pub symlink: bool,
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub roots: Vec<String>,
    pub resize_policy: crate::config::ResizePolicy,
    pub max_preview_bytes: u64,
}

pub async fn server_info(State(st): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        roots: st.jail.roots().iter().map(|p| p.display().to_string()).collect(),
        resize_policy: st.cfg.resize_policy,
        max_preview_bytes: st.cfg.max_preview_bytes,
    })
}

pub async fn list(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Json<Vec<Entry>>> {
    let dir = st.jail.resolve(&q.path)?;
    let meta = std::fs::metadata(&dir)?;
    if !meta.is_dir() {
        return Err(ApiError::BadRequest("not a directory".into()));
    }

    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue, // an unreadable entry should not sink the whole listing
        };
        let path = entry.path();
        let symlink = entry.file_type().map(|t| t.is_symlink()).unwrap_or(false);

        // Follow symlinks for the reported kind/size; fall back to the link itself
        // when the target is missing or unreadable.
        let meta = std::fs::metadata(&path).or_else(|_| std::fs::symlink_metadata(&path));
        let (kind, size, mtime) = match meta {
            Ok(m) => (
                if m.is_dir() { "directory" } else { "file" },
                if m.is_dir() { 0 } else { m.len() },
                unix_secs(&m),
            ),
            Err(_) => ("file", 0, 0),
        };

        out.push(Entry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
            path: path.display().to_string(),
            size,
            mtime,
            symlink,
        });
    }

    // Directories first, then case-insensitive by name — the order a person expects.
    out.sort_by(|a, b| {
        (a.kind == "file")
            .cmp(&(b.kind == "file"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(Json(out))
}

pub async fn read(State(st): State<AppState>, Query(q): Query<PathQuery>) -> ApiResult<Response> {
    let path = st.jail.resolve(&q.path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(ApiError::BadRequest("path is a directory".into()));
    }
    if meta.len() > st.cfg.max_preview_bytes {
        return Err(ApiError::TooLarge(st.cfg.max_preview_bytes));
    }

    let bytes = std::fs::read(&path)?;
    let guessed = mime_guess::from_path(&path).first_or_octet_stream();

    // Images are served with their real type so the preview screen can use a plain <img>.
    if guessed.type_() == mime_guess::mime::IMAGE {
        return Ok(inline_response(guessed.as_ref(), bytes));
    }

    // Everything else must look like text. A NUL byte in the first 8 KiB is the cheap,
    // reliable signal that it does not.
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    if head.contains(&0) {
        return Err(ApiError::NotText);
    }
    Ok(inline_response("text/plain; charset=utf-8", bytes))
}

pub async fn download(
    State(st): State<AppState>,
    Query(q): Query<PathQuery>,
) -> ApiResult<Response> {
    let path = st.jail.resolve(&q.path)?;
    let meta = std::fs::metadata(&path)?;
    if meta.is_dir() {
        return Err(ApiError::BadRequest("cannot download a directory".into()));
    }

    let file = tokio::fs::File::open(&path).await?;
    let body = Body::from_stream(tokio_util::io::ReaderStream::new(file));

    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());

    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime_guess::from_path(&path).first_or_octet_stream().as_ref())
            .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
    );
    headers.insert(header::CONTENT_LENGTH, HeaderValue::from(meta.len()));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&content_disposition(&name))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );

    Ok((headers, body).into_response())
}

pub async fn search(
    State(st): State<AppState>,
    Query(q): Query<SearchQuery>,
) -> ApiResult<Json<Vec<Entry>>> {
    let root = st.jail.resolve(&q.path)?;
    let needle = q.q.trim().to_lowercase();
    if needle.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let hits = tokio::task::spawn_blocking(move || walk_for(&root, &needle))
        .await
        .map_err(|e| ApiError::Io(std::io::Error::other(e.to_string())))?;

    Ok(Json(hits))
}

fn walk_for(root: &Path, needle: &str) -> Vec<Entry> {
    let mut hits = Vec::new();
    let mut visited = 0usize;

    let walker = walkdir::WalkDir::new(root)
        .max_depth(SEARCH_MAX_DEPTH)
        .follow_links(false) // a followed link could walk straight out of the jail
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                !SEARCH_SKIP.contains(&name.as_ref()) && !name.starts_with('.')
            } else {
                true
            }
        });

    for entry in walker.flatten() {
        visited += 1;
        if visited > SEARCH_MAX_VISITED || hits.len() >= SEARCH_MAX_HITS {
            break;
        }
        if entry.depth() == 0 {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.to_lowercase().contains(needle) {
            continue;
        }
        let is_dir = entry.file_type().is_dir();
        let meta = entry.metadata().ok();
        hits.push(Entry {
            name,
            kind: if is_dir { "directory" } else { "file" },
            path: entry.path().display().to_string(),
            size: meta.as_ref().map(|m| if is_dir { 0 } else { m.len() }).unwrap_or(0),
            mtime: meta.as_ref().map(unix_secs).unwrap_or(0),
            symlink: entry.path_is_symlink(),
        });
    }

    hits
}

fn unix_secs(m: &std::fs::Metadata) -> i64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn inline_response(content_type: &str, bytes: Vec<u8>) -> Response {
    (
        StatusCode::OK,
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type)
                .unwrap_or_else(|_| HeaderValue::from_static("application/octet-stream")),
        )],
        bytes,
    )
        .into_response()
}

/// `filename=` needs a plain-ASCII value; `filename*=` carries the real name.
/// Sending both keeps every browser happy without letting a quote or newline in a
/// filename inject a header.
fn content_disposition(name: &str) -> String {
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "-_. ".contains(c) { c } else { '_' })
        .collect();
    let ascii = if ascii.trim().is_empty() { "download".to_string() } else { ascii };
    format!("attachment; filename=\"{}\"; filename*=UTF-8''{}", ascii, percent_encode(name))
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(*b as char);
        } else {
            use std::fmt::Write;
            let _ = write!(out, "%{b:02X}");
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_disposition_neutralises_hostile_filenames() {
        let cd = content_disposition("in\"jec\nted.txt");
        assert!(!cd.contains('\n'));
        assert_eq!(cd.matches('"').count(), 2, "only the wrapping quotes survive");
        assert!(cd.contains("filename*=UTF-8''"));
    }

    #[test]
    fn content_disposition_keeps_unicode_in_the_extended_form() {
        let cd = content_disposition("relazione-più.pdf");
        // The ASCII fallback substitutes per character, so `ù` becomes a single `_`.
        assert!(cd.contains("filename=\"relazione-pi_.pdf\""), "{cd}");
        assert!(cd.contains("filename*=UTF-8''relazione-pi%C3%B9.pdf"));
    }

    #[test]
    fn content_disposition_survives_a_fully_unprintable_name() {
        assert!(content_disposition("///").contains("filename=\"___\""));
    }

    #[test]
    fn search_skips_noisy_directories_and_finds_by_substring() {
        let base = std::env::temp_dir().join(format!("tmuxc-search-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("node_modules/deep")).unwrap();
        std::fs::create_dir_all(base.join("src")).unwrap();
        std::fs::write(base.join("src/README.md"), b"x").unwrap();
        std::fs::write(base.join("node_modules/deep/README.md"), b"x").unwrap();

        let hits = walk_for(&base, "readme");
        assert_eq!(hits.len(), 1, "the node_modules copy must not be reported");
        assert!(hits[0].path.ends_with("src/README.md"));

        let _ = std::fs::remove_dir_all(&base);
    }
}

//! Bearer-token gate for `/api` and `/ws`.

use axum::{
    extract::{Query, Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::collections::HashMap;
use subtle::ConstantTimeEq;

use crate::AppState;

pub async fn require_token(State(st): State<AppState>, req: Request, next: Next) -> Response {
    if presented_token(&req).is_some_and(|t| matches(&t, &st.cfg.token)) {
        return next.run(req).await;
    }
    (
        StatusCode::UNAUTHORIZED,
        [(header::WWW_AUTHENTICATE, "Bearer")],
        "missing or invalid token",
    )
        .into_response()
}

/// Accepts the token from the `Authorization` header or from `?token=`.
///
/// The query form is not a convenience: browsers cannot set headers on a WebSocket
/// handshake, nor on `<img src>` and download links, so those paths have no alternative.
fn presented_token(req: &Request) -> Option<String> {
    if let Some(v) = req.headers().get(header::AUTHORIZATION) {
        if let Ok(s) = v.to_str() {
            if let Some(rest) = s.strip_prefix("Bearer ") {
                return Some(rest.trim().to_string());
            }
        }
    }
    Query::<HashMap<String, String>>::try_from_uri(req.uri())
        .ok()
        .and_then(|Query(q)| q.get("token").cloned())
}

/// Constant-time comparison: `subtle` also returns false for a length mismatch,
/// so the wire never learns how long the real token is.
fn matches(presented: &str, expected: &str) -> bool {
    presented.as_bytes().ct_eq(expected.as_bytes()).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request as HttpRequest;

    fn req(uri: &str, auth: Option<&str>) -> Request {
        let mut b = HttpRequest::builder().uri(uri);
        if let Some(a) = auth {
            b = b.header(header::AUTHORIZATION, a);
        }
        b.body(Body::empty()).unwrap()
    }

    #[test]
    fn compares_exactly() {
        assert!(matches("abc", "abc"));
        assert!(!matches("abc", "abd"));
        assert!(!matches("abc", "abcd"));
        assert!(!matches("", "abc"));
        assert!(!matches("abc", ""));
    }

    #[test]
    fn reads_the_bearer_header() {
        assert_eq!(presented_token(&req("/api/files", Some("Bearer s3cret"))).as_deref(), Some("s3cret"));
    }

    #[test]
    fn ignores_other_authorization_schemes() {
        assert_eq!(presented_token(&req("/api/files", Some("Basic s3cret"))), None);
    }

    #[test]
    fn reads_the_query_parameter_for_websockets_and_img_tags() {
        assert_eq!(presented_token(&req("/ws/tmux/claude?token=s3cret", None)).as_deref(), Some("s3cret"));
    }

    #[test]
    fn url_decodes_the_query_parameter() {
        assert_eq!(presented_token(&req("/api/file?token=a%20b", None)).as_deref(), Some("a b"));
    }

    #[test]
    fn header_wins_over_query() {
        let r = req("/api/files?token=fromquery", Some("Bearer fromheader"));
        assert_eq!(presented_token(&r).as_deref(), Some("fromheader"));
    }

    #[test]
    fn no_credentials_at_all() {
        assert_eq!(presented_token(&req("/api/files", None)), None);
    }
}

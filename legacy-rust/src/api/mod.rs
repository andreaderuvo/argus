pub mod files;
pub mod tmux;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;

use crate::safepath::PathError;

#[derive(Debug)]
pub enum ApiError {
    Denied,
    NotFound,
    BadRequest(String),
    TooLarge(u64),
    NotText,
    Io(std::io::Error),
    Tmux(String),
}

impl From<PathError> for ApiError {
    fn from(e: PathError) -> Self {
        match e {
            PathError::Denied => ApiError::Denied,
            PathError::NotFound => ApiError::NotFound,
        }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        match e.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound,
            std::io::ErrorKind::PermissionDenied => ApiError::Denied,
            _ => ApiError::Io(e),
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, msg) = match self {
            ApiError::Denied => (StatusCode::FORBIDDEN, "outside the configured roots".to_string()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m),
            ApiError::TooLarge(limit) => (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("file exceeds max_preview_bytes ({limit}) — download it instead"),
            ),
            ApiError::NotText => (
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "binary file — download it instead".to_string(),
            ),
            ApiError::Io(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            ApiError::Tmux(m) => (StatusCode::BAD_GATEWAY, m),
        };
        (status, Json(ErrorBody { error: msg })).into_response()
    }
}

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

pub type ApiResult<T> = Result<T, ApiError>;

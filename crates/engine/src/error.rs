#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error("network error: {0}")]
    Network(#[from] reqwest::Error),
    #[error("disk error: {0}")]
    Io(#[from] std::io::Error),
    #[error("server returned HTTP {0}")]
    Http(u16),
    #[error("link expired or access denied (HTTP {0}); refresh the download address")]
    LinkExpired(u16),
    #[error("file changed on the server")]
    RemoteChanged,
    #[error("server returned an unexpected byte range")]
    BadRange,
    #[error("connection closed before the segment finished")]
    Incomplete,
    #[error("invalid URL: {0}")]
    InvalidUrl(String),
}

impl Error {
    /// Transient failures worth retrying on the same segment.
    pub fn is_retryable(&self) -> bool {
        match self {
            Error::Network(_) | Error::Incomplete | Error::BadRange => true,
            Error::Http(s) => *s >= 500 || *s == 429 || *s == 408,
            _ => false,
        }
    }
}

pub type Result<T> = std::result::Result<T, Error>;

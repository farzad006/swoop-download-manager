//! Segmented, resumable HTTP(S) download engine.

mod download;
mod error;
mod limiter;
mod probe;
mod segments;

pub use download::{
    DEFAULT_USER_AGENT, DownloadHandle, Options, Outcome, Progress, Request, Status, build_client, header_map,
    start, start_with_cancel, unique_path,
};
pub use error::{Error, Result};
pub use limiter::RateLimiter;
pub use probe::{Probe, probe, sanitize_file_name};
pub use segments::Segment;
pub use tokio_util::sync::CancellationToken;

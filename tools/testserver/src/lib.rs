//! Local HTTP server for engine tests. Serves deterministic bytes with knobs for
//! range support, throttling, dropped connections and changing ETags.
//!
//! `GET /file/{size}?ranges=0|1&rate=<bytes/s per connection>&drop=<bytes>&name=<file name>`
//! `&slow_from=<offset>` throttles only requests starting at or after the offset;
//! `&status=<code>` answers with that status and no body.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use axum::Router;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::Response;
use axum::routing::get;
use bytes::Bytes;

/// Byte at offset `i` of the file served while the server is at `version`.
pub fn pattern_byte(i: u64, version: u64) -> u8 {
    let x = i.wrapping_add(version.wrapping_mul(0x9E37_79B9)).wrapping_mul(0x2545_F491_4F6C_DD1D);
    (x >> 56) as u8
}

pub fn pattern(len: u64, version: u64) -> Vec<u8> {
    (0..len).map(|i| pattern_byte(i, version)).collect()
}

#[derive(Clone, Default)]
pub struct Stats {
    pub bytes_served: Arc<AtomicU64>,
    pub requests: Arc<AtomicU64>,
    pub version: Arc<AtomicU64>,
}

pub struct TestServer {
    pub addr: SocketAddr,
    pub stats: Stats,
}

impl TestServer {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{}", self.addr, path)
    }
    /// Changes the served content and its ETag, as if the file was replaced upstream.
    pub fn set_version(&self, v: u64) {
        self.stats.version.store(v, Ordering::SeqCst);
    }
    pub fn version(&self) -> u64 {
        self.stats.version.load(Ordering::SeqCst)
    }
    pub fn bytes_served(&self) -> u64 {
        self.stats.bytes_served.load(Ordering::SeqCst)
    }
}

pub async fn spawn() -> TestServer {
    spawn_on("127.0.0.1:0").await
}

pub async fn spawn_on(bind: &str) -> TestServer {
    let stats = Stats::default();
    let app = Router::new()
        .route("/file/{size}", get(serve))
        .route("/page", get(page))
        .with_state(stats.clone());
    let listener = tokio::net::TcpListener::bind(bind).await.expect("bind test server");
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    TestServer { addr, stats }
}

fn parse_range(h: &str, size: u64) -> Option<(u64, u64)> {
    let spec = h.strip_prefix("bytes=")?;
    let (a, b) = spec.split_once('-')?;
    let start: u64 = a.trim().parse().ok()?;
    let end = if b.trim().is_empty() { size - 1 } else { b.trim().parse::<u64>().ok()?.min(size - 1) };
    (start <= end && start < size).then_some((start, end))
}

async fn serve(
    State(stats): State<Stats>,
    Path(size): Path<u64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    stats.requests.fetch_add(1, Ordering::SeqCst);
    let version = stats.version.load(Ordering::SeqCst);
    let etag = format!("\"v{version}\"");
    let ranges = q.get("ranges").map(|v| v != "0").unwrap_or(true);
    let rate: u64 = q.get("rate").and_then(|v| v.parse().ok()).unwrap_or(0);
    let drop_after: u64 = q.get("drop").and_then(|v| v.parse().ok()).unwrap_or(0);
    let slow_from: u64 = q.get("slow_from").and_then(|v| v.parse().ok()).unwrap_or(0);
    if let Some(code) = q.get("status").and_then(|v| v.parse::<u16>().ok()) {
        let mut resp = Response::new(Body::empty());
        *resp.status_mut() = StatusCode::from_u16(code).unwrap();
        return resp;
    }

    let if_range_ok = headers
        .get(header::IF_RANGE)
        .map(|v| v.to_str().unwrap_or("") == etag)
        .unwrap_or(true);
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .filter(|_| ranges && if_range_ok)
        .and_then(|h| parse_range(h, size));

    let (status, start, end) = match range {
        Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e),
        None => (StatusCode::OK, 0, size.saturating_sub(1)),
    };
    let len = if size == 0 { 0 } else { end - start + 1 };

    let rate = if start >= slow_from { rate } else { 0 };
    let stream = async_stream(stats.clone(), start, len, version, rate, drop_after);
    let mut resp = Response::new(Body::from_stream(stream));
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    let ct = q.get("type").map(String::as_str).unwrap_or("application/octet-stream");
    h.insert(header::CONTENT_TYPE, HeaderValue::from_str(ct).unwrap_or(HeaderValue::from_static("application/octet-stream")));
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    if ranges {
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let cr = format!("bytes {start}-{end}/{size}");
        h.insert(header::CONTENT_RANGE, HeaderValue::from_str(&cr).unwrap());
    }
    if let Some(name) = q.get("name") {
        let cd = format!("attachment; filename=\"{name}\"");
        h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&cd).unwrap());
    }
    resp
}

/// A page with a download link and a video, for browser-extension tests.
async fn page() -> axum::response::Html<&'static str> {
    axum::response::Html(
        r#"<!doctype html><html><head><title>Swoop test page</title></head><body>
<h1>Swoop test page</h1>
<p><a id="zip" href="/file/3000000?name=from-browser.zip">Download from-browser.zip</a></p>
<p><a id="html" href="/file/2000?name=notes.html&type=text/html">A link the browser keeps</a></p>
<video id="v" width="640" height="360" muted preload="auto" src="/file/4000000?name=clip.mp4&type=video/mp4"></video>
</body></html>"#,
    )
}

fn async_stream(
    stats: Stats,
    start: u64,
    len: u64,
    version: u64,
    rate: u64,
    drop_after: u64,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    const CHUNK: u64 = 16 * 1024;
    futures_util::stream::unfold(0u64, move |sent| {
        let stats = stats.clone();
        async move {
            if sent >= len {
                return None;
            }
            if drop_after > 0 && sent >= drop_after {
                return Some((Err(std::io::Error::other("simulated drop")), len));
            }
            let n = CHUNK.min(len - sent);
            if rate > 0 {
                tokio::time::sleep(Duration::from_secs_f64(n as f64 / rate as f64)).await;
            }
            let off = start + sent;
            let buf: Vec<u8> = (off..off + n).map(|i| pattern_byte(i, version)).collect();
            stats.bytes_served.fetch_add(n, Ordering::SeqCst);
            Some((Ok(Bytes::from(buf)), sent + n))
        }
    })
}

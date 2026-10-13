use std::ffi::OsString;
use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{self, HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use tokio::task::{JoinHandle, JoinSet};
use tokio_util::sync::CancellationToken;

use crate::error::{Error, Result};
use crate::limiter::RateLimiter;
use crate::probe::{Probe, parse_content_range_start, probe, sanitize_file_name, status_error};
use crate::segments::{MAX_WRITE, Segment, SegmentTable};

pub const DEFAULT_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Request {
    pub url: String,
    /// Extra headers forwarded from the browser: Cookie, Referer, User-Agent, ...
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub dest_dir: PathBuf,
    /// Overrides the server-provided name. Pass the name reported in
    /// `Progress::file_name` to resume an earlier download.
    pub file_name: Option<String>,
}

#[derive(Clone)]
pub struct Options {
    pub connections: usize,
    pub max_retries: u32,
    pub connect_timeout: Duration,
    pub read_timeout: Duration,
    /// `http://`, `https://` or `socks5://` proxy. `None` uses the system proxy.
    pub proxy: Option<String>,
    pub min_split: u64,
    pub global_limiter: Option<Arc<RateLimiter>>,
    pub limiter: Arc<RateLimiter>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            connections: 8,
            max_retries: 10,
            connect_timeout: Duration::from_secs(20),
            read_timeout: Duration::from_secs(30),
            proxy: None,
            min_split: 256 * 1024,
            global_limiter: None,
            limiter: Arc::new(RateLimiter::new(0)),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Queued,
    Probing,
    Downloading,
    Paused,
    Completed,
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub status: Status,
    pub downloaded: u64,
    pub total: Option<u64>,
    /// Bytes per second, smoothed.
    pub speed: f64,
    pub eta_secs: Option<u64>,
    pub connections: usize,
    pub resumable: bool,
    pub segments: Vec<Segment>,
    pub file_name: Option<String>,
    pub path: Option<PathBuf>,
    pub content_type: Option<String>,
    pub error: Option<String>,
}

impl Progress {
    fn initial() -> Self {
        Self {
            status: Status::Probing,
            downloaded: 0,
            total: None,
            speed: 0.0,
            eta_secs: None,
            connections: 0,
            resumable: false,
            segments: vec![],
            file_name: None,
            path: None,
            content_type: None,
            error: None,
        }
    }
}

#[derive(Debug)]
pub struct Outcome {
    /// `Completed` or `Paused`.
    pub status: Status,
    pub path: Option<PathBuf>,
    pub bytes: u64,
    /// How many times an idle connection took over half of another's range.
    pub splits: usize,
    /// Bytes already on disk when this run started.
    pub resumed_from: u64,
}

pub struct DownloadHandle {
    pub progress: watch::Receiver<Progress>,
    cancel: CancellationToken,
    task: JoinHandle<Result<Outcome>>,
}

impl DownloadHandle {
    /// Stops all connections and keeps the partial file for a later resume.
    pub fn pause(&self) {
        self.cancel.cancel();
    }

    pub fn cancel_token(&self) -> CancellationToken {
        self.cancel.clone()
    }

    pub async fn wait(self) -> Result<Outcome> {
        match self.task.await {
            Ok(r) => r,
            Err(e) => Err(Error::Io(io::Error::other(e))),
        }
    }
}

/// Starts (or resumes, if a matching `.part.meta` exists) a download.
pub fn start(req: Request, opts: Options) -> DownloadHandle {
    start_with_cancel(req, opts, CancellationToken::new())
}

/// Like [`start`], pausing when `cancel` fires.
pub fn start_with_cancel(req: Request, opts: Options, cancel: CancellationToken) -> DownloadHandle {
    let (tx, rx) = watch::channel(Progress::initial());
    let c = cancel.clone();
    let task = tokio::spawn(async move {
        let r = run(&req, &opts, &tx, &c).await;
        if let Err(e) = &r {
            let msg = e.to_string();
            tx.send_modify(|p| {
                p.status = Status::Failed;
                p.speed = 0.0;
                p.error = Some(msg);
            });
        }
        r
    });
    DownloadHandle { progress: rx, cancel, task }
}

#[derive(Serialize, Deserialize)]
struct Meta {
    url: String,
    probe: Probe,
    segments: Vec<Segment>,
}

struct Ctx {
    client: Client,
    url: String,
    headers: HeaderMap,
    resumable: bool,
    validator: Option<String>,
    table: Mutex<SegmentTable>,
    file: File,
    opts: Options,
    cancel: CancellationToken,
}

pub fn build_client(opts: &Options) -> Result<Client> {
    // HTTP/1.1 only: HTTP/2 would multiplex every range onto one TCP
    // connection, which defeats the point of parallel connections.
    let mut b = Client::builder()
        .http1_only()
        .tcp_nodelay(true)
        .connect_timeout(opts.connect_timeout)
        .read_timeout(opts.read_timeout)
        .pool_max_idle_per_host(opts.connections.max(1));
    if let Some(p) = &opts.proxy {
        b = b.proxy(reqwest::Proxy::all(p)?);
    }
    Ok(b.build()?)
}

pub fn header_map(pairs: &[(String, String)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
        if let (Ok(k), Ok(v)) = (HeaderName::from_bytes(k.trim().as_bytes()), HeaderValue::from_str(v.trim())) {
            h.insert(k, v);
        }
    }
    h.entry(header::USER_AGENT).or_insert(HeaderValue::from_static(DEFAULT_USER_AGENT));
    // Byte offsets must refer to the stored file, not a decompressed view of it.
    h.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    h
}

async fn run(req: &Request, opts: &Options, tx: &watch::Sender<Progress>, cancel: &CancellationToken) -> Result<Outcome> {
    reqwest::Url::parse(&req.url).map_err(|e| Error::InvalidUrl(e.to_string()))?;
    let client = build_client(opts)?;
    let headers = header_map(&req.headers);
    let mut restarted = false;
    loop {
        match attempt(&client, &headers, req, opts, tx, cancel).await {
            Err(Error::RemoteChanged) if !restarted => restarted = true,
            r => return r,
        }
    }
}

fn with_suffix(p: &Path, suffix: &str) -> PathBuf {
    let mut s: OsString = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

/// `name.ext` → `name (1).ext`, `name (2).ext`, ... until neither the file
/// nor its `.part` exists.
pub fn unique_path(target: &Path) -> PathBuf {
    if !target.exists() && !with_suffix(target, ".part").exists() {
        return target.to_path_buf();
    }
    let stem = target.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = target.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = target.parent().unwrap_or(Path::new("."));
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists() && !with_suffix(p, ".part").exists())
        .unwrap()
}

fn read_meta(path: &Path) -> Option<Meta> {
    serde_json::from_slice(&std::fs::read(path).ok()?).ok()
}

fn write_meta(path: &Path, meta: &Meta) -> io::Result<()> {
    let tmp = with_suffix(path, ".tmp");
    std::fs::write(&tmp, serde_json::to_vec(meta)?)?;
    std::fs::rename(tmp, path)
}

fn same_remote(a: &Probe, b: &Probe) -> bool {
    a.size.is_some() && a.size == b.size && a.etag == b.etag && (a.etag.is_some() || a.last_modified == b.last_modified)
}

async fn attempt(
    client: &Client,
    headers: &HeaderMap,
    req: &Request,
    opts: &Options,
    tx: &watch::Sender<Progress>,
    cancel: &CancellationToken,
) -> Result<Outcome> {
    tx.send_modify(|p| {
        p.status = Status::Probing;
        p.error = None;
    });
    let probed = tokio::select! {
        _ = cancel.cancelled() => {
            return Ok(Outcome { status: Status::Paused, path: None, bytes: 0, splits: 0, resumed_from: 0 });
        }
        r = probe(client, &req.url, headers) => r?,
    };

    std::fs::create_dir_all(&req.dest_dir)?;
    let name = req.file_name.as_deref().map(sanitize_file_name).unwrap_or_else(|| probed.file_name.clone());
    let mut target = req.dest_dir.join(&name);

    let saved = read_meta(&with_suffix(&target, ".part.meta"))
        .filter(|m| probed.resumable && with_suffix(&target, ".part").exists() && same_remote(&m.probe, &probed));
    if saved.is_none() {
        // A leftover .part we can't trust is ours to replace only if we wrote it.
        if read_meta(&with_suffix(&target, ".part.meta")).is_some() {
            let _ = std::fs::remove_file(with_suffix(&target, ".part"));
            let _ = std::fs::remove_file(with_suffix(&target, ".part.meta"));
        }
        target = unique_path(&target);
    }
    let part_path = with_suffix(&target, ".part");
    let meta_path = with_suffix(&target, ".part.meta");

    let file = OpenOptions::new().read(true).write(true).create(true).truncate(saved.is_none()).open(&part_path)?;
    let table = match &saved {
        Some(m) => SegmentTable::from_saved(&m.segments, opts.min_split),
        None => {
            if let Some(size) = probed.size {
                file.set_len(size)?;
            }
            let parts = if probed.resumable { opts.connections.max(1) } else { 1 };
            SegmentTable::new(probed.size, parts, opts.min_split)
        }
    };
    let resumed_from = table.downloaded();
    let file_name = target.file_name().map(|n| n.to_string_lossy().into_owned());

    let ctx = Arc::new(Ctx {
        client: client.clone(),
        url: probed.final_url.clone(),
        headers: headers.clone(),
        resumable: probed.resumable,
        validator: probed.validator().map(str::to_owned),
        table: Mutex::new(table),
        file,
        opts: opts.clone(),
        cancel: cancel.child_token(),
    });
    let save = |ctx: &Ctx| -> io::Result<()> {
        if !ctx.resumable {
            return Ok(());
        }
        let segments = ctx.table.lock().unwrap().snapshot();
        write_meta(&meta_path, &Meta { url: req.url.clone(), probe: probed.clone(), segments })
    };
    save(&ctx)?;

    tx.send_modify(|p| {
        p.status = Status::Downloading;
        p.total = probed.size;
        p.resumable = probed.resumable;
        p.file_name = file_name.clone();
        p.path = Some(target.clone());
        p.content_type = probed.content_type.clone();
        p.downloaded = resumed_from;
    });

    let mut workers = JoinSet::new();
    for _ in 0..(if probed.resumable { opts.connections.max(1) } else { 1 }) {
        let Some(idx) = ctx.table.lock().unwrap().claim() else { break };
        workers.spawn(worker(ctx.clone(), idx));
    }

    let mut failure: Option<Error> = None;
    let mut tick = tokio::time::interval(Duration::from_millis(500));
    let (mut last_t, mut last_d, mut speed, mut ticks) = (Instant::now(), resumed_from, 0.0f64, 0u64);
    loop {
        tokio::select! {
            joined = workers.join_next() => match joined {
                None => break,
                Some(Ok(Ok(()))) => {}
                Some(Ok(Err(e))) => {
                    if failure.is_none() {
                        failure = Some(e);
                    }
                    ctx.cancel.cancel();
                }
                Some(Err(e)) => {
                    failure.get_or_insert(Error::Io(io::Error::other(e)));
                    ctx.cancel.cancel();
                }
            },
            _ = tick.tick() => {
                let (downloaded, segments, busy) = {
                    let t = ctx.table.lock().unwrap();
                    (t.downloaded(), t.snapshot(), t.busy_count())
                };
                let now = Instant::now();
                let dt = now.duration_since(last_t).as_secs_f64().max(1e-3);
                let inst = downloaded.saturating_sub(last_d) as f64 / dt;
                speed = if speed == 0.0 { inst } else { 0.7 * speed + 0.3 * inst };
                (last_t, last_d) = (now, downloaded);
                let eta = probed.size.filter(|_| speed > 1.0).map(|t| (t.saturating_sub(downloaded) as f64 / speed) as u64);
                tx.send_modify(|p| {
                    p.downloaded = downloaded;
                    p.speed = speed;
                    p.eta_secs = eta;
                    p.connections = busy;
                    p.segments = segments;
                });
                ticks += 1;
                if ticks % 2 == 0 {
                    save(&ctx)?;
                }
            }
        }
    }

    let (downloaded, segments, complete, splits) = {
        let t = ctx.table.lock().unwrap();
        (t.downloaded(), t.snapshot(), t.is_complete(), t.splits())
    };
    let done = |status: Status| {
        tx.send_modify(|p| {
            p.status = status;
            p.downloaded = downloaded;
            p.segments = segments.clone();
            p.speed = 0.0;
            p.eta_secs = None;
            p.connections = 0;
        })
    };

    if let Some(e) = failure {
        if matches!(e, Error::RemoteChanged) {
            drop(ctx);
            let _ = std::fs::remove_file(&part_path);
            let _ = std::fs::remove_file(&meta_path);
        } else {
            save(&ctx)?;
        }
        return Err(e);
    }
    if !complete {
        save(&ctx)?;
        if cancel.is_cancelled() {
            done(Status::Paused);
            return Ok(Outcome { status: Status::Paused, path: Some(target), bytes: downloaded, splits, resumed_from });
        }
        return Err(Error::Incomplete);
    }

    if probed.size.is_none() {
        ctx.file.set_len(downloaded)?;
    }
    ctx.file.sync_all()?;
    drop(ctx);
    let final_path = if target.exists() { unique_path(&target) } else { target };
    std::fs::rename(&part_path, &final_path)?;
    let _ = std::fs::remove_file(&meta_path);
    tx.send_modify(|p| {
        p.path = Some(final_path.clone());
        p.file_name = final_path.file_name().map(|n| n.to_string_lossy().into_owned());
    });
    done(Status::Completed);
    Ok(Outcome { status: Status::Completed, path: Some(final_path), bytes: downloaded, splits, resumed_from })
}

async fn worker(ctx: Arc<Ctx>, mut idx: usize) -> Result<()> {
    let mut failures = 0u32;
    loop {
        if ctx.cancel.is_cancelled() {
            ctx.table.lock().unwrap().release(idx);
            return Ok(());
        }
        let before = ctx.table.lock().unwrap().get(idx).pos;
        match fetch(&ctx, idx).await {
            Ok(()) => failures = 0,
            Err(e) => {
                if ctx.table.lock().unwrap().get(idx).pos > before {
                    failures = 0;
                }
                if !e.is_retryable() || failures >= ctx.opts.max_retries {
                    ctx.table.lock().unwrap().release(idx);
                    return Err(e);
                }
                failures += 1;
                let backoff = Duration::from_millis(500 * 2u64.pow(failures.min(5)));
                tokio::select! {
                    _ = ctx.cancel.cancelled() => {}
                    _ = tokio::time::sleep(backoff) => {}
                }
                continue;
            }
        }
        let next = {
            let mut t = ctx.table.lock().unwrap();
            t.release(idx);
            if ctx.cancel.is_cancelled() { None } else { t.claim() }
        };
        match next {
            Some(i) => idx = i,
            None => return Ok(()),
        }
    }
}

async fn fetch(ctx: &Ctx, idx: usize) -> Result<()> {
    let mut seg = ctx.table.lock().unwrap().get(idx);
    if seg.done() {
        return Ok(());
    }
    let mut rb = ctx.client.get(&ctx.url).headers(ctx.headers.clone());
    if ctx.resumable {
        let range = if seg.end == u64::MAX {
            format!("bytes={}-", seg.pos)
        } else {
            format!("bytes={}-{}", seg.pos, seg.end - 1)
        };
        rb = rb.header(header::RANGE, range);
        if let Some(v) = &ctx.validator {
            rb = rb.header(header::IF_RANGE, v);
        }
    } else if seg.pos > 0 {
        // No ranges: a broken connection means starting over.
        let mut t = ctx.table.lock().unwrap();
        t.rewind(idx);
        seg = t.get(idx);
    }

    let resp = tokio::select! {
        _ = ctx.cancel.cancelled() => return Ok(()),
        r = rb.send() => r?,
    };
    let status = resp.status();
    if ctx.resumable {
        if status == StatusCode::OK {
            // Range ignored: If-Range didn't match, so the file changed upstream.
            return Err(Error::RemoteChanged);
        }
        if status == StatusCode::PARTIAL_CONTENT {
            let start = resp.headers().get(header::CONTENT_RANGE).and_then(|v| v.to_str().ok()).and_then(parse_content_range_start);
            if start != Some(seg.pos) {
                return Err(Error::BadRange);
            }
        }
    }
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }

    let mut stream = std::pin::pin!(resp.bytes_stream());
    let mut pos = seg.pos;
    loop {
        let next = tokio::select! {
            _ = ctx.cancel.cancelled() => return Ok(()),
            n = stream.next() => n,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk?;
        for piece in chunk.chunks(MAX_WRITE) {
            let len = piece.len() as u64;
            tokio::select! {
                _ = ctx.cancel.cancelled() => return Ok(()),
                _ = async {
                    if let Some(g) = &ctx.opts.global_limiter {
                        g.acquire(len).await;
                    }
                    ctx.opts.limiter.acquire(len).await;
                } => {}
            }
            let n = ctx.table.lock().unwrap().allowed(idx, piece.len());
            if n == 0 {
                return Ok(());
            }
            write_at(&ctx.file, &piece[..n], pos)?;
            ctx.table.lock().unwrap().commit(idx, n as u64);
            pos += n as u64;
            if n < piece.len() {
                // The rest of this range now belongs to another connection.
                return Ok(());
            }
        }
    }
    let mut t = ctx.table.lock().unwrap();
    let seg = t.get(idx);
    if seg.end == u64::MAX {
        t.close_at_eof(idx);
        return Ok(());
    }
    if seg.done() { Ok(()) } else { Err(Error::Incomplete) }
}

#[cfg(windows)]
fn write_at(f: &File, mut buf: &[u8], mut off: u64) -> io::Result<()> {
    use std::os::windows::fs::FileExt;
    while !buf.is_empty() {
        let n = f.seek_write(buf, off)?;
        if n == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        buf = &buf[n..];
        off += n as u64;
    }
    Ok(())
}

#[cfg(unix)]
fn write_at(f: &File, buf: &[u8], off: u64) -> io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_all_at(buf, off)
}

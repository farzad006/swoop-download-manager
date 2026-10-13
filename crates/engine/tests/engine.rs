//! End-to-end engine tests against the local test server. Expected bytes are
//! always regenerated from the server's pattern, never stored.

use std::path::Path;
use std::time::Duration;

use idm_engine::{Error, Options, Request, Status};
use idm_testserver::{pattern, spawn};
use sha2::{Digest, Sha256};

fn sha(bytes: &[u8]) -> Vec<u8> {
    Sha256::digest(bytes).to_vec()
}

fn assert_file_is(path: &Path, size: u64, version: u64) {
    let got = std::fs::read(path).unwrap();
    assert_eq!(got.len() as u64, size, "size of {}", path.display());
    assert_eq!(sha(&got), sha(&pattern(size, version)), "content of {}", path.display());
}

fn req(url: String, dir: &Path) -> Request {
    Request { url, headers: vec![], dest_dir: dir.to_path_buf(), file_name: None }
}

/// Waits until at least `bytes` are on disk, then pauses.
async fn pause_after(handle: &idm_engine::DownloadHandle, bytes: u64) {
    let mut rx = handle.progress.clone();
    tokio::time::timeout(Duration::from_secs(30), async {
        loop {
            if rx.borrow().downloaded >= bytes {
                break;
            }
            rx.changed().await.unwrap();
        }
    })
    .await
    .expect("download never reached the pause point");
    handle.pause();
}

#[tokio::test(flavor = "multi_thread")]
async fn multi_connection_download_matches_source() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 5 * 1024 * 1024 + 123;
    let h = idm_engine::start(req(srv.url(&format!("/file/{size}?name=big.bin")), dir.path()), Options::default());
    let out = h.wait().await.unwrap();
    assert_eq!(out.status, Status::Completed);
    let path = out.path.unwrap();
    assert_eq!(path.file_name().unwrap(), "big.bin", "name comes from Content-Disposition");
    assert_file_is(&path, size, 0);
    assert!(!dir.path().join("big.bin.part").exists());
    assert!(!dir.path().join("big.bin.part.meta").exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn server_without_ranges_uses_single_stream() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 2 * 1024 * 1024;
    let h = idm_engine::start(req(srv.url(&format!("/file/{size}?ranges=0&name=nr.bin")), dir.path()), Options::default());
    let rx = h.progress.clone();
    let out = h.wait().await.unwrap();
    assert!(!rx.borrow().resumable);
    assert_eq!(rx.borrow().segments.len(), 1);
    assert_file_is(&out.path.unwrap(), size, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn dropped_connections_are_retried_from_where_they_stopped() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 3 * 1024 * 1024;
    let h = idm_engine::start(req(srv.url(&format!("/file/{size}?drop=300000&name=d.bin")), dir.path()), Options::default());
    let out = h.wait().await.unwrap();
    assert_file_is(&out.path.unwrap(), size, 0);
    // Resuming each broken range rather than restarting it keeps waste small.
    assert!(srv.bytes_served() < size * 2, "served {} for {}", srv.bytes_served(), size);
}

#[tokio::test(flavor = "multi_thread")]
async fn pause_then_resume_continues_from_disk() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    let url = srv.url(&format!("/file/{size}?rate=300000&name=r.bin"));
    let opts = Options { connections: 4, ..Default::default() };

    let h = idm_engine::start(req(url.clone(), dir.path()), opts.clone());
    pause_after(&h, 1024 * 1024).await;
    let name = h.progress.borrow().file_name.clone();
    let out = h.wait().await.unwrap();
    assert_eq!(out.status, Status::Paused);
    assert!(dir.path().join("r.bin.part").exists());
    assert!(dir.path().join("r.bin.part.meta").exists());

    let served_before = srv.bytes_served();
    let h = idm_engine::start(Request { file_name: name, ..req(url, dir.path()) }, opts);
    let out = h.wait().await.unwrap();
    assert_eq!(out.status, Status::Completed);
    assert!(out.resumed_from >= 1024 * 1024, "resumed from {}", out.resumed_from);
    assert!(srv.bytes_served() - served_before < size, "resume must not refetch the whole file");
    assert_file_is(&out.path.unwrap(), size, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn idle_connections_take_over_slow_ranges() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 4 * 1024 * 1024;
    // First half is instant, second half crawls: connections that finish the
    // fast half must split the slow ranges.
    let url = srv.url(&format!("/file/{size}?slow_from={}&rate=1000000&name=s.bin", size / 2));
    let opts = Options { connections: 4, min_split: 64 * 1024, ..Default::default() };
    let out = idm_engine::start(req(url, dir.path()), opts).wait().await.unwrap();
    assert!(out.splits > 0, "expected dynamic splits");
    assert_file_is(&out.path.unwrap(), size, 0);
}

#[tokio::test(flavor = "multi_thread")]
async fn file_replaced_while_paused_restarts_cleanly() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 3 * 1024 * 1024;
    let url = srv.url(&format!("/file/{size}?rate=300000&name=e.bin"));
    let opts = Options { connections: 4, ..Default::default() };

    let h = idm_engine::start(req(url.clone(), dir.path()), opts.clone());
    pause_after(&h, 512 * 1024).await;
    let name = h.progress.borrow().file_name.clone();
    h.wait().await.unwrap();

    srv.set_version(1);
    let out = idm_engine::start(Request { file_name: name, ..req(url, dir.path()) }, opts).wait().await.unwrap();
    assert_eq!(out.resumed_from, 0, "stale partial data must be discarded");
    assert_file_is(&out.path.unwrap(), size, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn file_replaced_mid_download_restarts_cleanly() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size = 3 * 1024 * 1024;
    // Frequent drops force reconnects, which carry If-Range.
    let url = srv.url(&format!("/file/{size}?rate=1000000&drop=200000&name=m.bin"));
    let h = idm_engine::start(req(url, dir.path()), Options::default());
    let mut rx = h.progress.clone();
    while rx.borrow().downloaded < 300 * 1024 {
        rx.changed().await.unwrap();
    }
    srv.set_version(1);
    let out = h.wait().await.unwrap();
    assert_file_is(&out.path.unwrap(), size, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn existing_file_gets_numbered_name() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let url = srv.url("/file/100000?name=dup.bin");
    let a = idm_engine::start(req(url.clone(), dir.path()), Options::default()).wait().await.unwrap();
    let b = idm_engine::start(req(url, dir.path()), Options::default()).wait().await.unwrap();
    assert_eq!(a.path.unwrap().file_name().unwrap(), "dup.bin");
    assert_eq!(b.path.unwrap().file_name().unwrap(), "dup (1).bin");
}

#[tokio::test(flavor = "multi_thread")]
async fn forbidden_link_reports_expired() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let h = idm_engine::start(req(srv.url("/file/1000?status=403"), dir.path()), Options::default());
    let rx = h.progress.clone();
    let err = h.wait().await.unwrap_err();
    assert!(matches!(err, Error::LinkExpired(403)), "{err:?}");
    assert_eq!(rx.borrow().status, Status::Failed);
}

#[tokio::test(flavor = "multi_thread")]
async fn speed_limit_is_respected() {
    let srv = spawn().await;
    let dir = tempfile::tempdir().unwrap();
    let size: u64 = 1024 * 1024;
    let limit: u64 = 512 * 1024;
    let opts = Options { limiter: std::sync::Arc::new(idm_engine::RateLimiter::new(limit)), ..Default::default() };
    let t = std::time::Instant::now();
    let out = idm_engine::start(req(srv.url(&format!("/file/{size}?name=l.bin")), dir.path()), opts).wait().await.unwrap();
    // The bucket starts empty, so the whole file must take about size/limit.
    let min = Duration::from_secs_f64(size as f64 / limit as f64 * 0.8);
    assert!(t.elapsed() >= min, "took {:?}, limit implies at least {:?}", t.elapsed(), min);
    assert_file_is(&out.path.unwrap(), size, 0);
}

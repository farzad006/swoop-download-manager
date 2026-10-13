//! `cargo run -p swoop-engine --release --example get -- <url> [dest_dir] [connections]`
//! Ctrl+C pauses; run the same command again to resume.

use std::path::PathBuf;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
    let url = args.next().expect("usage: get <url> [dest_dir] [connections]");
    let dest_dir = args.next().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let connections = args.next().and_then(|c| c.parse().ok()).unwrap_or(8);

    // Resume by reusing the name of an unfinished download of the same URL.
    let file_name = std::fs::read_dir(&dest_dir).ok().and_then(|rd| {
        rd.filter_map(|e| e.ok()).find_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let base = name.strip_suffix(".part.meta")?.to_owned();
            let meta: serde_json::Value = serde_json::from_slice(&std::fs::read(e.path()).ok()?).ok()?;
            (meta["url"] == url).then_some(base)
        })
    });

    let opts = swoop_engine::Options { connections, ..Default::default() };
    let req = swoop_engine::Request { url, headers: vec![], dest_dir, file_name };
    let handle = swoop_engine::start(req, opts);
    let cancel = handle.cancel_token();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        cancel.cancel();
    });

    let mut rx = handle.progress.clone();
    let printer = tokio::spawn(async move {
        while rx.changed().await.is_ok() {
            let p = rx.borrow().clone();
            let pct = p.total.map(|t| format!("{:5.1}%", p.downloaded as f64 * 100.0 / t.max(1) as f64)).unwrap_or_default();
            eprint!(
                "\r{:?} {} {:.2} MB {} {:.2} MB/s conns={} segs={}      ",
                p.status,
                p.file_name.as_deref().unwrap_or(""),
                p.downloaded as f64 / 1e6,
                pct,
                p.speed / 1e6,
                p.connections,
                p.segments.len()
            );
        }
    });
    let started = std::time::Instant::now();
    let result = handle.wait().await;
    printer.abort();
    eprintln!();
    match result {
        Ok(o) => println!(
            "{:?}: {} ({} bytes, resumed from {}, {} dynamic splits, {:.1}s)",
            o.status,
            o.path.map(|p| p.display().to_string()).unwrap_or_default(),
            o.bytes,
            o.resumed_from,
            o.splits,
            started.elapsed().as_secs_f64()
        ),
        Err(e) => {
            eprintln!("failed: {e}");
            std::process::exit(1);
        }
    }
}

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use swoop_engine::{CancellationToken, Options, RateLimiter, Request, Status};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::capture::{Pending, VideoCapture};
use crate::categories::{category_for, folder_for};
use crate::db::Db;
use crate::model::{AfterQueue, DownloadRecord, Kind, NewDownload, ProgressEvent, Queue, Settings};
use crate::video::{self, VideoJob};
use crate::windows;

struct Active {
    cancel: CancellationToken,
    /// Set when the queue started it, so it counts against the queue's limit.
    queue: Option<i64>,
}

pub struct Manager {
    pub app: AppHandle,
    pub data_dir: PathBuf,
    db: Mutex<Db>,
    active: Mutex<HashMap<i64, Active>>,
    running_queues: Mutex<HashSet<i64>>,
    settings: RwLock<Settings>,
    global_limiter: Arc<RateLimiter>,
    pub pending: Mutex<HashMap<String, Pending>>,
    /// Browsers ticked in the installer, handed to the first-run welcome.
    pub browser_selection: Mutex<Vec<String>>,
    /// Video lookups, remembered for 10 minutes (see `prefetch_video`).
    pub video_cache: video::InfoCache,
    /// At most two lookups run in advance at once.
    prefetch_slots: Arc<tokio::sync::Semaphore>,
}

impl Manager {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&data_dir)?;
        let db = Db::open(&data_dir.join("swoop.db"))?;
        repair_finished_videos(&db);
        let mut settings = db.settings()?;
        if settings.download_root.is_empty() {
            settings.download_root = default_download_root().to_string_lossy().into_owned();
            db.save_settings(&settings)?;
        }
        let global_limiter = Arc::new(RateLimiter::new(settings.speed_limit_kbps * 1024));
        Ok(Arc::new(Self {
            app,
            data_dir,
            db: Mutex::new(db),
            active: Mutex::new(HashMap::new()),
            running_queues: Mutex::new(HashSet::new()),
            settings: RwLock::new(settings),
            global_limiter,
            pending: Mutex::new(HashMap::new()),
            browser_selection: Mutex::new(Vec::new()),
            video_cache: video::InfoCache::new(Duration::from_secs(600)),
            prefetch_slots: Arc::new(tokio::sync::Semaphore::new(2)),
        }))
    }

    pub fn db(&self) -> std::sync::MutexGuard<'_, Db> {
        self.db.lock().unwrap()
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    pub fn save_settings(&self, s: Settings) -> Result<()> {
        self.db().save_settings(&s)?;
        self.global_limiter.set_rate(s.speed_limit_kbps * 1024);
        *self.settings.write().unwrap() = s;
        Ok(())
    }

    /// The extension reported in from a browser: remember it and tell the setup window.
    pub fn browser_connected(&self, browser: &str) {
        let mut s = self.settings();
        s.connected_browsers.insert(browser.to_string(), crate::db::now());
        let _ = self.save_settings(s);
        let _ = self.app.emit("browser-connected", browser);
    }

    /// Category and folder IDM would pick for this file name.
    pub fn placement_for(&self, file_name: &str) -> (String, PathBuf) {
        let s = self.settings.read().unwrap();
        let category = category_for(file_name);
        (category.to_string(), folder_for(Path::new(&s.download_root), category, s.use_category_folders))
    }

    pub fn list(&self) -> Result<Vec<DownloadRecord>> {
        self.db().list()
    }

    pub fn is_active(&self, id: i64) -> bool {
        self.active.lock().unwrap().contains_key(&id)
    }

    fn emit_record(&self, id: i64) {
        if let Ok(Some(rec)) = self.db().get(id) {
            let _ = self.app.emit("download-updated", rec);
        }
    }

    pub fn add(self: &Arc<Self>, nd: NewDownload, start: bool) -> Result<i64> {
        let status = if nd.queue_id.is_some() && !start { Status::Queued } else { Status::Paused };
        let id = self.db().insert(&nd, status)?;
        self.emit_record(id);
        if start {
            self.start(id, true)?;
        } else if let Some(q) = nd.queue_id {
            if self.running_queues.lock().unwrap().contains(&q) {
                self.pump();
            }
        }
        Ok(id)
    }

    pub fn start(self: &Arc<Self>, id: i64, show_window: bool) -> Result<()> {
        self.start_inner(id, show_window, None)
    }

    fn start_inner(self: &Arc<Self>, id: i64, show_window: bool, queue: Option<i64>) -> Result<()> {
        let rec = self.db().get(id)?.ok_or_else(|| anyhow!("download {id} not found"))?;
        if rec.status == Status::Completed {
            return Ok(());
        }
        let cancel = CancellationToken::new();
        {
            let mut active = self.active.lock().unwrap();
            if active.contains_key(&id) {
                return Ok(());
            }
            active.insert(id, Active { cancel: cancel.clone(), queue });
        }
        self.db().mark_started(id)?;
        self.emit_record(id);
        if show_window && self.settings().show_progress_window {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = windows::open_progress(&app, id);
            });
        }
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let result = match rec.kind {
                Kind::Http => me.run_http(&rec, cancel).await,
                Kind::Video => me.run_video(&rec, cancel).await,
            };
            me.finish(&rec, result);
        });
        Ok(())
    }

    fn emit_progress(&self, ev: ProgressEvent) {
        let _ = self.app.emit("progress", ev);
    }

    async fn run_http(&self, rec: &DownloadRecord, cancel: CancellationToken) -> Result<Finish> {
        let s = self.settings();
        let opts = Options {
            connections: s.connections.clamp(1, 32),
            max_retries: s.max_retries,
            proxy: s.proxy.clone().filter(|p| !p.trim().is_empty()),
            global_limiter: Some(self.global_limiter.clone()),
            ..Default::default()
        };
        let req = Request {
            url: rec.url.clone(),
            headers: rec.headers.clone(),
            dest_dir: PathBuf::from(&rec.dest_dir),
            file_name: Some(rec.file_name.clone()),
        };
        let handle = swoop_engine::start_with_cancel(req, opts, cancel);
        let mut rx = handle.progress.clone();
        let id = rec.id;
        let mut name = rec.file_name.clone();
        let mut last_db = Instant::now() - Duration::from_secs(10);
        let forward = async {
            while rx.changed().await.is_ok() {
                let p = rx.borrow_and_update().clone();
                if let Some(n) = p.file_name.as_ref().filter(|n| **n != name) {
                    name = n.clone();
                    let _ = self.db().set_file(id, &name, Some(p.resumable));
                    self.emit_record(id);
                }
                if last_db.elapsed() > Duration::from_secs(2) {
                    let _ = self.db().set_progress(id, p.downloaded, p.total);
                    last_db = Instant::now();
                }
                self.emit_progress(ProgressEvent {
                    id,
                    status: p.status,
                    downloaded: p.downloaded,
                    total: p.total,
                    speed: p.speed,
                    eta_secs: p.eta_secs,
                    connections: p.connections,
                    segments: p.segments,
                    file_name: p.file_name,
                    phase: None,
                    error: p.error,
                });
            }
        };
        let (result, _) = tokio::join!(handle.wait(), forward);
        let p = rx.borrow().clone();
        match result {
            Ok(o) if o.status == Status::Completed => {
                Ok(Finish::Completed { path: o.path.unwrap_or_default(), bytes: o.bytes })
            }
            Ok(_) => Ok(Finish::Paused { downloaded: p.downloaded, total: p.total }),
            Err(e) => Err(anyhow!(e.to_string())),
        }
    }

    async fn run_video(&self, rec: &DownloadRecord, cancel: CancellationToken) -> Result<Finish> {
        let s = self.settings();
        // yt-dlp skips a download whose file already exists, so pick a free name first.
        let stem = unique_video_stem(&self.db(), rec);
        let current = Path::new(&rec.file_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        if stem != current {
            let ext = Path::new(&rec.file_name).extension().map(|e| e.to_string_lossy().into_owned()).unwrap_or_else(|| "mp4".into());
            let _ = self.db().set_file(rec.id, &format!("{stem}.{ext}"), None);
            self.emit_record(rec.id);
        }
        let job = VideoJob {
            url: &rec.url,
            headers: &rec.headers,
            cookies_file: rec.cookies_file.as_deref(),
            dest_dir: Path::new(&rec.dest_dir),
            stem: &stem,
            choice: rec.video_format.as_deref().unwrap_or("best"),
            prefer_mp4: s.prefer_mp4,
            connections: s.connections,
            speed_limit_kbps: s.speed_limit_kbps,
            proxy: s.proxy.as_deref().filter(|p| !p.trim().is_empty()),
        };
        let id = rec.id;
        let mut last = video::VideoProgress::default();
        let mut last_db = Instant::now() - Duration::from_secs(10);
        let result = video::download(job, cancel, |vp| {
            if last_db.elapsed() > Duration::from_secs(2) {
                let _ = self.db().set_progress(id, vp.downloaded, vp.total);
                last_db = Instant::now();
            }
            self.emit_progress(ProgressEvent {
                id,
                status: Status::Downloading,
                downloaded: vp.downloaded,
                total: vp.total,
                speed: vp.speed,
                eta_secs: vp.eta_secs,
                connections: 0,
                segments: vec![],
                file_name: None,
                phase: vp.phase.clone(),
                error: None,
            });
            last = vp;
        })
        .await;
        match result {
            Ok(Some(path)) => {
                let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(last.downloaded);
                if let Some(c) = &rec.cookies_file {
                    let _ = std::fs::remove_file(c);
                }
                Ok(Finish::Completed { path, bytes })
            }
            Ok(None) => Ok(Finish::Paused { downloaded: last.downloaded, total: last.total }),
            Err(e) => Err(anyhow!(e)),
        }
    }

    fn finish(self: &Arc<Self>, rec: &DownloadRecord, result: Result<Finish>) {
        self.active.lock().unwrap().remove(&rec.id);
        let id = rec.id;
        let (status, error) = match &result {
            Ok(Finish::Completed { path, bytes }) => {
                let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| rec.file_name.clone());
                let db = self.db();
                let _ = db.set_file(id, &name, None);
                let _ = db.set_progress(id, *bytes, Some(*bytes));
                let _ = db.set_status(id, Status::Completed, None);
                drop(db);
                crate::notify::download_complete(&self.app, &name, path.clone());
                (Status::Completed, None)
            }
            Ok(Finish::Paused { downloaded, total }) => {
                let db = self.db();
                let _ = db.set_progress(id, *downloaded, *total);
                let _ = db.set_status(id, Status::Paused, None);
                (Status::Paused, None)
            }
            Err(e) => {
                let msg = e.to_string();
                let _ = self.db().set_status(id, Status::Failed, Some(&msg));
                (Status::Failed, Some(msg))
            }
        };
        let rec_now = self.db().get(id).ok().flatten();
        self.emit_progress(ProgressEvent {
            id,
            status,
            downloaded: rec_now.as_ref().map(|r| r.downloaded).unwrap_or(0),
            total: rec_now.as_ref().and_then(|r| r.size),
            speed: 0.0,
            eta_secs: None,
            connections: 0,
            segments: vec![],
            file_name: rec_now.as_ref().map(|r| r.file_name.clone()),
            phase: None,
            error,
        });
        self.emit_record(id);
        self.pump();
    }

    pub fn pause(&self, id: i64) {
        if let Some(a) = self.active.lock().unwrap().get(&id) {
            a.cancel.cancel();
        }
    }

    pub fn pause_all(&self) {
        self.running_queues.lock().unwrap().clear();
        for a in self.active.lock().unwrap().values() {
            a.cancel.cancel();
        }
        let _ = self.app.emit("queues-changed", ());
    }

    /// Removes a download from the list, optionally deleting its file(s).
    pub fn delete(self: &Arc<Self>, id: i64, delete_files: bool) -> Result<()> {
        let rec = self.db().get(id)?.ok_or_else(|| anyhow!("download {id} not found"))?;
        self.pause(id);
        self.db().delete(id)?;
        let _ = self.app.emit("download-removed", id);
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            // Wait for the transfer to let go of the file before deleting it.
            for _ in 0..50 {
                if !me.is_active(id) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            let base = Path::new(&rec.dest_dir).join(&rec.file_name);
            let mut doomed = vec![append(&base, ".part"), append(&base, ".part.meta")];
            if delete_files {
                doomed.push(base.clone());
            }
            if rec.kind == Kind::Video {
                // yt-dlp leaves <stem>.<fmt>.<ext>.part pieces behind.
                if let (Some(stem), Ok(rd)) = (base.file_stem(), std::fs::read_dir(&rec.dest_dir)) {
                    let stem = stem.to_string_lossy().into_owned();
                    for e in rd.flatten() {
                        let n = e.file_name().to_string_lossy().into_owned();
                        if n.starts_with(&stem) && (n.ends_with(".part") || n.ends_with(".ytdl")) {
                            doomed.push(e.path());
                        }
                    }
                }
                if let Some(c) = &rec.cookies_file {
                    doomed.push(PathBuf::from(c));
                }
            }
            for p in doomed {
                let _ = std::fs::remove_file(p);
            }
        });
        Ok(())
    }

    /// Points an existing download at a fresh URL (expired links), keeping progress.
    pub fn refresh_address(self: &Arc<Self>, id: i64, url: &str, headers: Option<Vec<(String, String)>>) -> Result<()> {
        self.db().set_url(id, url, headers.as_deref())?;
        self.emit_record(id);
        Ok(())
    }

    pub fn queues(&self) -> Result<Vec<Queue>> {
        let running = self.running_queues.lock().unwrap().clone();
        let mut qs = self.db().queues()?;
        for q in &mut qs {
            q.running = running.contains(&q.id);
        }
        Ok(qs)
    }

    pub fn start_queue(self: &Arc<Self>, id: i64) {
        self.running_queues.lock().unwrap().insert(id);
        let _ = self.app.emit("queues-changed", ());
        self.pump();
    }

    pub fn stop_queue(&self, id: i64) {
        self.running_queues.lock().unwrap().remove(&id);
        for a in self.active.lock().unwrap().values().filter(|a| a.queue == Some(id)) {
            a.cancel.cancel();
        }
        let _ = self.app.emit("queues-changed", ());
    }

    /// Starts queued downloads up to each running queue's limit and finishes
    /// queues that have nothing left.
    pub fn pump(self: &Arc<Self>) {
        let running: Vec<i64> = self.running_queues.lock().unwrap().iter().copied().collect();
        if running.is_empty() {
            return;
        }
        let queues = self.db().queues().unwrap_or_default();
        for qid in running {
            let Some(q) = queues.iter().find(|q| q.id == qid) else { continue };
            let in_flight = self.active.lock().unwrap().values().filter(|a| a.queue == Some(qid)).count();
            let pending: Vec<i64> =
                self.db().queue_pending(qid).unwrap_or_default().into_iter().filter(|id| !self.is_active(*id)).collect();
            if pending.is_empty() && in_flight == 0 {
                self.running_queues.lock().unwrap().remove(&qid);
                let _ = self.app.emit("queues-changed", ());
                let _ = self.app.notification().builder().title("Queue finished").body(&q.name).show();
                after_queue(&self.app, q.after_done);
                continue;
            }
            for id in pending.into_iter().take(q.max_concurrent.max(1).saturating_sub(in_flight)) {
                let _ = self.start_inner(id, false, Some(qid));
            }
        }
    }

    /// Writes a Netscape cookies file for yt-dlp; `None` when there are no cookies.
    pub fn cookies_file(&self, name: &str, cookies: &[video::BrowserCookie]) -> Option<String> {
        if cookies.is_empty() {
            return None;
        }
        let dir = self.data_dir.join("cookies");
        std::fs::create_dir_all(&dir).ok()?;
        let p = dir.join(format!("{name}.txt"));
        std::fs::write(&p, video::netscape_cookies(cookies)).ok()?;
        Some(p.to_string_lossy().into_owned())
    }

    /// A page's video info, from the cache when it was looked up in advance
    /// (or waiting for that lookup if it's still running).
    pub async fn video_info(&self, cap: &VideoCapture, cookies_file: Option<&str>) -> video::InfoResult {
        let manifests: Vec<String> = cap.streams.iter().filter(|s| s.kind == "hls" || s.kind == "dash").map(|s| s.url.clone()).collect();
        let headers = cap.headers();
        self.video_cache.get_or_fetch(&cap.page_url, || video::extract(&cap.page_url, &manifests, &headers, cookies_file)).await
    }

    /// Looks a video up in the background as soon as its "Download this video"
    /// button appears, so a click opens the quality list instantly.
    pub fn prefetch_video(self: &Arc<Self>, cap: VideoCapture) {
        if !self.settings().video_prefetch || self.video_cache.is_known(&cap.page_url) {
            return;
        }
        let Ok(permit) = self.prefetch_slots.clone().try_acquire_owned() else { return };
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let _permit = permit;
            let cookies = me.cookies_file(&format!("prefetch-{:x}", rand_token()), &cap.cookies);
            let _ = me.video_info(&cap, cookies.as_deref()).await;
            if let Some(c) = cookies {
                let _ = std::fs::remove_file(c);
            }
        });
    }

    /// "Download this video" with a remembered quality: starts the download
    /// without the dialog. Falls back to the dialog if the video can't be read,
    /// so the user still sees why (and any directly downloadable files).
    pub fn quick_video(self: &Arc<Self>, cap: VideoCapture, choice: String) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let cookies = me.cookies_file(&format!("dl-{:x}", rand_token()), &cap.cookies);
            match me.video_info(&cap, cookies.as_deref()).await {
                Ok((info, source)) => {
                    let ext = if choice == "audio" { "mp3" } else { "mp4" };
                    let file_name = swoop_engine::sanitize_file_name(&format!("{}.{ext}", info.title.chars().take(180).collect::<String>()));
                    let (category, dir) = me.placement_for(&file_name);
                    let added = me.add(
                        NewDownload {
                            url: source,
                            page_url: Some(cap.page_url.clone()),
                            file_name,
                            dest_dir: dir.to_string_lossy().into_owned(),
                            category,
                            size: None,
                            headers: cap.headers(),
                            kind: Kind::Video,
                            video_format: Some(choice),
                            cookies_file: cookies,
                            queue_id: None,
                            description: info.title,
                            resumable: true,
                        },
                        true,
                    );
                    if let Err(e) = added {
                        log::warn!("quick video download failed to start: {e}");
                    }
                }
                Err(_) => {
                    if let Some(c) = cookies {
                        let _ = std::fs::remove_file(c);
                    }
                    let token = me.put_pending(Pending::Video(cap));
                    let _ = windows::open_dialog(&me.app, "video", &token);
                }
            }
        });
    }

    pub fn put_pending(&self, p: Pending) -> String {
        let token = format!("{:x}", rand_token());
        self.pending.lock().unwrap().insert(token.clone(), p);
        token
    }
}

enum Finish {
    Completed { path: PathBuf, bytes: u64 },
    Paused { downloaded: u64, total: Option<u64> },
}

fn append(p: &Path, suffix: &str) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(suffix);
    PathBuf::from(s)
}

fn rand_token() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut h = std::collections::hash_map::RandomState::new().build_hasher();
    h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());
    h.finish()
}

/// The name (without extension) a video download should save under. If a
/// finished file or another unfinished download already uses it, " (1)",
/// " (2)", … is added, so downloading the same title again makes a new file
/// instead of yt-dlp skipping it. A download keeps its own name when resuming
/// (its partial files don't count as taken).
pub fn unique_video_stem(db: &Db, rec: &DownloadRecord) -> String {
    let dir = Path::new(&rec.dest_dir);
    let stem_of = |name: &str| Path::new(name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| name.to_string());
    let own = stem_of(&rec.file_name);
    let others: HashSet<String> = db
        .list()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d.id != rec.id && d.status != Status::Completed && Path::new(&d.dest_dir) == dir)
        .map(|d| stem_of(&d.file_name))
        .collect();
    let has_any_file = |stem: &str| {
        let prefix = format!("{stem}.");
        std::fs::read_dir(dir).map(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().starts_with(&prefix))).unwrap_or(false)
    };
    let taken = |stem: &str, is_own: bool| {
        others.contains(stem) || video::find_output(dir, stem).is_some() || (!is_own && has_any_file(stem))
    };
    if !taken(&own, true) {
        return own;
    }
    (1..).map(|n| format!("{own} ({n})")).find(|c| !taken(c, false)).unwrap()
}

/// Before 1.0.2, a title with characters like ’ or – made Swoop miss yt-dlp's
/// "saved to" line, so finished videos were marked failed. Marks those
/// completed when the finished file is on disk.
pub fn repair_finished_videos(db: &Db) -> usize {
    let mut fixed = 0;
    for d in db.list().unwrap_or_default() {
        let lost_report = d.error.as_deref().is_some_and(|e| e.contains("finished without reporting a file"));
        if d.kind != Kind::Video || d.status != Status::Failed || !lost_report {
            continue;
        }
        let stem = Path::new(&d.file_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let Some(path) = video::find_output(Path::new(&d.dest_dir), &stem) else { continue };
        let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or(d.file_name.clone());
        if db.set_file(d.id, &name, None).is_ok() && db.set_progress(d.id, size, Some(size)).is_ok() && db.set_status(d.id, Status::Completed, None).is_ok() {
            fixed += 1;
        }
    }
    fixed
}

pub fn default_download_root() -> PathBuf {
    std::env::var_os("USERPROFILE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("C:\\")).join("Downloads")
}

fn after_queue(app: &AppHandle, action: AfterQueue) {
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    use std::os::windows::process::CommandExt;
    match action {
        AfterQueue::Nothing => {}
        AfterQueue::Exit => app.exit(0),
        AfterQueue::Sleep => {
            let _ = std::process::Command::new("rundll32.exe")
                .args(["powrprof.dll,SetSuspendState", "0,1,0"])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
        AfterQueue::Shutdown => {
            // One minute's grace; `shutdown /a` cancels.
            let _ = std::process::Command::new("shutdown")
                .args(["/s", "/t", "60", "/c", "Swoop: download queue finished. Run 'shutdown /a' to cancel."])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn video(name: &str, dir: &Path) -> NewDownload {
        NewDownload {
            url: "https://example.com/watch".into(),
            page_url: None,
            file_name: name.into(),
            dest_dir: dir.to_string_lossy().into_owned(),
            category: "Video".into(),
            size: None,
            headers: vec![],
            kind: Kind::Video,
            video_format: Some("best".into()),
            cookies_file: None,
            queue_id: None,
            description: String::new(),
            resumable: true,
        }
    }

    #[test]
    fn same_title_again_gets_a_numbered_name() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let dir = tmp.path();

        // Nothing there yet: the name is used as is.
        let first = db.insert(&video("abc.mp4", dir), Status::Paused).unwrap();
        assert_eq!(unique_video_stem(&db, &db.get(first).unwrap().unwrap()), "abc");

        // abc.mp4 finished; downloading "abc" again must not reuse the name.
        std::fs::write(dir.join("abc.mp4"), b"done").unwrap();
        db.set_status(first, Status::Completed, None).unwrap();
        let second = db.insert(&video("abc.mp4", dir), Status::Paused).unwrap();
        assert_eq!(unique_video_stem(&db, &db.get(second).unwrap().unwrap()), "abc (1)");

        // A third copy while the second is still unfinished: (1) is taken by it.
        db.set_file(second, "abc (1).mp4", None).unwrap();
        let third = db.insert(&video("abc.mp4", dir), Status::Paused).unwrap();
        assert_eq!(unique_video_stem(&db, &db.get(third).unwrap().unwrap()), "abc (2)");

        // Resuming keeps its own name even though its partial files exist.
        std::fs::write(dir.join("abc (1).f137.mp4.part"), b"half").unwrap();
        assert_eq!(unique_video_stem(&db, &db.get(second).unwrap().unwrap()), "abc (1)");

        // Someone else's leftover partial files also make a name taken.
        std::fs::write(dir.join("xyz.f22.mp4.part"), b"orphan").unwrap();
        let fresh = db.insert(&video("xyz.mp4", dir), Status::Paused).unwrap();
        assert_eq!(unique_video_stem(&db, &db.get(fresh).unwrap().unwrap()), "xyz", "own name: partials may be its own resume");
    }

    /// With yt-dlp: downloading the same title twice used to skip the second
    /// one ("already downloaded"). Offline (local test server); skipped when
    /// yt-dlp isn't installed.
    #[tokio::test(flavor = "multi_thread")]
    async fn same_title_twice_saves_two_files() {
        if video::find_binary("yt-dlp").is_none() {
            eprintln!("yt-dlp not installed; skipping");
            return;
        }
        let srv = swoop_testserver::spawn().await;
        let url = srv.url("/file/200000?name=clip.mp4&type=video/mp4");
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let mut saved = Vec::new();
        for _ in 0..2 {
            let id = db.insert(&video("abc.mp4", tmp.path()), Status::Paused).unwrap();
            let stem = unique_video_stem(&db, &db.get(id).unwrap().unwrap());
            db.set_file(id, &format!("{stem}.mp4"), None).unwrap();
            let job = VideoJob {
                url: &url,
                headers: &[],
                cookies_file: None,
                dest_dir: tmp.path(),
                stem: &stem,
                choice: "best",
                prefer_mp4: true,
                connections: 4,
                speed_limit_kbps: 0,
                proxy: None,
            };
            let path = video::download(job, CancellationToken::new(), |_| {}).await.unwrap().unwrap();
            db.set_status(id, Status::Completed, None).unwrap();
            saved.push(path);
        }
        assert_ne!(saved[0], saved[1], "the second download needs its own file");
        assert!(saved.iter().all(|p| p.is_file()), "{saved:?}");
        assert!(saved[1].file_name().unwrap().to_string_lossy().starts_with("abc (1)"), "{saved:?}");
    }

    #[test]
    fn finished_videos_wrongly_marked_failed_are_repaired() {
        let tmp = tempfile::tempdir().unwrap();
        let db = Db::open(&tmp.path().join("t.db")).unwrap();
        let on_disk = db.insert(&video("Friend\u{2019}s mom.mp4", tmp.path()), Status::Paused).unwrap();
        std::fs::write(tmp.path().join("Friend\u{2019}s mom.mp4"), vec![7u8; 1234]).unwrap();
        db.set_status(on_disk, Status::Failed, Some("yt-dlp finished without reporting a file")).unwrap();
        let missing = db.insert(&video("Not there.mp4", tmp.path()), Status::Paused).unwrap();
        db.set_status(missing, Status::Failed, Some("yt-dlp finished without reporting a file")).unwrap();
        let other_error = db.insert(&video("Other.mp4", tmp.path()), Status::Paused).unwrap();
        std::fs::write(tmp.path().join("Other.mp4"), b"x").unwrap();
        db.set_status(other_error, Status::Failed, Some("This video is DRM-protected")).unwrap();

        assert_eq!(repair_finished_videos(&db), 1);
        let fixed = db.get(on_disk).unwrap().unwrap();
        assert_eq!(fixed.status, Status::Completed);
        assert_eq!((fixed.downloaded, fixed.size), (1234, Some(1234)));
        assert_eq!(db.get(missing).unwrap().unwrap().status, Status::Failed, "no file, stays failed");
        assert_eq!(db.get(other_error).unwrap().unwrap().status, Status::Failed, "other errors untouched");
    }
}

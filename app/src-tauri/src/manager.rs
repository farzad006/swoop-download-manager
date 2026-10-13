use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use idm_engine::{CancellationToken, Options, RateLimiter, Request, Status};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::capture::Pending;
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
}

impl Manager {
    pub fn new(app: AppHandle, data_dir: PathBuf) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&data_dir)?;
        let db = Db::open(&data_dir.join("ouridm.db"))?;
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
        let handle = idm_engine::start_with_cancel(req, opts, cancel);
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
        let stem = Path::new(&rec.file_name).file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| rec.file_name.clone());
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
                let _ = self.app.notification().builder().title("Download complete").body(&name).show();
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
                .args(["/s", "/t", "60", "/c", "OurIDM: download queue finished. Run 'shutdown /a' to cancel."])
                .creation_flags(CREATE_NO_WINDOW)
                .spawn();
        }
    }
}

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::background;
use crate::capture::{self, MediaStream, Pending};
use crate::manager::Manager;
use crate::model::{DownloadRecord, Kind, NewDownload, Queue, Settings};
use crate::video::{self, VideoInfo};

type Mgr<'a> = State<'a, Arc<Manager>>;
type Res<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_downloads(mgr: Mgr) -> Res<Vec<DownloadRecord>> {
    mgr.list().map_err(err)
}

#[tauri::command]
pub fn get_download(mgr: Mgr, id: i64) -> Res<Option<DownloadRecord>> {
    mgr.db().get(id).map_err(err)
}

#[tauri::command]
pub fn add_download(mgr: Mgr, download: NewDownload, start: bool) -> Res<i64> {
    mgr.add(download, start).map_err(err)
}

#[tauri::command]
pub fn add_many(mgr: Mgr, downloads: Vec<NewDownload>, start: bool) -> Res<Vec<i64>> {
    downloads.into_iter().map(|d| mgr.add(d, start).map_err(err)).collect()
}

#[tauri::command]
pub fn start_download(mgr: Mgr, id: i64) -> Res<()> {
    mgr.start(id, true).map_err(err)
}

#[tauri::command]
pub fn pause_download(mgr: Mgr, id: i64) {
    mgr.pause(id);
}

#[tauri::command]
pub fn pause_all(mgr: Mgr) {
    mgr.pause_all();
}

#[tauri::command]
pub fn delete_download(mgr: Mgr, id: i64, delete_file: bool) -> Res<()> {
    mgr.delete(id, delete_file).map_err(err)
}

#[tauri::command]
pub fn delete_completed(mgr: Mgr) -> Res<()> {
    for d in mgr.list().map_err(err)? {
        if d.status == idm_engine::Status::Completed {
            mgr.delete(d.id, false).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn refresh_address(mgr: Mgr, id: i64, url: String) -> Res<()> {
    mgr.refresh_address(id, &url, None).map_err(err)
}

fn record_path(mgr: &Manager, id: i64) -> Res<PathBuf> {
    let d = mgr.db().get(id).map_err(err)?.ok_or("download not found")?;
    Ok(Path::new(&d.dest_dir).join(d.file_name))
}

#[tauri::command]
pub fn open_file(app: AppHandle, mgr: Mgr, id: i64) -> Res<()> {
    let p = record_path(&mgr, id)?;
    app.opener().open_path(p.to_string_lossy(), None::<&str>).map_err(err)
}

#[tauri::command]
pub fn open_folder(app: AppHandle, mgr: Mgr, id: i64) -> Res<()> {
    let p = record_path(&mgr, id)?;
    if p.exists() {
        app.opener().reveal_item_in_dir(p).map_err(err)
    } else {
        let dir = p.parent().map(Path::to_path_buf).unwrap_or_default();
        app.opener().open_path(dir.to_string_lossy(), None::<&str>).map_err(err)
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub file_name: String,
    pub size: Option<u64>,
    pub resumable: bool,
    pub content_type: Option<String>,
    pub final_url: String,
    pub category: String,
    pub dest_dir: String,
}

#[tauri::command]
pub async fn probe_url(mgr: Mgr<'_>, url: String, headers: Vec<(String, String)>) -> Res<ProbeResult> {
    let p = capture::probe(&mgr, &url, &headers).await?;
    let (category, dir) = mgr.placement_for(&p.file_name);
    Ok(ProbeResult {
        file_name: p.file_name,
        size: p.size,
        resumable: p.resumable,
        content_type: p.content_type,
        final_url: p.final_url,
        category,
        dest_dir: dir.to_string_lossy().into_owned(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Placement {
    pub category: String,
    pub dest_dir: String,
}

#[tauri::command]
pub fn placement_for(mgr: Mgr, file_name: String) -> Placement {
    let (category, dir) = mgr.placement_for(&file_name);
    Placement { category, dest_dir: dir.to_string_lossy().into_owned() }
}

#[tauri::command]
pub fn get_settings(mgr: Mgr) -> Settings {
    mgr.settings()
}

#[tauri::command]
pub fn save_settings(app: AppHandle, mgr: Mgr, settings: Settings) -> Res<()> {
    let autostart = app.autolaunch();
    if settings.start_with_windows != autostart.is_enabled().unwrap_or(false) {
        let r = if settings.start_with_windows { autostart.enable() } else { autostart.disable() };
        r.map_err(err)?;
    }
    mgr.save_settings(settings).map_err(err)
}

#[tauri::command]
pub fn list_queues(mgr: Mgr) -> Res<Vec<Queue>> {
    mgr.queues().map_err(err)
}

#[tauri::command]
pub fn save_queue(mgr: Mgr, queue: Queue) -> Res<i64> {
    let id = mgr.db().save_queue(&queue).map_err(err)?;
    Ok(id)
}

#[tauri::command]
pub fn delete_queue(mgr: Mgr, id: i64) -> Res<()> {
    mgr.stop_queue(id);
    mgr.db().delete_queue(id).map_err(err)
}

#[tauri::command]
pub fn start_queue(mgr: Mgr, id: i64) {
    mgr.start_queue(id);
}

#[tauri::command]
pub fn stop_queue(mgr: Mgr, id: i64) {
    mgr.stop_queue(id);
}

#[tauri::command]
pub fn set_download_queue(mgr: Mgr, id: i64, queue_id: Option<i64>) -> Res<()> {
    let db = mgr.db();
    db.set_queue(id, queue_id).map_err(err)?;
    if let (Some(_), Ok(Some(d))) = (queue_id, db.get(id)) {
        if matches!(d.status, idm_engine::Status::Paused | idm_engine::Status::Failed) {
            db.set_status(id, idm_engine::Status::Queued, None).map_err(err)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn get_pending(mgr: Mgr, token: String) -> Res<Pending> {
    mgr.pending.lock().unwrap().get(&token).cloned().ok_or_else(|| "This request has expired.".into())
}

#[tauri::command]
pub fn close_pending(mgr: Mgr, token: String) {
    mgr.pending.lock().unwrap().remove(&token);
    let _ = std::fs::remove_file(mgr.data_dir.join("cookies").join(format!("{token}.txt")));
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfoResult {
    pub info: Option<VideoInfo>,
    /// URL yt-dlp could read: the page, or one of the sniffed manifests.
    pub source_url: Option<String>,
    pub error: Option<String>,
    pub title: Option<String>,
    pub page_url: String,
    pub streams: Vec<MediaStream>,
}

fn video_capture(mgr: &Manager, token: &str) -> Res<capture::VideoCapture> {
    match mgr.pending.lock().unwrap().get(token) {
        Some(Pending::Video(v)) => Ok(v.clone()),
        _ => Err("This request has expired.".into()),
    }
}

#[tauri::command]
pub async fn video_info(mgr: Mgr<'_>, token: String) -> Res<VideoInfoResult> {
    let cap = video_capture(&mgr, &token)?;
    let cookies_file = if cap.cookies.is_empty() {
        None
    } else {
        let dir = mgr.data_dir.join("cookies");
        std::fs::create_dir_all(&dir).map_err(err)?;
        let p = dir.join(format!("{token}.txt"));
        std::fs::write(&p, video::netscape_cookies(&cap.cookies)).map_err(err)?;
        Some(p.to_string_lossy().into_owned())
    };
    let headers = cap.headers();
    let mut candidates = vec![cap.page_url.clone()];
    candidates.extend(cap.streams.iter().filter(|s| s.kind == "hls" || s.kind == "dash").map(|s| s.url.clone()));
    let mut error = None;
    for url in candidates {
        match video::info(&url, &headers, cookies_file.as_deref()).await {
            Ok(info) => {
                return Ok(VideoInfoResult {
                    info: Some(info),
                    source_url: Some(url),
                    error: None,
                    title: cap.title.clone(),
                    page_url: cap.page_url.clone(),
                    streams: cap.streams.clone(),
                });
            }
            Err(e) => {
                let drm = e.contains("DRM");
                error = Some(e);
                if drm {
                    break;
                }
            }
        }
    }
    Ok(VideoInfoResult { info: None, source_url: None, error, title: cap.title, page_url: cap.page_url, streams: cap.streams })
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn add_video(
    mgr: Mgr,
    token: String,
    source_url: String,
    choice: String,
    file_name: String,
    dest_dir: String,
    start: bool,
    queue_id: Option<i64>,
) -> Res<i64> {
    let cap = video_capture(&mgr, &token)?;
    // Each download gets its own copy; the token's file goes when the dialog closes.
    let cookies_file = {
        let src = mgr.data_dir.join("cookies").join(format!("{token}.txt"));
        src.is_file()
            .then(|| {
                let dst = mgr.data_dir.join("cookies").join(format!("dl-{}-{token}.txt", chrono::Utc::now().timestamp_millis()));
                std::fs::copy(&src, &dst).ok().map(|_| dst.to_string_lossy().into_owned())
            })
            .flatten()
    };
    let category = if choice == "audio" { "Music" } else { "Video" };
    mgr.add(
        NewDownload {
            url: source_url,
            page_url: Some(cap.page_url.clone()),
            file_name: idm_engine::sanitize_file_name(&file_name),
            dest_dir,
            category: category.into(),
            size: None,
            headers: cap.headers(),
            kind: Kind::Video,
            video_format: Some(choice),
            cookies_file,
            queue_id,
            description: cap.title.unwrap_or_default(),
            resumable: true,
        },
        start,
    )
    .map_err(err)
}

/// Downloads a sniffed media file directly with the segmented engine.
#[tauri::command]
pub fn add_stream_direct(mgr: Mgr, token: String, url: String, file_name: String, dest_dir: String, start: bool) -> Res<i64> {
    let cap = video_capture(&mgr, &token)?;
    let mut headers = cap.headers();
    if let Some(c) = capture::cookie_header_for(&url, &cap.cookies) {
        headers.push(("Cookie".into(), c));
    }
    let file_name = idm_engine::sanitize_file_name(&file_name);
    let (category, _) = mgr.placement_for(&file_name);
    mgr.add(
        NewDownload {
            url,
            page_url: Some(cap.page_url),
            file_name,
            dest_dir,
            category,
            size: None,
            headers,
            kind: Kind::Http,
            video_format: None,
            cookies_file: None,
            queue_id: None,
            description: cap.title.unwrap_or_default(),
            resumable: false,
        },
        start,
    )
    .map_err(err)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStatus {
    pub ytdlp: Option<String>,
    pub ffmpeg: Option<String>,
    pub native_host: Option<String>,
    /// Folder holding `chrome-mv3` and `firefox-mv2` extension builds.
    pub extension_dir: Option<String>,
    pub chrome_extension_id: &'static str,
    pub firefox_extension_id: &'static str,
    pub version: &'static str,
}

#[tauri::command]
pub fn tool_status(app: AppHandle) -> ToolStatus {
    use tauri::Manager as _;
    let s = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    // Installed: bundled resources. Development: the repo's build output.
    let extension_dir = [
        app.path().resource_dir().ok().map(|d| d.join("extension")),
        std::env::current_exe().ok().and_then(|e| Some(e.parent()?.parent()?.parent()?.join("extension").join(".output"))),
    ]
    .into_iter()
    .flatten()
    .find(|d| d.join("chrome-mv3").join("manifest.json").is_file());
    ToolStatus {
        ytdlp: s(video::find_binary("yt-dlp")),
        ffmpeg: s(video::find_binary("ffmpeg")),
        native_host: s(background::host_exe()),
        extension_dir: s(extension_dir),
        chrome_extension_id: background::CHROME_EXTENSION_ID,
        firefox_extension_id: background::FIREFOX_EXTENSION_ID,
        version: env!("CARGO_PKG_VERSION"),
    }
}

#[tauri::command]
pub fn show_main(app: AppHandle) {
    crate::windows::show_main(&app);
}

/// Simulates a capture from the browser, for the "Add URL" flow and testing.
#[tauri::command]
pub async fn capture_url(mgr: Mgr<'_>, url: String) -> Res<()> {
    let d = capture::DownloadCapture {
        url,
        referrer: None,
        page_url: None,
        cookies: None,
        user_agent: None,
        file_name: None,
        file_size: None,
        mime: None,
        force_dialog: true,
    };
    capture::capture(&mgr, Pending::Download(d)).await;
    Ok(())
}

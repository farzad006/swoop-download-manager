use idm_engine::Status;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Http,
    Video,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadRecord {
    pub id: i64,
    pub url: String,
    pub page_url: Option<String>,
    pub file_name: String,
    pub dest_dir: String,
    pub category: String,
    pub status: Status,
    pub size: Option<u64>,
    pub downloaded: u64,
    pub headers: Vec<(String, String)>,
    pub kind: Kind,
    /// yt-dlp quality choice for video downloads (`best`, `h1080`, `audio`, ...).
    pub video_format: Option<String>,
    /// Path of a Netscape cookies file handed to yt-dlp.
    pub cookies_file: Option<String>,
    pub queue_id: Option<i64>,
    pub description: String,
    pub error: Option<String>,
    pub resumable: bool,
    pub added_at: i64,
    pub last_try_at: Option<i64>,
    pub completed_at: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewDownload {
    pub url: String,
    pub page_url: Option<String>,
    pub file_name: String,
    pub dest_dir: String,
    pub category: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub kind: Kind,
    #[serde(default)]
    pub video_format: Option<String>,
    #[serde(default)]
    pub cookies_file: Option<String>,
    #[serde(default)]
    pub queue_id: Option<i64>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub resumable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AfterQueue {
    Nothing,
    Exit,
    Sleep,
    Shutdown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Schedule {
    /// "HH:MM", local time.
    pub start_time: Option<String>,
    pub stop_time: Option<String>,
    /// 0 = Sunday ... 6 = Saturday. Empty means every day.
    #[serde(default)]
    pub days: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Queue {
    pub id: i64,
    pub name: String,
    pub max_concurrent: usize,
    pub schedule: Option<Schedule>,
    pub after_done: AfterQueue,
    /// Filled in at read time from the manager, not stored.
    #[serde(default)]
    pub running: bool,
}

pub const MAIN_QUEUE: i64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub connections: usize,
    pub max_retries: u32,
    /// KB/s, 0 = unlimited.
    pub speed_limit_kbps: u64,
    pub download_root: String,
    pub use_category_folders: bool,
    pub capture_extensions: Vec<String>,
    pub capture_min_size_kb: u64,
    pub excluded_sites: Vec<String>,
    pub show_capture_dialog: bool,
    pub show_progress_window: bool,
    pub show_complete_dialog: bool,
    pub clipboard_monitor: bool,
    pub start_with_windows: bool,
    pub video_panel: bool,
    pub proxy: Option<String>,
    pub prefer_mp4: bool,
    pub update_ytdlp: bool,
    /// The first-run welcome has been completed.
    pub onboarded: bool,
    /// Browser id → unix time the extension last said hello from it.
    pub connected_browsers: std::collections::BTreeMap<String, i64>,
}

pub const DEFAULT_CAPTURE_EXTENSIONS: &str = "3GP 7Z AAC ACE AIF APK ARJ ASF AVI BIN BZ2 EXE GZ GZIP IMG ISO LZH M4A M4V MKV MOV MP3 MP4 MPA MPE MPEG MPG MSI MSU OGG OGV PDF PLJ PPS PPT QT R0* R1* RA RAR RM RMVB SEA SIT SITX TAR TIF TIFF WAV WEBM WMA WMV Z ZIP DMG DEB RPM XZ ZST FLAC OPUS EPUB TORRENT";

impl Default for Settings {
    fn default() -> Self {
        Self {
            connections: 8,
            max_retries: 10,
            speed_limit_kbps: 0,
            download_root: String::new(),
            use_category_folders: true,
            capture_extensions: DEFAULT_CAPTURE_EXTENSIONS.split_whitespace().map(str::to_owned).collect(),
            capture_min_size_kb: 0,
            excluded_sites: vec!["*.update.microsoft.com".into(), "download.windowsupdate.com".into()],
            show_capture_dialog: true,
            show_progress_window: true,
            show_complete_dialog: true,
            clipboard_monitor: true,
            start_with_windows: false,
            video_panel: true,
            proxy: None,
            prefer_mp4: true,
            update_ytdlp: true,
            connected_browsers: Default::default(),
            onboarded: false,
        }
    }
}

/// Live state pushed to the UI on the `progress` event.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub id: i64,
    pub status: Status,
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed: f64,
    pub eta_secs: Option<u64>,
    pub connections: usize,
    pub segments: Vec<idm_engine::Segment>,
    pub file_name: Option<String>,
    pub phase: Option<String>,
    pub error: Option<String>,
}

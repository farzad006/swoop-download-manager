//! Site video downloads through yt-dlp (+ ffmpeg for merging audio and video).

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Finds a helper executable next to the app (bundled sidecar) or on PATH.
pub fn find_binary(name: &str) -> Option<PathBuf> {
    let file = format!("{name}.exe");
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
        dirs.push(dir.join("binaries"));
        dirs.push(dir);
    }
    if let Some(path) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path));
    }
    dirs.into_iter().map(|d| d.join(&file)).find(|p| p.is_file())
}

fn ytdlp() -> Result<PathBuf, String> {
    find_binary("yt-dlp").ok_or_else(|| "yt-dlp was not found. Put yt-dlp.exe next to Swoop or on PATH.".into())
}

fn command(exe: &Path) -> Command {
    let mut c = Command::new(exe);
    c.creation_flags(CREATE_NO_WINDOW).stdin(Stdio::null()).kill_on_drop(true);
    // Python writes to pipes in the Windows code page by default; titles with
    // characters outside it (’ – …) must come through intact.
    c.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    c
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    /// `best`, `h<height>` or `audio`.
    pub id: String,
    pub label: String,
    pub height: Option<u32>,
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoInfo {
    pub title: String,
    pub thumbnail: Option<String>,
    pub duration: Option<f64>,
    pub extractor: String,
    pub webpage_url: String,
    pub is_live: bool,
    pub choices: Vec<Choice>,
}

fn common_args(headers: &[(String, String)], cookies_file: Option<&str>) -> Vec<String> {
    let mut a = vec!["--no-playlist".into(), "--no-warnings".into(), "--windows-filenames".into()];
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("cookie") && cookies_file.is_some() {
            continue;
        }
        if k.eq_ignore_ascii_case("user-agent") {
            a.extend(["--user-agent".into(), v.clone()]);
        } else {
            a.extend(["--add-header".into(), format!("{k}:{v}")]);
        }
    }
    if let Some(c) = cookies_file {
        a.extend(["--cookies".into(), c.into()]);
    }
    a
}

pub fn friendly_error(stderr: &str) -> String {
    let last = stderr.lines().rev().find(|l| l.starts_with("ERROR:")).or_else(|| stderr.lines().rev().find(|l| !l.trim().is_empty()));
    let msg = last.unwrap_or("yt-dlp failed").trim_start_matches("ERROR:").trim().to_string();
    if msg.contains("DRM") {
        "This video is DRM-protected and can't be downloaded.".into()
    } else if msg.contains("Unsupported URL") {
        "This site isn't supported for video extraction.".into()
    } else {
        msg
    }
}

/// A connection that dropped or stalled mid-request, as opposed to an answer
/// from the site ("video not found", DRM, unsupported, …).
pub fn is_transient(err: &str) -> bool {
    let e = err.to_ascii_lowercase();
    [
        "unexpected_eof",
        "eof occurred in violation of protocol",
        "connection reset",
        "connection aborted",
        "remote end closed connection",
        "timed out",
        "temporary failure in name resolution",
        "connection refused",
        "transporterror",
    ]
    .iter()
    .any(|k| e.contains(k))
}

/// Hosts where IPv4 rescued a dropped connection; later requests go straight to IPv4.
static IPV4_HOSTS: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::LazyLock::new(Default::default);

/// Retry policy for connections that drop mid-request. Some sites' IPv6
/// servers cut off a share of connections (seen over VPN tunnels such as
/// Cloudflare WARP) while IPv4 works; browsers hide this by retrying, yt-dlp
/// doesn't. Up to 3 attempts, switching to IPv4 after the first failure and
/// remembering hosts where that helped.
pub struct NetworkRetry {
    host: Option<String>,
    pub ipv4: bool,
    started_ipv4: bool,
    attempt: u32,
}

impl NetworkRetry {
    pub const MAX_ATTEMPTS: u32 = 3;

    pub fn new(url: &str) -> Self {
        let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_owned));
        let ipv4 = host.as_ref().is_some_and(|h| IPV4_HOSTS.lock().unwrap().contains(h));
        Self { host, ipv4, started_ipv4: ipv4, attempt: 1 }
    }

    /// After a failed attempt: how long to wait before trying again, or `None` to give up.
    pub fn should_retry(&mut self, err: &str) -> Option<std::time::Duration> {
        if !is_transient(err) || self.attempt >= Self::MAX_ATTEMPTS {
            return None;
        }
        self.attempt += 1;
        self.ipv4 = true;
        Some(std::time::Duration::from_millis(400 * self.attempt as u64))
    }

    pub fn succeeded(&self) {
        if self.ipv4 && !self.started_ipv4 {
            if let Some(h) = &self.host {
                IPV4_HOSTS.lock().unwrap().insert(h.clone());
            }
        }
    }

    pub fn give_up_message(&self, err: String) -> String {
        if !is_transient(&err) {
            return err;
        }
        let site = self.host.as_deref().map(|h| h.trim_start_matches("www.")).unwrap_or("the site");
        format!("The connection to {site} kept dropping (tried {} times). Check your internet or VPN, then try again.", self.attempt)
    }
}

pub async fn info(url: &str, headers: &[(String, String)], cookies_file: Option<&str>) -> Result<VideoInfo, String> {
    let mut retry = NetworkRetry::new(url);
    loop {
        match info_once(url, headers, cookies_file, retry.ipv4).await {
            Ok(i) => {
                retry.succeeded();
                return Ok(i);
            }
            Err(e) => match retry.should_retry(&e) {
                Some(wait) => tokio::time::sleep(wait).await,
                None => return Err(retry.give_up_message(e)),
            },
        }
    }
}

async fn info_once(url: &str, headers: &[(String, String)], cookies_file: Option<&str>, force_ipv4: bool) -> Result<VideoInfo, String> {
    let mut cmd = command(&ytdlp()?);
    cmd.arg("-J").args(common_args(headers, cookies_file));
    if force_ipv4 {
        cmd.arg("--force-ipv4");
    }
    let out = cmd
        .arg("--")
        .arg(url)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .await
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(friendly_error(&String::from_utf8_lossy(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    Ok(parse_info(&v))
}

fn fsize(f: &Value) -> Option<u64> {
    f["filesize"].as_u64().or_else(|| f["filesize_approx"].as_u64())
}

pub fn parse_info(v: &Value) -> VideoInfo {
    let formats = v["formats"].as_array().cloned().unwrap_or_default();
    let is_video = |f: &Value| f["vcodec"].as_str().is_some_and(|c| c != "none");
    let is_audio_only = |f: &Value| f["vcodec"].as_str() == Some("none") && f["acodec"].as_str().is_some_and(|c| c != "none");
    let tbr = |f: &Value| f["tbr"].as_f64().unwrap_or(0.0);

    let best_audio = formats.iter().filter(|f| is_audio_only(f)).max_by(|a, b| tbr(a).total_cmp(&tbr(b)));
    let audio_size = best_audio.and_then(fsize);

    let mut heights: Vec<u32> = formats.iter().filter(|f| is_video(f)).filter_map(|f| f["height"].as_u64().map(|h| h as u32)).collect();
    heights.sort_unstable_by(|a, b| b.cmp(a));
    heights.dedup();

    let mut choices = vec![Choice { id: "best".into(), label: "Best quality".into(), height: heights.first().copied(), size: None }];
    for h in heights {
        let best = formats
            .iter()
            .filter(|f| is_video(f) && f["height"].as_u64() == Some(h as u64))
            .max_by(|a, b| tbr(a).total_cmp(&tbr(b)));
        let size = best.and_then(|f| {
            let vs = fsize(f)?;
            let has_audio = f["acodec"].as_str().is_some_and(|c| c != "none");
            Some(if has_audio { vs } else { vs + audio_size.unwrap_or(0) })
        });
        choices.push(Choice { id: format!("h{h}"), label: format!("{h}p"), height: Some(h), size });
    }
    if best_audio.is_some() || formats.is_empty() {
        choices.push(Choice { id: "audio".into(), label: "Audio only (MP3)".into(), height: None, size: audio_size });
    }
    // "Best" resolves to the top resolution.
    choices[0].size = choices.get(1).filter(|c| c.height.is_some()).and_then(|c| c.size);

    VideoInfo {
        title: v["title"].as_str().unwrap_or("video").to_string(),
        thumbnail: v["thumbnail"].as_str().map(str::to_owned),
        duration: v["duration"].as_f64(),
        extractor: v["extractor_key"].as_str().or(v["extractor"].as_str()).unwrap_or("").to_string(),
        webpage_url: v["webpage_url"].as_str().unwrap_or("").to_string(),
        is_live: v["is_live"].as_bool().unwrap_or(false),
        choices,
    }
}

/// What a page's video info lookup produced: the info and the URL yt-dlp could
/// read (the page itself or a sniffed stream manifest).
pub type InfoResult = Result<(VideoInfo, String), String>;

/// Remembers video lookups for a while so the quality dialog opens instantly
/// when the lookup already ran in advance (or is still running: callers wait
/// for that same lookup instead of starting another yt-dlp).
pub struct InfoCache {
    ttl: std::time::Duration,
    entries: std::sync::Mutex<std::collections::HashMap<String, (std::time::Instant, std::sync::Arc<tokio::sync::OnceCell<InfoResult>>)>>,
}

impl InfoCache {
    pub fn new(ttl: std::time::Duration) -> Self {
        Self { ttl, entries: Default::default() }
    }

    pub fn is_known(&self, key: &str) -> bool {
        self.entries.lock().unwrap().get(key).is_some_and(|(at, _)| at.elapsed() < self.ttl)
    }

    pub async fn get_or_fetch<F, Fut>(&self, key: &str, fetch: F) -> InfoResult
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = InfoResult>,
    {
        let cell = {
            let mut m = self.entries.lock().unwrap();
            m.retain(|_, (at, _)| at.elapsed() < self.ttl);
            m.entry(key.to_string()).or_insert_with(|| (std::time::Instant::now(), Default::default())).1.clone()
        };
        let result = cell.get_or_init(fetch).await.clone();
        if result.is_err() {
            // Don't remember failures: the next click should try again.
            let mut m = self.entries.lock().unwrap();
            if m.get(key).is_some_and(|(_, c)| std::sync::Arc::ptr_eq(c, &cell)) {
                m.remove(key);
            }
        }
        result
    }
}

/// Looks up a page's video: the page first, then any stream manifests the
/// extension spotted. Stops early on DRM (nothing else will work).
pub async fn extract(page_url: &str, manifests: &[String], headers: &[(String, String)], cookies_file: Option<&str>) -> InfoResult {
    let mut error = String::from("No downloadable video was found on this page.");
    for url in std::iter::once(page_url.to_string()).chain(manifests.iter().cloned()) {
        match info(&url, headers, cookies_file).await {
            Ok(i) => return Ok((i, url)),
            Err(e) => {
                let drm = e.contains("DRM");
                error = e;
                if drm {
                    break;
                }
            }
        }
    }
    Err(error)
}

/// yt-dlp arguments selecting the quality the user picked.
pub fn format_args(choice: &str, prefer_mp4: bool) -> Vec<String> {
    let sort = |res: Option<&str>| {
        let mut s = Vec::new();
        if let Some(r) = res {
            s.push(format!("res:{r}"));
        }
        if prefer_mp4 {
            s.push("ext:mp4:m4a".into());
        }
        s
    };
    let mut a: Vec<String> = Vec::new();
    match choice {
        "audio" => a.extend(["-f".into(), "ba/b".into(), "-x".into(), "--audio-format".into(), "mp3".into()]),
        c if c.starts_with('h') => {
            let h = &c[1..];
            a.extend(["-f".into(), format!("bv*[height<={h}]+ba/b[height<={h}]/bv*+ba/b")]);
            let s = sort(Some(h));
            a.extend(["-S".into(), s.join(",")]);
        }
        _ => {
            a.extend(["-f".into(), "bv*+ba/b".into()]);
            let s = sort(None);
            if !s.is_empty() {
                a.extend(["-S".into(), s.join(",")]);
            }
        }
    }
    if prefer_mp4 && choice != "audio" {
        a.extend(["--merge-output-format".into(), "mp4".into()]);
    }
    a
}

#[derive(Clone, Debug, Default)]
pub struct VideoProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
    pub speed: f64,
    pub eta_secs: Option<u64>,
    pub phase: Option<String>,
}

pub struct VideoJob<'a> {
    pub url: &'a str,
    pub headers: &'a [(String, String)],
    pub cookies_file: Option<&'a str>,
    pub dest_dir: &'a Path,
    /// File name without extension; yt-dlp appends the real one.
    pub stem: &'a str,
    pub choice: &'a str,
    pub prefer_mp4: bool,
    pub connections: usize,
    pub speed_limit_kbps: u64,
    pub proxy: Option<&'a str>,
}

/// Runs a download. Returns the final file path, or `Ok(None)` when cancelled
/// (yt-dlp keeps its `.part` files and resumes next time).
pub async fn download(
    job: VideoJob<'_>,
    cancel: CancellationToken,
    mut on_progress: impl FnMut(VideoProgress),
) -> Result<Option<PathBuf>, String> {
    // A dropped connection is retried (over IPv4); yt-dlp resumes its partial files.
    let mut retry = NetworkRetry::new(job.url);
    loop {
        match download_once(&job, &cancel, &mut on_progress, retry.ipv4).await {
            Ok(r) => {
                retry.succeeded();
                return Ok(r);
            }
            Err(e) => match retry.should_retry(&e) {
                Some(wait) => tokio::select! {
                    _ = cancel.cancelled() => return Ok(None),
                    _ = tokio::time::sleep(wait) => {}
                },
                None => return Err(retry.give_up_message(e)),
            },
        }
    }
}

async fn download_once(
    job: &VideoJob<'_>,
    cancel: &CancellationToken,
    on_progress: &mut impl FnMut(VideoProgress),
    force_ipv4: bool,
) -> Result<Option<PathBuf>, String> {
    std::fs::create_dir_all(job.dest_dir).map_err(|e| e.to_string())?;
    let template = job.dest_dir.join(format!("{}.%(ext)s", job.stem.replace('%', "%%")));
    let mut cmd = command(&ytdlp()?);
    cmd.args(format_args(job.choice, job.prefer_mp4))
        .args(common_args(job.headers, job.cookies_file))
        .args(["-N", &job.connections.clamp(1, 16).to_string()])
        .args(["--newline", "--progress", "--progress-template", "download:IDMP%(progress)j"])
        .args(["--print", "after_move:IDMF%(filepath)j", "--no-mtime", "--continue"])
        .arg("-o")
        .arg(&template);
    if let Some(ff) = find_binary("ffmpeg") {
        cmd.arg("--ffmpeg-location").arg(ff);
    }
    if job.speed_limit_kbps > 0 {
        cmd.args(["-r", &format!("{}K", job.speed_limit_kbps)]);
    }
    if let Some(p) = job.proxy {
        cmd.args(["--proxy", p]);
    }
    if force_ipv4 {
        cmd.arg("--force-ipv4");
    }
    cmd.arg("--").arg(job.url).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("couldn't start yt-dlp: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut out = String::new();
        let (mut reader, mut buf) = (BufReader::new(stderr), Vec::new());
        while let Some(l) = next_line(&mut reader, &mut buf).await {
            out.push_str(&l);
            out.push('\n');
        }
        out
    });

    let (mut reader, mut buf) = (BufReader::new(stdout), Vec::new());
    let mut final_path = None;
    let (mut done_bytes, mut cur_file, mut cur_total) = (0u64, String::new(), 0u64);
    loop {
        let line = tokio::select! {
            _ = cancel.cancelled() => {
                kill_tree(pid).await;
                let _ = child.wait().await;
                return Ok(None);
            }
            l = next_line(&mut reader, &mut buf) => l,
        };
        let Some(line) = line else { break };
        if let Some(json) = line.strip_prefix("IDMP") {
            let Ok(p) = serde_json::from_str::<Value>(json) else { continue };
            let file = p["filename"].as_str().unwrap_or("").to_string();
            if file != cur_file {
                if !cur_file.is_empty() {
                    done_bytes += cur_total;
                }
                cur_file = file;
            }
            let total = p["total_bytes"].as_f64().or(p["total_bytes_estimate"].as_f64()).map(|t| t as u64);
            cur_total = total.unwrap_or(cur_total);
            let finished = p["status"].as_str() == Some("finished");
            on_progress(VideoProgress {
                downloaded: done_bytes + p["downloaded_bytes"].as_f64().unwrap_or(0.0) as u64,
                total: total.map(|t| done_bytes + t),
                speed: p["speed"].as_f64().unwrap_or(0.0),
                eta_secs: p["eta"].as_f64().map(|e| e as u64),
                phase: finished.then(|| "Processing".to_string()),
            });
        } else if let Some(path) = line.strip_prefix("IDMF") {
            // A JSON string (`%(filepath)j`): ASCII-only, so any title survives.
            let path = path.trim();
            final_path = Some(PathBuf::from(serde_json::from_str::<String>(path).unwrap_or_else(|_| path.to_string())));
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(friendly_error(&stderr));
    }
    // yt-dlp succeeded; if its "saved to" line still went missing, look for the file.
    final_path
        .filter(|p| p.is_file())
        .or_else(|| find_output(job.dest_dir, job.stem))
        .map(Some)
        .ok_or_else(|| "yt-dlp finished without reporting a file".into())
}

/// Next line of a child's output. Bytes that aren't valid UTF-8 are replaced
/// rather than ending the stream: one odd character in a title used to stop
/// Swoop listening before yt-dlp reported the saved file.
async fn next_line<R: tokio::io::AsyncBufRead + Unpin>(r: &mut R, buf: &mut Vec<u8>) -> Option<String> {
    buf.clear();
    match r.read_until(b'\n', buf).await {
        Ok(0) | Err(_) => None,
        Ok(_) => Some(String::from_utf8_lossy(buf).trim_end_matches(['\r', '\n']).to_string()),
    }
}

/// The finished file `<stem>.<ext>` in `dir` (newest if several), ignoring
/// yt-dlp's partial and intermediate files.
pub fn find_output(dir: &Path, stem: &str) -> Option<PathBuf> {
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter(|e| {
            let p = e.path();
            let ext = p.extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
            p.file_stem().is_some_and(|s| s.to_string_lossy() == stem) && !matches!(ext.as_str(), "part" | "ytdl" | "temp" | "")
        })
        .max_by_key(|e| e.metadata().and_then(|m| m.modified()).ok())
        .map(|e| e.path())
}

async fn kill_tree(pid: Option<u32>) {
    if let Some(pid) = pid {
        let _ = Command::new("taskkill")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .output()
            .await;
    }
}

/// Keeps yt-dlp current (sites change their players often), at most once a
/// day. A standalone yt-dlp.exe updates itself; a pip install (the exe lives in
/// a Python `Scripts` folder) is upgraded with that Python's pip.
pub async fn update_ytdlp(stamp_file: PathBuf) {
    let fresh = std::fs::metadata(&stamp_file)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(24 * 3600));
    let Some(exe) = find_binary("yt-dlp") else { return };
    if fresh {
        return;
    }
    let dir = exe.parent().map(Path::to_path_buf).unwrap_or_default();
    let python = dir.file_name().filter(|n| n.eq_ignore_ascii_case("Scripts")).and_then(|_| dir.parent()).map(|p| p.join("python.exe"));
    let result = match python.filter(|p| p.is_file()) {
        Some(py) => command(&py).args(["-m", "pip", "install", "-U", "--quiet", "yt-dlp"]).output().await,
        None => command(&exe).arg("-U").output().await,
    };
    if result.is_ok() {
        let _ = std::fs::write(&stamp_file, b"");
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    #[serde(default = "slash")]
    pub path: String,
    #[serde(default)]
    pub secure: bool,
    #[serde(default)]
    pub host_only: bool,
    pub expiration_date: Option<f64>,
}

fn slash() -> String {
    "/".into()
}

/// Netscape cookies.txt, the format yt-dlp reads.
pub fn netscape_cookies(cookies: &[BrowserCookie]) -> String {
    let mut s = String::from("# Netscape HTTP Cookie File\n");
    for c in cookies {
        let domain = if c.host_only { c.domain.trim_start_matches('.').to_string() } else if c.domain.starts_with('.') { c.domain.clone() } else { format!(".{}", c.domain) };
        let sub = if c.host_only { "FALSE" } else { "TRUE" };
        let secure = if c.secure { "TRUE" } else { "FALSE" };
        let exp = c.expiration_date.map(|e| e as i64).unwrap_or(0);
        s.push_str(&format!("{domain}\t{sub}\t{}\t{secure}\t{exp}\t{}\t{}\n", c.path, c.name, c.value));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn choices_from_formats() {
        let v = serde_json::json!({
            "title": "Clip", "extractor_key": "Youtube", "webpage_url": "https://x",
            "formats": [
                {"format_id": "140", "vcodec": "none", "acodec": "mp4a", "tbr": 128.0, "filesize": 1000},
                {"format_id": "137", "vcodec": "avc1", "acodec": "none", "height": 1080, "tbr": 4000.0, "filesize": 50000},
                {"format_id": "136", "vcodec": "avc1", "acodec": "none", "height": 720, "tbr": 2000.0, "filesize": 20000},
                {"format_id": "18", "vcodec": "avc1", "acodec": "mp4a", "height": 360, "tbr": 500.0, "filesize": 5000}
            ]
        });
        let info = parse_info(&v);
        let ids: Vec<_> = info.choices.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["best", "h1080", "h720", "h360", "audio"]);
        let get = |id: &str| info.choices.iter().find(|c| c.id == id).unwrap().size;
        assert_eq!(get("h1080"), Some(51000), "video-only adds best audio");
        assert_eq!(get("h360"), Some(5000), "muxed format stands alone");
        assert_eq!(get("best"), get("h1080"));
        assert_eq!(get("audio"), Some(1000));
    }

    #[test]
    fn format_args_by_choice() {
        let a = format_args("h720", true);
        assert!(a.windows(2).any(|w| w[0] == "-S" && w[1] == "res:720,ext:mp4:m4a"));
        assert!(a.contains(&"--merge-output-format".to_string()));
        let a = format_args("audio", true);
        assert!(a.contains(&"-x".to_string()) && !a.contains(&"--merge-output-format".to_string()));
    }

    #[test]
    fn drm_errors_are_explained() {
        assert!(friendly_error("ERROR: [Foo] 123: This video is DRM protected").contains("DRM-protected"));
    }

    const SSL_EOF: &str = "[Eporner] abc: Unable to download JSON metadata: [SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1010)";

    #[test]
    fn dropped_connections_are_transient_site_answers_are_not() {
        assert!(is_transient(SSL_EOF));
        assert!(is_transient("ERROR: Unable to download webpage: <urlopen error [Errno 10054] Connection reset by peer>"));
        assert!(is_transient("Read timed out. (read timeout=20.0)"));
        assert!(!is_transient("This video is DRM-protected and can't be downloaded."));
        assert!(!is_transient("ERROR: [generic] Unsupported URL: https://example.com"));
        assert!(!is_transient("ERROR: Video unavailable"));
    }

    #[test]
    fn retry_switches_to_ipv4_gives_up_after_three_and_remembers_the_host() {
        let mut r = NetworkRetry::new("https://www.retry-test-a.example/video/1");
        assert!(!r.ipv4, "first attempt uses the normal route");
        assert!(r.should_retry(SSL_EOF).is_some());
        assert!(r.ipv4, "retries go over IPv4");
        assert!(r.should_retry(SSL_EOF).is_some());
        assert!(r.should_retry(SSL_EOF).is_none(), "three attempts in total");
        let msg = r.give_up_message(SSL_EOF.to_string());
        assert!(msg.contains("retry-test-a.example") && msg.contains("3 times"), "{msg}");

        // Site answers aren't retried and keep their own message.
        let mut r = NetworkRetry::new("https://www.retry-test-b.example/v");
        assert!(r.should_retry("This video is DRM-protected and can't be downloaded.").is_none());
        assert_eq!(r.give_up_message("Video unavailable".into()), "Video unavailable");

        // IPv4 rescued this host: the next request starts on IPv4.
        let mut r = NetworkRetry::new("https://www.retry-test-c.example/v/1");
        r.should_retry(SSL_EOF);
        r.succeeded();
        assert!(NetworkRetry::new("https://www.retry-test-c.example/v/2").ipv4);
        assert!(!NetworkRetry::new("https://www.retry-test-d.example/v").ipv4, "other sites unaffected");
    }

    fn fake_info(title: &str) -> VideoInfo {
        VideoInfo {
            title: title.into(),
            thumbnail: None,
            duration: None,
            extractor: String::new(),
            webpage_url: String::new(),
            is_live: false,
            choices: vec![],
        }
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn cache_runs_one_lookup_for_simultaneous_requests() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let cache = std::sync::Arc::new(InfoCache::new(std::time::Duration::from_secs(600)));
        let calls = std::sync::Arc::new(AtomicUsize::new(0));
        let lookup = |cache: std::sync::Arc<InfoCache>, calls: std::sync::Arc<AtomicUsize>| async move {
            cache
                .get_or_fetch("https://site/watch?v=1", || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                    Ok((fake_info("A"), "https://site/watch?v=1".to_string()))
                })
                .await
        };
        // An advance lookup and a click arriving while it's still running.
        let (a, b) = tokio::join!(lookup(cache.clone(), calls.clone()), lookup(cache.clone(), calls.clone()));
        assert_eq!(a.unwrap().0.title, "A");
        assert_eq!(b.unwrap().0.title, "A");
        // A later click is answered from the cache.
        lookup(cache.clone(), calls.clone()).await.unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1, "only one yt-dlp lookup should run");
        assert!(cache.is_known("https://site/watch?v=1"));
    }

    #[tokio::test]
    async fn cache_forgets_failures_and_expires() {
        let cache = InfoCache::new(std::time::Duration::from_millis(100));
        let failed = cache.get_or_fetch("k", || async { Err("network down".to_string()) }).await;
        assert!(failed.is_err());
        assert!(!cache.is_known("k"), "a failure must not stick");
        let ok = cache.get_or_fetch("k", || async { Ok((fake_info("B"), "k".to_string())) }).await;
        assert_eq!(ok.unwrap().0.title, "B");
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(!cache.is_known("k"), "entries expire");
    }

    /// Titles with characters outside the Windows code page (’ – and the
    /// replacement character some sites put in titles) used to make Swoop lose
    /// yt-dlp's "saved to" line and mark finished downloads as failed. Runs
    /// offline against the local test server; skipped when yt-dlp isn't installed.
    #[tokio::test(flavor = "multi_thread")]
    async fn titles_with_special_characters_complete() {
        if find_binary("yt-dlp").is_none() {
            eprintln!("yt-dlp not installed; skipping");
            return;
        }
        let srv = swoop_testserver::spawn().await;
        let size = 300_000u64;
        let url = srv.url(&format!("/file/{size}?name=clip.mp4&type=video/mp4"));
        let dir = tempfile::tempdir().unwrap();
        let stem = "Friend\u{2019}s mom \u{2013} broken \u{FFFD} title";
        let job = VideoJob {
            url: &url,
            headers: &[],
            cookies_file: None,
            dest_dir: dir.path(),
            stem,
            choice: "best",
            prefer_mp4: true,
            connections: 4,
            speed_limit_kbps: 0,
            proxy: None,
        };
        let path = download(job, CancellationToken::new(), |_| {})
            .await
            .expect("a finished download must be reported as finished")
            .expect("not cancelled");
        assert!(path.is_file(), "reported path must exist: {}", path.display());
        assert!(path.file_name().unwrap().to_string_lossy().starts_with("Friend\u{2019}s mom"), "{}", path.display());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), size);
    }

    /// Network + yt-dlp + ffmpeg. `cargo test -p swoop -- --ignored public_hls`
    #[tokio::test]
    #[ignore]
    async fn downloads_public_hls_stream() {
        let url = "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8";
        let info = info(url, &[], None).await.unwrap();
        // Ask for the smallest resolution the stream offers.
        let lowest = info.choices.iter().filter_map(|c| c.height).min().expect("stream lists resolutions");
        let choice = format!("h{lowest}");
        let dir = tempfile::tempdir().unwrap();
        let mut updates = 0;
        let mut last = VideoProgress::default();
        let job = VideoJob {
            url,
            headers: &[],
            cookies_file: None,
            dest_dir: dir.path(),
            stem: "bipbop",
            choice: &choice,
            prefer_mp4: true,
            connections: 8,
            speed_limit_kbps: 0,
            proxy: None,
        };
        let path = download(job, CancellationToken::new(), |p| {
            updates += 1;
            last = p;
        })
        .await
        .unwrap()
        .unwrap();
        assert!(updates > 0, "progress was reported");
        assert!(last.downloaded > 0);
        assert_eq!(path.extension().unwrap(), "mp4");
        let probe = std::process::Command::new(find_binary("ffprobe").unwrap())
            .args(["-v", "error", "-show_entries", "stream=codec_type,height", "-of", "csv=p=0"])
            .arg(&path)
            .output()
            .unwrap();
        let streams = String::from_utf8_lossy(&probe.stdout);
        assert!(streams.contains("video"), "{streams}");
        assert!(streams.contains("audio"), "audio merged in: {streams}");
        let height: u32 = streams.lines().find_map(|l| l.strip_prefix("video,")).unwrap().trim().parse().unwrap();
        assert_eq!(height, lowest, "picked the requested resolution");
    }

    #[test]
    fn netscape_format() {
        let c = BrowserCookie {
            name: "SID".into(),
            value: "v".into(),
            domain: "youtube.com".into(),
            path: "/".into(),
            secure: true,
            host_only: false,
            expiration_date: Some(1.9e9),
        };
        let s = netscape_cookies(&[c]);
        assert!(s.lines().nth(1).unwrap().starts_with(".youtube.com\tTRUE\t/\tTRUE\t1900000000\tSID\tv"));
    }
}

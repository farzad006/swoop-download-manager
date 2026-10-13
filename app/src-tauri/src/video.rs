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

pub async fn info(url: &str, headers: &[(String, String)], cookies_file: Option<&str>) -> Result<VideoInfo, String> {
    let out = command(&ytdlp()?)
        .arg("-J")
        .args(common_args(headers, cookies_file))
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
    std::fs::create_dir_all(job.dest_dir).map_err(|e| e.to_string())?;
    let template = job.dest_dir.join(format!("{}.%(ext)s", job.stem.replace('%', "%%")));
    let mut cmd = command(&ytdlp()?);
    cmd.args(format_args(job.choice, job.prefer_mp4))
        .args(common_args(job.headers, job.cookies_file))
        .args(["-N", &job.connections.clamp(1, 16).to_string()])
        .args(["--newline", "--progress", "--progress-template", "download:IDMP%(progress)j"])
        .args(["--print", "after_move:IDMF%(filepath)s", "--no-mtime", "--continue"])
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
    cmd.arg("--").arg(job.url).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("couldn't start yt-dlp: {e}"))?;
    let pid = child.id();
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let err_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            buf.push_str(&l);
            buf.push('\n');
        }
        buf
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut final_path = None;
    let (mut done_bytes, mut cur_file, mut cur_total) = (0u64, String::new(), 0u64);
    loop {
        let line = tokio::select! {
            _ = cancel.cancelled() => {
                kill_tree(pid).await;
                let _ = child.wait().await;
                return Ok(None);
            }
            l = lines.next_line() => l,
        };
        let Ok(Some(line)) = line else { break };
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
            final_path = Some(PathBuf::from(path.trim()));
        }
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = err_task.await.unwrap_or_default();
    if !status.success() {
        return Err(friendly_error(&stderr));
    }
    final_path.map(Some).ok_or_else(|| "yt-dlp finished without reporting a file".into())
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

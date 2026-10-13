//! Messages from the browser extension (via the native host) and from the
//! clipboard monitor, and the pending dialogs they open.

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::manager::Manager;
use crate::model::{Kind, NewDownload};
use crate::video::BrowserCookie;
use crate::windows;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadCapture {
    pub url: String,
    #[serde(default)]
    pub referrer: Option<String>,
    #[serde(default)]
    pub page_url: Option<String>,
    /// `name=value; name2=value2` for the download URL.
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub file_size: Option<u64>,
    #[serde(default)]
    pub mime: Option<String>,
    /// Always ask, even when the "show dialog" option is off (context menu).
    #[serde(default)]
    pub force_dialog: bool,
}

impl DownloadCapture {
    pub fn headers(&self) -> Vec<(String, String)> {
        let mut h = Vec::new();
        if let Some(c) = self.cookies.as_ref().filter(|c| !c.is_empty()) {
            h.push(("Cookie".into(), c.clone()));
        }
        if let Some(r) = self.referrer.as_ref().or(self.page_url.as_ref()).filter(|r| !r.is_empty()) {
            h.push(("Referer".into(), r.clone()));
        }
        if let Some(ua) = self.user_agent.as_ref().filter(|u| !u.is_empty()) {
            h.push(("User-Agent".into(), ua.clone()));
        }
        h
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaStream {
    pub url: String,
    /// `hls`, `dash` or `file`.
    pub kind: String,
    #[serde(default)]
    pub mime: Option<String>,
    #[serde(default)]
    pub size: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCapture {
    pub page_url: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub streams: Vec<MediaStream>,
    #[serde(default, skip_serializing)]
    pub cookies: Vec<BrowserCookie>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

impl VideoCapture {
    pub fn headers(&self) -> Vec<(String, String)> {
        let mut h = vec![("Referer".to_string(), self.page_url.clone())];
        if let Some(ua) = self.user_agent.as_ref().filter(|u| !u.is_empty()) {
            h.push(("User-Agent".into(), ua.clone()));
        }
        h
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub url: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinksCapture {
    pub page_url: String,
    pub links: Vec<Link>,
    #[serde(default)]
    pub cookies: Option<String>,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Pending {
    Download(DownloadCapture),
    Video(VideoCapture),
    Links(LinksCapture),
}

pub async fn handle_browser(mgr: &Arc<Manager>, v: Value) -> Value {
    match v["type"].as_str() {
        Some("ping") => json!({ "ok": true, "app": "OurIDM", "version": env!("CARGO_PKG_VERSION") }),
        Some("config") => {
            let s = mgr.settings();
            json!({
                "ok": true,
                "captureExtensions": s.capture_extensions,
                "excludedSites": s.excluded_sites,
                "minSizeKb": s.capture_min_size_kb,
                "videoPanel": s.video_panel,
            })
        }
        Some(_) => match serde_json::from_value::<Pending>(v) {
            Ok(p) => {
                capture(mgr, p).await;
                json!({ "ok": true })
            }
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        },
        None => json!({ "ok": false, "error": "missing message type" }),
    }
}

pub async fn capture(mgr: &Arc<Manager>, p: Pending) {
    if let Pending::Download(d) = &p {
        if !mgr.settings().show_capture_dialog && !d.force_dialog {
            if let Err(e) = quick_add(mgr, d).await {
                log::warn!("capture failed: {e}");
            }
            return;
        }
    }
    let route = match &p {
        Pending::Download(_) => "capture",
        Pending::Video(_) => "video",
        Pending::Links(_) => "grabber",
    };
    let token = mgr.put_pending(p);
    if let Err(e) = windows::open_dialog(&mgr.app, route, &token) {
        log::warn!("couldn't open {route} window: {e}");
    }
}

/// Adds and starts a captured download without asking.
async fn quick_add(mgr: &Arc<Manager>, d: &DownloadCapture) -> anyhow::Result<()> {
    let headers = d.headers();
    let probed = tokio::time::timeout(Duration::from_secs(15), probe(mgr, &d.url, &headers)).await.ok().and_then(Result::ok);
    let file_name = d
        .file_name
        .clone()
        .filter(|n| !n.is_empty())
        .or_else(|| probed.as_ref().map(|p| p.file_name.clone()))
        .map(|n| idm_engine::sanitize_file_name(&n))
        .unwrap_or_else(|| "download".into());
    let (category, dir) = mgr.placement_for(&file_name);
    mgr.add(
        NewDownload {
            url: d.url.clone(),
            page_url: d.page_url.clone(),
            file_name,
            dest_dir: dir.to_string_lossy().into_owned(),
            category,
            size: probed.as_ref().and_then(|p| p.size).or(d.file_size),
            headers,
            kind: Kind::Http,
            video_format: None,
            cookies_file: None,
            queue_id: None,
            description: String::new(),
            resumable: probed.map(|p| p.resumable).unwrap_or(false),
        },
        true,
    )?;
    Ok(())
}

pub async fn probe(mgr: &Manager, url: &str, headers: &[(String, String)]) -> Result<idm_engine::Probe, String> {
    let s = mgr.settings();
    let opts = idm_engine::Options { proxy: s.proxy.filter(|p| !p.trim().is_empty()), ..Default::default() };
    let client = idm_engine::build_client(&opts).map_err(|e| e.to_string())?;
    idm_engine::probe(&client, url, &idm_engine::header_map(headers)).await.map_err(|e| e.to_string())
}

/// True for http(s) URLs whose path ends in one of the capture extensions
/// (wildcards like `R0*` allowed), used by the clipboard monitor.
pub fn looks_downloadable(text: &str, extensions: &[String]) -> bool {
    let Ok(url) = url::Url::parse(text.trim()) else { return false };
    if !matches!(url.scheme(), "http" | "https") || text.trim().contains(char::is_whitespace) {
        return false;
    }
    let Some(ext) = url.path().rsplit('/').next().and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_ascii_uppercase()) else {
        return false;
    };
    extensions.iter().any(|pat| {
        let pat = pat.trim().to_ascii_uppercase();
        match pat.strip_suffix('*') {
            Some(prefix) => ext.starts_with(prefix),
            None => ext == pat,
        }
    })
}

/// `Cookie` header value for `url` from browser cookies.
pub fn cookie_header_for(url: &str, cookies: &[BrowserCookie]) -> Option<String> {
    let u = url::Url::parse(url).ok()?;
    let host = u.host_str()?.to_ascii_lowercase();
    let pairs: Vec<String> = cookies
        .iter()
        .filter(|c| {
            let d = c.domain.trim_start_matches('.').to_ascii_lowercase();
            let domain_ok = if c.host_only { host == d } else { host == d || host.ends_with(&format!(".{d}")) };
            domain_ok && u.path().starts_with(&c.path) && (!c.secure || u.scheme() == "https")
        })
        .map(|c| format!("{}={}", c.name, c.value))
        .collect();
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exts() -> Vec<String> {
        crate::model::Settings::default().capture_extensions
    }

    #[test]
    fn clipboard_urls() {
        assert!(looks_downloadable("https://x.com/a/file.ZIP", &exts()));
        assert!(looks_downloadable("https://x.com/a/archive.r01", &exts()), "wildcard R0*");
        assert!(!looks_downloadable("https://x.com/page.html", &exts()));
        assert!(!looks_downloadable("just text file.zip", &exts()));
        assert!(!looks_downloadable("ftp://x.com/a.zip", &exts()));
    }

    #[test]
    fn cookie_matching() {
        let c = |name: &str, domain: &str, host_only: bool, secure: bool| BrowserCookie {
            name: name.into(),
            value: "1".into(),
            domain: domain.into(),
            path: "/".into(),
            secure,
            host_only,
            expiration_date: None,
        };
        let jar = vec![c("a", ".example.com", false, false), c("b", "example.com", true, false), c("s", ".example.com", false, true)];
        assert_eq!(cookie_header_for("https://cdn.example.com/v.mp4", &jar).unwrap(), "a=1; s=1");
        assert_eq!(cookie_header_for("http://example.com/v.mp4", &jar).unwrap(), "a=1; b=1");
        assert!(cookie_header_for("https://other.com/", &jar).is_none());
    }

    #[test]
    fn pending_tagging_matches_extension_messages() {
        let p: Pending = serde_json::from_value(json!({"type": "download", "url": "https://x/a.zip", "fileSize": 5})).unwrap();
        assert!(matches!(p, Pending::Download(DownloadCapture { file_size: Some(5), .. })));
        let p: Pending = serde_json::from_value(json!({
            "type": "video", "pageUrl": "https://x/watch", "streams": [{"url": "https://x/m.m3u8", "kind": "hls"}],
            "cookies": [{"name": "n", "value": "v", "domain": ".x", "hostOnly": false, "expirationDate": 1.0}]
        }))
        .unwrap();
        assert!(matches!(p, Pending::Video(VideoCapture { ref streams, ref cookies, .. }) if streams.len() == 1 && cookies.len() == 1));
    }
}

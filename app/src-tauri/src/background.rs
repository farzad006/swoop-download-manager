//! Long-running helpers: queue scheduler, clipboard monitor, browser host
//! registration.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use chrono::Datelike;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::capture::{DownloadCapture, Pending, capture, looks_downloadable};
use crate::manager::Manager;
use crate::model::Schedule;

/// Which of a schedule's edges fall on this minute: (start, stop).
pub fn due(s: &Schedule, hm: &str, weekday_from_sunday: u8) -> (bool, bool) {
    if !s.days.is_empty() && !s.days.contains(&weekday_from_sunday) {
        return (false, false);
    }
    (s.start_time.as_deref() == Some(hm), s.stop_time.as_deref() == Some(hm))
}

pub async fn scheduler(mgr: Arc<Manager>) {
    let mut fired: HashSet<String> = HashSet::new();
    loop {
        let now = chrono::Local::now();
        let hm = now.format("%H:%M").to_string();
        let stamp = now.format("%Y-%m-%d %H:%M").to_string();
        let day = now.weekday().num_days_from_sunday() as u8;
        for q in mgr.queues().unwrap_or_default() {
            let Some(s) = &q.schedule else { continue };
            let (start, stop) = due(s, &hm, day);
            if start && !q.running && fired.insert(format!("{}+{stamp}", q.id)) {
                mgr.start_queue(q.id);
            }
            if stop && q.running && fired.insert(format!("{}-{stamp}", q.id)) {
                mgr.stop_queue(q.id);
            }
        }
        if fired.len() > 1000 {
            fired.clear();
        }
        tokio::time::sleep(Duration::from_secs(15)).await;
    }
}

pub async fn clipboard_monitor(mgr: Arc<Manager>) {
    // Whatever was copied before we started isn't a new request.
    let mut last = mgr.app.clipboard().read_text().unwrap_or_default();
    loop {
        tokio::time::sleep(Duration::from_millis(1000)).await;
        let s = mgr.settings();
        if !s.clipboard_monitor {
            continue;
        }
        let Ok(text) = mgr.app.clipboard().read_text() else { continue };
        if text == last {
            continue;
        }
        last = text.clone();
        if looks_downloadable(&text, &s.capture_extensions) {
            let d = DownloadCapture {
                url: text.trim().to_string(),
                referrer: None,
                page_url: None,
                cookies: None,
                user_agent: None,
                file_name: None,
                file_size: None,
                mime: None,
                force_dialog: true,
            };
            capture(&mgr, Pending::Download(d)).await;
        }
    }
}

pub const HOST_NAME: &str = "com.alistudio.swoop.host";
/// Derived from the public key in extension/extension-key.json.
pub const CHROME_EXTENSION_ID: &str = "fhnkijclhenhpkpllphcclallnnkkiib";
pub const FIREFOX_EXTENSION_ID: &str = "swoop@alistudio";

const CHROMIUM_KEYS: &[&str] = &[
    r"Software\Google\Chrome\NativeMessagingHosts", // Chrome and Opera
    r"Software\Chromium\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    r"Software\Vivaldi\NativeMessagingHosts",
];
const FIREFOX_KEY: &str = r"Software\Mozilla\NativeMessagingHosts";

pub fn host_exe() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [dir.join("swoop-host.exe"), dir.join("binaries").join("swoop-host.exe")].into_iter().find(|p| p.is_file())
}

/// Writes the native-messaging manifests and points every supported browser
/// at them (per-user registry, no admin needed).
pub fn register_native_host(data_dir: &Path) -> anyhow::Result<PathBuf> {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    let host = host_exe().ok_or_else(|| anyhow::anyhow!("swoop-host.exe not found next to the app"))?;
    let dir = data_dir.join("native-host");
    std::fs::create_dir_all(&dir)?;
    let chromium = dir.join(format!("{HOST_NAME}.json"));
    let firefox = dir.join(format!("{HOST_NAME}.firefox.json"));
    let base = serde_json::json!({
        "name": HOST_NAME,
        "description": "Swoop browser integration",
        "path": host,
        "type": "stdio",
    });
    let mut c = base.clone();
    c["allowed_origins"] = serde_json::json!([format!("chrome-extension://{CHROME_EXTENSION_ID}/")]);
    std::fs::write(&chromium, serde_json::to_vec_pretty(&c)?)?;
    let mut f = base;
    f["allowed_extensions"] = serde_json::json!([FIREFOX_EXTENSION_ID]);
    std::fs::write(&firefox, serde_json::to_vec_pretty(&f)?)?;

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for k in CHROMIUM_KEYS {
        let (key, _) = hkcu.create_subkey(format!(r"{k}\{HOST_NAME}"))?;
        key.set_value("", &chromium.to_string_lossy().as_ref())?;
    }
    let (key, _) = hkcu.create_subkey(format!(r"{FIREFOX_KEY}\{HOST_NAME}"))?;
    key.set_value("", &firefox.to_string_lossy().as_ref())?;
    Ok(host)
}

pub fn unregister_native_host() {
    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    for k in CHROMIUM_KEYS.iter().chain([FIREFOX_KEY].iter()) {
        let _ = hkcu.delete_subkey_all(format!(r"{k}\{HOST_NAME}"));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_edges() {
        let s = Schedule { start_time: Some("02:00".into()), stop_time: Some("07:30".into()), days: vec![1, 2, 3, 4, 5] };
        assert_eq!(due(&s, "02:00", 1), (true, false));
        assert_eq!(due(&s, "07:30", 5), (false, true));
        assert_eq!(due(&s, "02:00", 0), (false, false), "Sunday not selected");
        let every_day = Schedule { days: vec![], ..s };
        assert_eq!(due(&every_day, "02:00", 0), (true, false));
    }
}

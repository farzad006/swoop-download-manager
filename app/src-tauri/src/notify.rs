//! "Download complete" notification with Open / Show in folder buttons, so the
//! Download complete window can stay off without losing those shortcuts.

use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_winrt_notification::Toast;

/// Windows shows notifications for an app id registered by a Start-menu
/// shortcut; the installer's uses the bundle identifier. Builds run from
/// target\ borrow PowerShell's, as tauri-plugin-notification does.
fn app_id(app: &AppHandle) -> String {
    let dev = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.ends_with(Path::new("target").join("debug")) || d.ends_with(Path::new("target").join("release"))))
        .unwrap_or(false);
    if dev {
        Toast::POWERSHELL_APP_ID.to_string()
    } else {
        app.config().identifier.clone()
    }
}

pub fn download_complete(app: &AppHandle, name: &str, path: PathBuf) {
    let handle = app.clone();
    let toast = Toast::new(&app_id(app))
        .title("Download complete")
        .text1(name)
        .add_button("Open", "open")
        .add_button("Show in folder", "folder")
        .on_activated(move |action| {
            let opener = handle.opener();
            let _ = match action.as_deref() {
                Some("open") => opener.open_path(path.to_string_lossy(), None::<&str>),
                Some("folder") => opener.reveal_item_in_dir(&path),
                // Clicking the notification itself brings up Swoop.
                _ => {
                    crate::windows::show_main(&handle);
                    Ok(())
                }
            };
            Ok(())
        });
    if let Err(e) = toast.show() {
        log::warn!("download notification failed ({e}); using a plain one");
        let _ = app.notification().builder().title("Download complete").body(name).show();
    }
}

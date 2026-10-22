mod background;
mod browsers;
mod capture;
mod categories;
mod commands;
mod db;
mod ipc;
mod manager;
mod model;
mod video;
mod windows;

use std::sync::Arc;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager as _, RunEvent, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

use crate::manager::Manager;
use crate::model::MAIN_QUEUE;

fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open Swoop", true, None::<&str>)?;
    let start_q = MenuItem::with_id(app, "start-queue", "Start main queue", true, None::<&str>)?;
    let stop_all = MenuItem::with_id(app, "stop-all", "Stop all downloads", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &start_q, &stop_all, &sep, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("Swoop")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let mgr = app.state::<Arc<Manager>>().inner().clone();
            match event.id.as_ref() {
                "open" => windows::show_main(app),
                "start-queue" => mgr.start_queue(MAIN_QUEUE),
                "stop-all" => mgr.pause_all(),
                "quit" => quit_gracefully(app.clone(), mgr),
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                windows::show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Pauses transfers so their progress is saved, then exits.
pub fn quit_gracefully(app: AppHandle, mgr: Arc<Manager>) {
    tauri::async_runtime::spawn(async move {
        mgr.pause_all();
        for _ in 0..30 {
            if mgr.list().map(|l| l.iter().all(|d| !mgr.is_active(d.id))).unwrap_or(true) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        app.exit(0);
    });
}

/// Swoop used to be called OurIDM (data in `com.ouridm.app`). On first start,
/// bring its download list and settings along.
fn migrate_from_ouridm(data_dir: &std::path::Path) {
    let new_db = data_dir.join("swoop.db");
    let Some(old_dir) = data_dir.parent().map(|p| p.join("com.ouridm.app")) else { return };
    let old_db = old_dir.join("ouridm.db");
    if new_db.exists() || !old_db.is_file() {
        return;
    }
    let _ = std::fs::create_dir_all(data_dir);
    // SQLite in WAL mode keeps recent writes in the -wal file; copy it alongside.
    for (from, to) in [("ouridm.db", "swoop.db"), ("ouridm.db-wal", "swoop.db-wal"), ("ouridm.db-shm", "swoop.db-shm")] {
        let src = old_dir.join(from);
        if src.is_file() {
            let _ = std::fs::copy(src, data_dir.join(to));
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::args().any(|a| a == "--unregister") {
        background::unregister_native_host();
        return;
    }
    let background_start = std::env::args().any(|a| a == "--background");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if !args.iter().any(|a| a == "--background") {
                windows::show_main(app);
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--background"])))
        .setup(move |app| {
            // SWOOP_DATA_DIR keeps test runs away from the real download list.
            let data_dir = match std::env::var_os("SWOOP_DATA_DIR") {
                Some(d) => std::path::PathBuf::from(d),
                None => app.path().app_data_dir()?,
            };
            migrate_from_ouridm(&data_dir);
            let mgr = Manager::new(app.handle().clone(), data_dir.clone())?;
            app.manage(mgr.clone());
            if let Err(e) = background::register_native_host(&data_dir) {
                log::warn!("browser integration not registered: {e}");
            }
            create_tray(app.handle())?;
            tauri::async_runtime::spawn(ipc::serve(mgr.clone()));
            tauri::async_runtime::spawn(background::scheduler(mgr.clone()));
            tauri::async_runtime::spawn(background::clipboard_monitor(mgr.clone()));
            if mgr.settings().update_ytdlp {
                tauri::async_runtime::spawn(video::update_ytdlp(data_dir.join("yt-dlp-updated")));
            }
            // Keep a loaded window ready so dialogs (video qualities, file info) open instantly.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                windows::warm_spare(&handle);
            });
            // The first-run welcome lives in the main window, so show it even for background starts.
            if !background_start || !mgr.settings().onboarded {
                windows::show_main(app.handle());
            }
            // First start after install: walk through the browsers ticked in the installer.
            let mut picked = browsers::take_installer_selection();
            if let Some(arg) = std::env::args().find_map(|a| a.strip_prefix("--setup-browsers=").map(str::to_owned)) {
                picked.extend(browsers::parse_selection(&arg));
            }
            if !mgr.settings().onboarded {
                // The welcome screen includes browser setup; it picks these up.
                *mgr.browser_selection.lock().unwrap() = picked;
            } else if !picked.is_empty() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = windows::open_browsers(&handle, &picked);
                });
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" {
                    // Closing the main window keeps Swoop running in the tray, like IDM.
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_downloads,
            commands::get_download,
            commands::add_download,
            commands::add_many,
            commands::start_download,
            commands::pause_download,
            commands::pause_all,
            commands::delete_download,
            commands::delete_completed,
            commands::refresh_address,
            commands::open_file,
            commands::open_folder,
            commands::probe_url,
            commands::placement_for,
            commands::get_settings,
            commands::save_settings,
            commands::list_queues,
            commands::save_queue,
            commands::delete_queue,
            commands::start_queue,
            commands::stop_queue,
            commands::set_download_queue,
            commands::get_pending,
            commands::close_pending,
            commands::video_info,
            commands::add_video,
            commands::add_stream_direct,
            commands::tool_status,
            commands::show_main,
            commands::capture_url,
            commands::list_browsers,
            commands::open_browser_setup,
            commands::reveal_extension,
            commands::open_browser_setup_window,
            commands::take_browser_selection,
            commands::spare_ready,
            commands::clipboard_link,
            commands::about,
            commands::open_link,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Swoop");

    app.run(|_app, event| {
        // Last window closed: stay in the tray. Explicit exit() carries a code.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn ouridm_data_is_carried_over_once() {
        let root = tempfile::tempdir().unwrap();
        let old = root.path().join("com.ouridm.app");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("ouridm.db"), b"old list").unwrap();
        let new = root.path().join("com.alistudio.swoop");

        super::migrate_from_ouridm(&new);
        assert_eq!(std::fs::read(new.join("swoop.db")).unwrap(), b"old list");

        // Later starts never overwrite Swoop's own data.
        std::fs::write(new.join("swoop.db"), b"swoop list").unwrap();
        super::migrate_from_ouridm(&new);
        assert_eq!(std::fs::read(new.join("swoop.db")).unwrap(), b"swoop list");
    }
}

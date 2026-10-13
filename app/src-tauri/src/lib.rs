mod background;
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
    let open = MenuItem::with_id(app, "open", "Open OurIDM", true, None::<&str>)?;
    let start_q = MenuItem::with_id(app, "start-queue", "Start main queue", true, None::<&str>)?;
    let stop_all = MenuItem::with_id(app, "stop-all", "Stop all downloads", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &start_q, &stop_all, &sep, &quit])?;
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("app icon"))
        .tooltip("OurIDM")
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
            let data_dir = app.path().app_data_dir()?;
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
                tauri::async_runtime::spawn(video::self_update());
            }
            if !background_start {
                windows::show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                if w.label() == "main" {
                    // Closing the main window keeps OurIDM running in the tray, like IDM.
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building OurIDM");

    app.run(|_app, event| {
        // Last window closed: stay in the tray. Explicit exit() carries a code.
        if let RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
}

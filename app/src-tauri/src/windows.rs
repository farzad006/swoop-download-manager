use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

/// Call only from async commands or spawned tasks: on Windows, building a
/// webview window from a synchronous command or event handler deadlocks.
fn open(app: &AppHandle, label: &str, route: &str, title: &str, size: (f64, f64), on_top: bool) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.unminimize();
        w.show()?;
        return w.set_focus();
    }
    WebviewWindowBuilder::new(app, label, WebviewUrl::App(format!("index.html#{route}").into()))
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(size.0 * 0.8, size.1 * 0.8)
        .always_on_top(on_top)
        .center()
        .focused(true)
        .build()?;
    Ok(())
}

pub fn open_progress(app: &AppHandle, id: i64) -> tauri::Result<()> {
    open(app, &format!("progress-{id}"), &format!("/progress/{id}"), "Download progress", (540.0, 420.0), false)
}

/// Capture, video and link-grabber dialogs, keyed by their pending token.
pub fn open_dialog(app: &AppHandle, route: &str, token: &str) -> tauri::Result<()> {
    let (title, size) = match route {
        "capture" => ("Download file", (600.0, 470.0)),
        "video" => ("Download video", (680.0, 600.0)),
        _ => ("Download links", (860.0, 620.0)),
    };
    let path = format!("/{route}/{token}");
    if use_spare(app, &path, title, size) {
        return Ok(());
    }
    open(app, &format!("{route}-{token}"), &path, title, size, true)
}

/// A hidden window with the app already loaded, kept for the next dialog.
/// Building a WebView2 window and loading the page takes about a second,
/// which was most of the wait after clicking "Download this video".
static SPARE: Mutex<Option<String>> = Mutex::new(None);
static SPARE_SEQ: AtomicU32 = AtomicU32::new(0);

/// Starts loading a spare window (call from async code, like `open`).
pub fn warm_spare(app: &AppHandle) {
    let label = format!("spare-{}", SPARE_SEQ.fetch_add(1, Ordering::Relaxed));
    let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html#/spare".into()))
        .title("Swoop")
        .visible(false)
        .focused(false)
        .always_on_top(true)
        .build();
    if let Err(e) = built {
        log::warn!("couldn't prepare a spare window: {e}");
    }
}

/// The spare window reports in once it's listening for its dialog.
pub fn spare_ready(label: &str) {
    *SPARE.lock().unwrap() = Some(label.to_string());
}

fn use_spare(app: &AppHandle, route: &str, title: &str, size: (f64, f64)) -> bool {
    let Some(label) = SPARE.lock().unwrap().take() else { return false };
    let Some(w) = app.get_webview_window(&label) else { return false };
    if app.emit_to(label.as_str(), "spare-open", (label.as_str(), route)).is_err() {
        return false;
    }
    let _ = w.set_title(title);
    let _ = w.set_min_size(Some(LogicalSize::new(size.0 * 0.8, size.1 * 0.8)));
    let _ = w.set_size(LogicalSize::new(size.0, size.1));
    let _ = w.center();
    let _ = w.show();
    let _ = w.set_focus();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
        warm_spare(&app);
    });
    true
}

/// "Connect your browsers" — `selected` are the ones ticked in the installer.
pub fn open_browsers(app: &AppHandle, selected: &[String]) -> tauri::Result<()> {
    open(app, "browsers", &format!("/browsers/{}", selected.join(",")), "Connect Swoop to your browsers", (700.0, 640.0), false)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

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
    open(app, &format!("progress-{id}"), &format!("/progress/{id}"), "Download progress", (560.0, 400.0), false)
}

/// Capture, video and link-grabber dialogs, keyed by their pending token.
pub fn open_dialog(app: &AppHandle, route: &str, token: &str) -> tauri::Result<()> {
    let (title, size) = match route {
        "capture" => ("Download File Info", (600.0, 330.0)),
        "video" => ("Download Video", (640.0, 520.0)),
        _ => ("Download Links", (860.0, 600.0)),
    };
    open(app, &format!("{route}-{token}"), &format!("/{route}/{token}"), title, size, true)
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

//! Named-pipe server the native-messaging host (`swoop-host.exe`) talks to.
//! Protocol: one JSON object per line in each direction.

use std::sync::Arc;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

use crate::capture::handle_browser;
use crate::manager::Manager;

pub const PIPE_NAME: &str = r"\\.\pipe\swoop";

pub async fn serve(mgr: Arc<Manager>) {
    let mut server = match ServerOptions::new().first_pipe_instance(true).create(PIPE_NAME) {
        Ok(s) => s,
        Err(e) => {
            log::error!("browser pipe unavailable: {e}");
            return;
        }
    };
    loop {
        if server.connect().await.is_err() {
            continue;
        }
        let conn = server;
        server = match ServerOptions::new().create(PIPE_NAME) {
            Ok(s) => s,
            Err(e) => {
                log::error!("browser pipe: {e}");
                return;
            }
        };
        let mgr = mgr.clone();
        tauri::async_runtime::spawn(handle(conn, mgr));
    }
}

async fn handle(conn: NamedPipeServer, mgr: Arc<Manager>) {
    let (r, mut w) = tokio::io::split(conn);
    let mut lines = BufReader::new(r).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let reply = match serde_json::from_str(&line) {
            Ok(v) => handle_browser(&mgr, v).await,
            Err(e) => json!({ "ok": false, "error": e.to_string() }),
        };
        if w.write_all(format!("{reply}\n").as_bytes()).await.is_err() {
            break;
        }
    }
}

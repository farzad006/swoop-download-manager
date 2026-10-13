//! Native-messaging host for the Swoop browser extension.
//!
//! Browsers start this process and talk to it over stdio (4-byte native-endian
//! length + JSON). Each message is relayed as one line to the Swoop app over
//! the `\\.\pipe\swoop` named pipe, and the app's one-line reply goes back.
//! The app is launched in the background if it isn't running.

use std::fs::{File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

const PIPE: &str = r"\\.\pipe\swoop";
const MAX_MESSAGE: u32 = 64 * 1024 * 1024;

fn read_message(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_ne_bytes(len);
    if len > MAX_MESSAGE {
        return Err(io::Error::other("message too large"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

fn write_message(w: &mut impl Write, v: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(v)?;
    w.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    w.write_all(&bytes)?;
    w.flush()
}

fn connect() -> io::Result<File> {
    OpenOptions::new().read(true).write(true).open(PIPE)
}

/// Connects to the app, starting it if needed (unless `launch` is false).
fn connect_or_launch(launch: bool) -> io::Result<File> {
    if let Ok(f) = connect() {
        return Ok(f);
    }
    if launch {
        launch_app()?;
    }
    let deadline = Instant::now() + Duration::from_secs(if launch { 20 } else { 2 });
    loop {
        match connect() {
            Ok(f) => return Ok(f),
            Err(e) if Instant::now() > deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

fn app_exe() -> Option<PathBuf> {
    let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let dirs = [dir.clone(), dir.parent().map(PathBuf::from).unwrap_or(dir)];
    dirs.iter().flat_map(|d| [d.join("Swoop.exe"), d.join("swoop.exe")]).find(|p| p.is_file())
}

fn launch_app() -> io::Result<()> {
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let exe = app_exe().ok_or_else(|| io::Error::other("Swoop.exe not found next to swoop-host.exe"))?;
    // Browsers run hosts inside a job object; break away so the app outlives us.
    let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP;
    Command::new(&exe)
        .arg("--background")
        .creation_flags(base | CREATE_BREAKAWAY_FROM_JOB)
        .spawn()
        .or_else(|_| Command::new(&exe).arg("--background").creation_flags(base).spawn())
        .map(|_| ())
}

fn relay(msg: &Value) -> Value {
    // Only real capture requests start Swoop; status and config queries
    // (sent whenever a browser starts) just report "not running".
    let launch = matches!(msg["type"].as_str(), Some("download" | "video" | "links"));
    let pipe = match connect_or_launch(launch) {
        Ok(p) => p,
        Err(e) => return json!({ "ok": false, "error": format!("Swoop is not running ({e})") }),
    };
    let mut w = match pipe.try_clone() {
        Ok(w) => w,
        Err(e) => return json!({ "ok": false, "error": e.to_string() }),
    };
    let line = format!("{msg}\n");
    if let Err(e) = w.write_all(line.as_bytes()).and_then(|_| w.flush()) {
        return json!({ "ok": false, "error": e.to_string() });
    }
    let mut reply = String::new();
    match BufReader::new(pipe).read_line(&mut reply) {
        Ok(n) if n > 0 => serde_json::from_str(&reply).unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() })),
        Ok(_) => json!({ "ok": false, "error": "Swoop closed the connection" }),
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    }
}

fn main() {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    // One message per process (sendNativeMessage) or many (connectNative).
    while let Ok(Some(raw)) = read_message(&mut stdin) {
        let reply = match serde_json::from_slice::<Value>(&raw) {
            Ok(msg) => relay(&msg),
            Err(e) => json!({ "ok": false, "error": format!("bad message: {e}") }),
        };
        if write_message(&mut stdout, &reply).is_err() {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framing_round_trip() {
        let mut buf = Vec::new();
        let v = json!({ "type": "ping", "x": "é" });
        write_message(&mut buf, &v).unwrap();
        let len = u32::from_ne_bytes(buf[..4].try_into().unwrap()) as usize;
        assert_eq!(len, buf.len() - 4);
        let mut r = io::Cursor::new(buf);
        let back: Value = serde_json::from_slice(&read_message(&mut r).unwrap().unwrap()).unwrap();
        assert_eq!(back, v);
        assert!(read_message(&mut r).unwrap().is_none(), "EOF ends the loop");
    }
}

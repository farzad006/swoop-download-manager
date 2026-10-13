//! Embeds Windows file details (Properties → Details) in swoop-host.exe so it
//! matches Swoop.exe: product name, version, company, icon. Code signing
//! (SignPath) requires every signed file to carry the same product name and
//! version, so the version is read from the app's tauri.conf.json, the single
//! place a release bumps it.

use std::path::Path;

fn main() {
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
    let conf = manifest.join("../../app/src-tauri/tauri.conf.json");
    let icon = manifest.join("../../app/src-tauri/icons/icon.ico");
    println!("cargo:rerun-if-changed={}", conf.display());
    println!("cargo:rerun-if-changed={}", icon.display());

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let text = std::fs::read_to_string(&conf).expect("read app/src-tauri/tauri.conf.json");
    let json: serde_json::Value = serde_json::from_str(&text).expect("parse tauri.conf.json");
    let version = json["version"].as_str().expect("tauri.conf.json has a version").to_string();
    let product = json["productName"].as_str().unwrap_or("Swoop").to_string();

    // "1.2.3" → MAJOR << 48 | MINOR << 32 | PATCH << 16
    let mut parts = version.split(['.', '-', '+']).map(|p| p.parse::<u64>().unwrap_or(0));
    let (major, minor, patch) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    let packed = (major << 48) | (minor << 32) | (patch << 16);

    let mut res = winresource::WindowsResource::new();
    res.set("ProductName", &product)
        .set("FileDescription", &format!("{product} browser connector"))
        .set("CompanyName", "Ali Studio")
        .set("LegalCopyright", "© 2026 Ali Studio")
        .set("OriginalFilename", "swoop-host.exe")
        .set("InternalName", "swoop-host")
        .set("ProductVersion", &version)
        .set("FileVersion", &version)
        .set_version_info(winresource::VersionInfo::PRODUCTVERSION, packed)
        .set_version_info(winresource::VersionInfo::FILEVERSION, packed);
    if icon.is_file() {
        res.set_icon(&icon.to_string_lossy());
    }
    res.compile().expect("embed Windows version info into swoop-host.exe");
}

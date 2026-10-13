//! Installed-browser detection and the "Connect your browsers" helpers.
//!
//! Browsers don't let other programs install extensions silently (Chrome, Edge
//! and Opera only accept store extensions from installers; Firefox only signed
//! add-ons), so setup opens each browser's extensions page and the extension
//! folder, and the extension reports back with a `hello` once it's loaded.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Chromium,
    Firefox,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Browser {
    /// chrome, edge, opera, brave, vivaldi, firefox
    pub id: String,
    pub name: String,
    pub exe: PathBuf,
    pub engine: Engine,
}

/// Maps a `StartMenuInternet` key name (how Windows lists browsers) to our id.
pub fn identify(key_name: &str) -> Option<(&'static str, &'static str, Engine)> {
    let k = key_name.to_ascii_lowercase();
    let table: &[(&str, &str, &str, Engine)] = &[
        ("google chrome", "chrome", "Google Chrome", Engine::Chromium),
        ("microsoft edge", "edge", "Microsoft Edge", Engine::Chromium),
        ("opera", "opera", "Opera", Engine::Chromium),
        ("brave", "brave", "Brave", Engine::Chromium),
        ("vivaldi", "vivaldi", "Vivaldi", Engine::Chromium),
        ("firefox", "firefox", "Mozilla Firefox", Engine::Firefox),
    ];
    table.iter().find(|(prefix, ..)| k.starts_with(prefix)).map(|&(_, id, name, engine)| (id, name, engine))
}

/// `"C:\Program Files\X\x.exe" --flag` → `C:\Program Files\X\x.exe`
pub fn exe_from_command(cmd: &str) -> PathBuf {
    let cmd = cmd.trim();
    match cmd.strip_prefix('"') {
        Some(rest) => PathBuf::from(rest.split('"').next().unwrap_or(rest)),
        None => PathBuf::from(cmd.split(" -").next().unwrap_or(cmd).trim()),
    }
}

pub fn detect() -> Vec<Browser> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};

    let mut found: Vec<Browser> = Vec::new();
    let roots = [
        (HKEY_CURRENT_USER, r"Software\Clients\StartMenuInternet"),
        (HKEY_LOCAL_MACHINE, r"Software\Clients\StartMenuInternet"),
        (HKEY_LOCAL_MACHINE, r"Software\WOW6432Node\Clients\StartMenuInternet"),
    ];
    for (hive, path) in roots {
        let Ok(root) = RegKey::predef(hive).open_subkey(path) else { continue };
        for name in root.enum_keys().flatten() {
            let Some((id, label, engine)) = identify(&name) else { continue };
            if found.iter().any(|b| b.id == id) {
                continue;
            }
            let cmd: Option<String> = root.open_subkey(format!(r"{name}\shell\open\command")).and_then(|k| k.get_value("")).ok();
            let Some(exe) = cmd.map(|c| exe_from_command(&c)).filter(|p| p.is_file()) else { continue };
            found.push(Browser { id: id.into(), name: label.into(), exe, engine });
        }
    }
    let order = ["chrome", "edge", "opera", "brave", "vivaldi", "firefox"];
    found.sort_by_key(|b| order.iter().position(|o| *o == b.id).unwrap_or(99));
    found
}

pub fn extensions_page(b: &Browser) -> &'static str {
    match b.id.as_str() {
        "edge" => "edge://extensions",
        "opera" => "opera://extensions",
        "brave" => "brave://extensions",
        "vivaldi" => "vivaldi://extensions",
        "firefox" => "about:debugging#/runtime/this-firefox",
        _ => "chrome://extensions",
    }
}

/// Brings the browser up. Chromium browsers ignore `edge://`/`chrome://` URLs
/// handed over on the command line (anti-malware rule; checked on Edge and
/// Opera), so the caller puts the extensions-page address on the clipboard
/// instead. A signed Firefox add-on is passed as a file, which Firefox offers
/// to install.
pub fn launch(b: &Browser, firefox_xpi: Option<&Path>) -> std::io::Result<()> {
    let mut c = Command::new(&b.exe);
    if let (Engine::Firefox, Some(xpi)) = (b.engine, firefox_xpi) {
        c.arg(xpi);
    }
    c.spawn().map(|_| ())
}

/// Opens Explorer with the extension folder selected, ready to drag.
pub fn reveal(path: &Path) -> std::io::Result<()> {
    Command::new("explorer.exe").arg(format!("/select,{}", path.display())).spawn().map(|_| ())
}

/// Browsers ticked in the installer's "Browser integration" page, consumed once.
pub fn take_installer_selection() -> Vec<String> {
    use winreg::RegKey;
    use winreg::enums::{HKEY_CURRENT_USER, KEY_ALL_ACCESS};
    let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(r"Software\OurIDM", KEY_ALL_ACCESS) else {
        return vec![];
    };
    let value: String = key.get_value("SetupBrowsers").unwrap_or_default();
    let _ = key.delete_value("SetupBrowsers");
    parse_selection(&value)
}

pub fn parse_selection(v: &str) -> Vec<String> {
    v.split(',').map(|s| s.trim().to_ascii_lowercase()).filter(|s| !s.is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifies_windows_browser_keys() {
        assert_eq!(identify("Google Chrome").unwrap().0, "chrome");
        assert_eq!(identify("Microsoft Edge").unwrap().0, "edge");
        assert_eq!(identify("OperaStable").unwrap().0, "opera");
        assert_eq!(identify("Opera GXStable").unwrap().0, "opera");
        assert_eq!(identify("Brave").unwrap().0, "brave");
        assert_eq!(identify("Firefox-308046B0AF4A39CB").unwrap().0, "firefox");
        assert!(identify("IEXPLORE.EXE").is_none());
    }

    #[test]
    fn exe_paths_from_open_commands() {
        assert_eq!(
            exe_from_command(r#""C:\Program Files\Google\Chrome\Application\chrome.exe""#),
            PathBuf::from(r"C:\Program Files\Google\Chrome\Application\chrome.exe")
        );
        assert_eq!(exe_from_command(r#""C:\a b\opera.exe" --single-argument %1"#), PathBuf::from(r"C:\a b\opera.exe"));
        assert_eq!(exe_from_command(r"C:\x\brave.exe -- %1"), PathBuf::from(r"C:\x\brave.exe"));
    }

    #[test]
    fn installer_selection_parsing() {
        assert_eq!(parse_selection("chrome, Edge,,firefox"), vec!["chrome", "edge", "firefox"]);
        assert!(parse_selection("").is_empty());
    }

    #[test]
    fn detects_browsers_registered_on_this_pc() {
        // Every detected browser must point at a real executable.
        for b in detect() {
            assert!(b.exe.is_file(), "{b:?}");
        }
    }
}

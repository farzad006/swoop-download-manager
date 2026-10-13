use percent_encoding::percent_decode_str;
use reqwest::header::{self, HeaderMap};
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Probe {
    pub final_url: String,
    pub size: Option<u64>,
    pub resumable: bool,
    pub etag: Option<String>,
    pub last_modified: Option<String>,
    pub file_name: String,
    pub content_type: Option<String>,
}

impl Probe {
    /// Value for `If-Range`: a strong ETag if we have one, else Last-Modified.
    pub fn validator(&self) -> Option<&str> {
        self.etag.as_deref().filter(|e| !e.starts_with("W/")).or(self.last_modified.as_deref())
    }
}

/// Asks for byte 0 only: a 206 tells us the server supports ranges and the
/// total size in one round trip. Falls back to a plain GET if the range
/// request is rejected.
pub async fn probe(client: &Client, url: &str, headers: &HeaderMap) -> Result<Probe> {
    let resp = client.get(url).headers(headers.clone()).header(header::RANGE, "bytes=0-0").send().await?;
    let resp = if resp.status() == StatusCode::RANGE_NOT_SATISFIABLE || resp.status().is_client_error() {
        let status = resp.status().as_u16();
        let plain = client.get(url).headers(headers.clone()).send().await?;
        if !plain.status().is_success() {
            return Err(status_error(plain.status().as_u16().max(status)));
        }
        plain
    } else {
        resp
    };
    let status = resp.status();
    if !status.is_success() {
        return Err(status_error(status.as_u16()));
    }

    let h = resp.headers();
    let get = |name: header::HeaderName| h.get(name).and_then(|v| v.to_str().ok()).map(str::to_owned);
    let (resumable, size) = if status == StatusCode::PARTIAL_CONTENT {
        let total = get(header::CONTENT_RANGE).and_then(|cr| parse_content_range_total(&cr));
        (total.is_some(), total)
    } else {
        (false, resp.content_length().filter(|_| h.get(header::CONTENT_ENCODING).is_none()))
    };
    let content_type = get(header::CONTENT_TYPE);
    let final_url = resp.url().to_string();
    let file_name = get(header::CONTENT_DISPOSITION)
        .and_then(|cd| filename_from_disposition(&cd))
        .or_else(|| filename_from_url(resp.url()))
        .map(|n| with_extension_for(n, content_type.as_deref()))
        .unwrap_or_else(|| with_extension_for("download".into(), content_type.as_deref()));

    Ok(Probe {
        final_url,
        size,
        resumable,
        etag: get(header::ETAG),
        last_modified: get(header::LAST_MODIFIED),
        file_name: sanitize_file_name(&file_name),
        content_type,
    })
}

pub(crate) fn status_error(code: u16) -> Error {
    match code {
        401 | 403 | 410 => Error::LinkExpired(code),
        _ => Error::Http(code),
    }
}

/// `bytes 0-0/12345` → 12345; `bytes 0-0/*` → None.
pub fn parse_content_range_total(v: &str) -> Option<u64> {
    v.rsplit_once('/')?.1.trim().parse().ok()
}

/// `bytes 100-199/1000` → start offset 100.
pub fn parse_content_range_start(v: &str) -> Option<u64> {
    let spec = v.trim().strip_prefix("bytes")?.trim();
    spec.split_once('-')?.0.trim().parse().ok()
}

pub fn filename_from_disposition(cd: &str) -> Option<String> {
    let mut plain = None;
    for part in cd.split(';').map(str::trim) {
        let Some((k, v)) = part.split_once('=') else { continue };
        let k = k.trim().to_ascii_lowercase();
        let v = v.trim();
        if k == "filename*" {
            // RFC 5987: charset'lang'percent-encoded
            let enc = v.splitn(3, '\'').nth(2).unwrap_or(v);
            let decoded = percent_decode_str(enc.trim_matches('"')).decode_utf8_lossy().into_owned();
            if !decoded.is_empty() {
                return Some(decoded);
            }
        } else if k == "filename" {
            let v = v.trim_matches('"');
            if !v.is_empty() {
                plain = Some(percent_decode_str(v).decode_utf8_lossy().into_owned());
            }
        }
    }
    plain
}

pub fn filename_from_url(url: &reqwest::Url) -> Option<String> {
    let last = url.path_segments()?.rev().find(|s| !s.is_empty())?;
    let name = percent_decode_str(last).decode_utf8_lossy().into_owned();
    (!name.is_empty()).then_some(name)
}

fn with_extension_for(name: String, content_type: Option<&str>) -> String {
    if std::path::Path::new(&name).extension().is_some() {
        return name;
    }
    let mime = content_type.unwrap_or("").split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    let ext = match mime.as_str() {
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        "video/x-matroska" => "mkv",
        "audio/mpeg" => "mp3",
        "audio/mp4" => "m4a",
        "audio/ogg" => "ogg",
        "application/zip" => "zip",
        "application/x-7z-compressed" => "7z",
        "application/vnd.rar" | "application/x-rar-compressed" => "rar",
        "application/pdf" => "pdf",
        "application/x-msdownload" | "application/vnd.microsoft.portable-executable" => "exe",
        "application/x-msi" => "msi",
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "text/html" => "html",
        _ => return name,
    };
    format!("{name}.{ext}")
}

/// Makes a name safe for Windows: strips reserved characters, trailing dots
/// and spaces, reserved device names, and caps the length.
pub fn sanitize_file_name(name: &str) -> String {
    let mut s: String = name
        .chars()
        .map(|c| if c.is_control() || r#"<>:"/\|?*"#.contains(c) { '_' } else { c })
        .collect();
    s = s.trim().trim_end_matches(['.', ' ']).to_string();
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    const RESERVED: &[&str] = &[
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1",
        "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if RESERVED.contains(&stem.as_str()) {
        s.insert(0, '_');
    }
    if s.chars().count() > 200 {
        let path = std::path::Path::new(&s);
        let ext = path.extension().map(|e| e.to_string_lossy().into_owned());
        let keep = 200 - ext.as_ref().map(|e| e.chars().count() + 1).unwrap_or(0);
        let head: String = s.chars().take(keep).collect();
        s = match ext {
            Some(e) => format!("{head}.{e}"),
            None => head,
        };
    }
    if s.is_empty() { "download".into() } else { s }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disposition_variants() {
        assert_eq!(filename_from_disposition(r#"attachment; filename="a b.zip""#).unwrap(), "a b.zip");
        assert_eq!(filename_from_disposition("attachment; filename=plain.iso").unwrap(), "plain.iso");
        assert_eq!(
            filename_from_disposition(r#"attachment; filename="fallback.txt"; filename*=UTF-8''%E2%82%AC%20rates.txt"#)
                .unwrap(),
            "€ rates.txt"
        );
        assert!(filename_from_disposition("inline").is_none());
    }

    #[test]
    fn url_names() {
        let u = reqwest::Url::parse("https://x.com/dl/My%20File.tar.gz?token=1").unwrap();
        assert_eq!(filename_from_url(&u).unwrap(), "My File.tar.gz");
        let u = reqwest::Url::parse("https://x.com/").unwrap();
        assert!(filename_from_url(&u).is_none());
    }

    #[test]
    fn sanitizing() {
        assert_eq!(sanitize_file_name(r#"a<b>:c"d/e\f|g?h*.txt"#), "a_b__c_d_e_f_g_h_.txt");
        assert_eq!(sanitize_file_name("CON.txt"), "_CON.txt");
        assert_eq!(sanitize_file_name("trail. . "), "trail");
        let long = format!("{}.mp4", "x".repeat(300));
        let s = sanitize_file_name(&long);
        assert_eq!(s.chars().count(), 200);
        assert!(s.ends_with(".mp4"));
    }

    #[test]
    fn content_range() {
        assert_eq!(parse_content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(parse_content_range_total("bytes 0-0/*"), None);
        assert_eq!(parse_content_range_start("bytes 100-199/1000"), Some(100));
    }

    #[test]
    fn extension_from_mime() {
        assert_eq!(with_extension_for("video".into(), Some("video/mp4; codecs=x")), "video.mp4");
        assert_eq!(with_extension_for("a.bin".into(), Some("video/mp4")), "a.bin");
    }
}

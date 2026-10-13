use std::path::{Path, PathBuf};

pub const CATEGORIES: &[(&str, &[&str])] = &[
    ("Compressed", &["zip", "rar", "7z", "gz", "tgz", "bz2", "xz", "zst", "tar", "arj", "lzh", "ace", "sit", "sitx", "sea", "z", "cab", "iso", "img"]),
    ("Documents", &["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pps", "txt", "rtf", "odt", "ods", "odp", "epub", "csv", "md"]),
    ("Music", &["mp3", "wav", "wma", "aac", "m4a", "flac", "ogg", "opus", "aif", "aiff", "ra", "mpa", "mid"]),
    ("Programs", &["exe", "msi", "msu", "msix", "appx", "apk", "dmg", "pkg", "deb", "rpm", "appimage", "bat", "jar"]),
    ("Video", &["mp4", "mkv", "avi", "mov", "webm", "flv", "wmv", "m4v", "3gp", "ts", "mpg", "mpeg", "mpe", "ogv", "rm", "rmvb", "asf", "qt"]),
];

pub fn category_for(file_name: &str) -> &'static str {
    let ext = Path::new(file_name).extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    CATEGORIES.iter().find(|(_, exts)| exts.contains(&ext.as_str())).map(|(c, _)| *c).unwrap_or("General")
}

/// `<root>\<Category>` when category folders are on (IDM's layout), else `<root>`.
pub fn folder_for(root: &Path, category: &str, use_category_folders: bool) -> PathBuf {
    if use_category_folders && category != "General" { root.join(category) } else { root.to_path_buf() }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_listed_extension_maps_to_its_category() {
        for (cat, exts) in CATEGORIES {
            for ext in *exts {
                assert_eq!(category_for(&format!("file.{}", ext.to_uppercase())), *cat, "{ext}");
            }
        }
        assert_eq!(category_for("noext"), "General");
    }
}

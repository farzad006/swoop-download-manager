/** Decisions shared by the background script: what to capture, what counts as media. */

export interface AppConfig {
  captureExtensions: string[];
  excludedSites: string[];
  minSizeKb: number;
  videoPanel: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  captureExtensions:
    "3GP 7Z AAC APK AVI BIN BZ2 EXE GZ ISO M4A M4V MKV MOV MP3 MP4 MPEG MPG MSI OGG PDF RAR TAR WAV WEBM WMA WMV XZ ZIP DMG DEB RPM ZST FLAC OPUS EPUB".split(" "),
  excludedSites: [],
  minSizeKb: 0,
  videoPanel: true,
};

export function extensionOf(nameOrUrl: string): string {
  let path = nameOrUrl;
  try {
    path = new URL(nameOrUrl).pathname;
  } catch {
    /* plain file name or Windows path */
  }
  const base = path.split(/[\\/]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  return i > 0 ? base.slice(i + 1).toUpperCase() : "";
}

/** `*` wildcards, case-insensitive. */
function wildcard(pattern: string, value: string): boolean {
  const re = new RegExp("^" + pattern.trim().split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i");
  return re.test(value);
}

export function extensionMatches(ext: string, patterns: string[]): boolean {
  return !!ext && patterns.some((p) => wildcard(p, ext));
}

export function siteExcluded(url: string, patterns: string[]): boolean {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return patterns.some((p) => wildcard(p, host) || wildcard(p, url));
}

export interface DownloadInfo {
  url: string;
  /** Suggested or final file name (may be a full path in Firefox). */
  filename: string;
  /** Bytes, or -1/0 when unknown. */
  totalBytes: number;
  mime?: string;
}

const MIME_EXT: Record<string, string> = {
  "application/zip": "ZIP",
  "application/x-zip-compressed": "ZIP",
  "application/x-7z-compressed": "7Z",
  "application/vnd.rar": "RAR",
  "application/x-rar-compressed": "RAR",
  "application/x-msdownload": "EXE",
  "application/x-msi": "MSI",
  "application/pdf": "PDF",
  "video/mp4": "MP4",
  "video/webm": "WEBM",
  "audio/mpeg": "MP3",
  "application/x-iso9660-image": "ISO",
};

export function shouldCapture(d: DownloadInfo, cfg: AppConfig): boolean {
  if (!/^https?:/i.test(d.url)) return false; // blob:, data:, file: stay in the browser
  if (siteExcluded(d.url, cfg.excludedSites)) return false;
  if (cfg.minSizeKb > 0 && d.totalBytes > 0 && d.totalBytes < cfg.minSizeKb * 1024) return false;
  const ext = extensionOf(d.filename) || extensionOf(d.url) || MIME_EXT[(d.mime ?? "").toLowerCase()] || "";
  return extensionMatches(ext, cfg.captureExtensions);
}

export type StreamKind = "hls" | "dash" | "file";

export interface MediaHit {
  url: string;
  kind: StreamKind;
  mime: string | null;
  size: number | null;
}

const SEGMENT_EXT = new Set(["TS", "M4S", "AAC", "VTT", "KEY", "JPG", "PNG"]);

/** Classifies a network response; null when it isn't a downloadable media resource. */
export function classifyMedia(url: string, contentType: string | null, contentLength: number | null): MediaHit | null {
  if (!/^https?:/i.test(url)) return null;
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = extensionOf(url);
  if (ct.includes("mpegurl") || ext === "M3U8") return { url, kind: "hls", mime: ct || null, size: null };
  if (ct === "application/dash+xml" || ext === "MPD") return { url, kind: "dash", mime: ct || null, size: null };
  // Pieces of a stream, not something to save on their own.
  if (SEGMENT_EXT.has(ext) || ct === "video/mp2t" || ct === "video/iso.segment") return null;
  const mediaType = ct.startsWith("video/") || ct.startsWith("audio/");
  const mediaExt = ["MP4", "WEBM", "MKV", "FLV", "MOV", "M4A", "MP3", "OGG", "OPUS", "M4V"].includes(ext);
  if (!mediaType && !(mediaExt && (ct === "" || ct === "application/octet-stream"))) return null;
  // Tiny responses are previews, beacons or one range of a larger file.
  if (contentLength != null && contentLength < 512 * 1024) return null;
  return { url, kind: "file", mime: ct || null, size: contentLength };
}

/** Same media requested with different byte ranges → one entry. */
export function mediaKey(url: string): string {
  try {
    const u = new URL(url);
    for (const p of ["range", "rn", "rbuf", "bytestart", "byteend", "_"]) u.searchParams.delete(p);
    return u.toString();
  } catch {
    return url;
  }
}

/** Sites whose video URLs only yt-dlp can resolve; their raw requests aren't worth listing. */
export function isOpaqueVideoHost(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return /(^|\.)googlevideo\.com$/.test(h);
  } catch {
    return false;
  }
}

export function fileNameFromPath(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

import { invoke } from "@tauri-apps/api/core";

export type Status = "queued" | "probing" | "downloading" | "paused" | "completed" | "failed";
export type Kind = "http" | "video";

export interface Download {
  id: number;
  url: string;
  pageUrl: string | null;
  fileName: string;
  destDir: string;
  category: string;
  status: Status;
  size: number | null;
  downloaded: number;
  headers: [string, string][];
  kind: Kind;
  videoFormat: string | null;
  queueId: number | null;
  description: string;
  error: string | null;
  resumable: boolean;
  addedAt: number;
  lastTryAt: number | null;
  completedAt: number | null;
}

export interface NewDownload {
  url: string;
  pageUrl?: string | null;
  fileName: string;
  destDir: string;
  category: string;
  size?: number | null;
  headers?: [string, string][];
  kind: Kind;
  queueId?: number | null;
  description?: string;
  resumable?: boolean;
}

export interface Segment {
  start: number;
  end: number;
  pos: number;
}

export interface Progress {
  id: number;
  status: Status;
  downloaded: number;
  total: number | null;
  speed: number;
  etaSecs: number | null;
  connections: number;
  segments: Segment[];
  fileName: string | null;
  phase: string | null;
  error: string | null;
}

export interface Settings {
  connections: number;
  maxRetries: number;
  speedLimitKbps: number;
  downloadRoot: string;
  useCategoryFolders: boolean;
  captureExtensions: string[];
  captureMinSizeKb: number;
  excludedSites: string[];
  showCaptureDialog: boolean;
  showProgressWindow: boolean;
  showCompleteDialog: boolean;
  clipboardMonitor: boolean;
  startWithWindows: boolean;
  videoPanel: boolean;
  proxy: string | null;
  preferMp4: boolean;
  updateYtdlp: boolean;
  onboarded: boolean;
}

export type AfterQueue = "nothing" | "exit" | "sleep" | "shutdown";

export interface Queue {
  id: number;
  name: string;
  maxConcurrent: number;
  schedule: { startTime: string | null; stopTime: string | null; days: number[] } | null;
  afterDone: AfterQueue;
  running: boolean;
}

export interface ProbeResult {
  fileName: string;
  size: number | null;
  resumable: boolean;
  contentType: string | null;
  finalUrl: string;
  category: string;
  destDir: string;
}

export interface DownloadCapture {
  type: "download";
  url: string;
  referrer?: string | null;
  pageUrl?: string | null;
  cookies?: string | null;
  userAgent?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  mime?: string | null;
}

export interface MediaStream {
  url: string;
  kind: "hls" | "dash" | "file";
  mime?: string | null;
  size?: number | null;
}

export interface VideoCapture {
  type: "video";
  pageUrl: string;
  title?: string | null;
  streams: MediaStream[];
}

export interface LinksCapture {
  type: "links";
  pageUrl: string;
  links: { url: string; text: string }[];
  cookies?: string | null;
  userAgent?: string | null;
}

export type Pending = DownloadCapture | VideoCapture | LinksCapture;

export interface VideoChoice {
  id: string;
  label: string;
  height: number | null;
  size: number | null;
}

export interface VideoInfoResult {
  info: {
    title: string;
    thumbnail: string | null;
    duration: number | null;
    extractor: string;
    webpageUrl: string;
    isLive: boolean;
    choices: VideoChoice[];
  } | null;
  sourceUrl: string | null;
  error: string | null;
  title: string | null;
  pageUrl: string;
  streams: MediaStream[];
}

export interface ToolStatus {
  ytdlp: string | null;
  ffmpeg: string | null;
  nativeHost: string | null;
  extensionDir: string | null;
  chromeExtensionId: string;
  firefoxExtensionId: string;
  version: string;
}

export interface BrowserStatus {
  id: string;
  name: string;
  exe: string;
  engine: "chromium" | "firefox";
  connectedAt: number | null;
  extensionPath: string | null;
  signedXpi: boolean;
}

export const api = {
  list: () => invoke<Download[]>("list_downloads"),
  get: (id: number) => invoke<Download | null>("get_download", { id }),
  add: (download: NewDownload, start: boolean) => invoke<number>("add_download", { download, start }),
  addMany: (downloads: NewDownload[], start: boolean) => invoke<number[]>("add_many", { downloads, start }),
  start: (id: number) => invoke<void>("start_download", { id }),
  pause: (id: number) => invoke<void>("pause_download", { id }),
  pauseAll: () => invoke<void>("pause_all"),
  remove: (id: number, deleteFile: boolean) => invoke<void>("delete_download", { id, deleteFile }),
  removeCompleted: () => invoke<void>("delete_completed"),
  refreshAddress: (id: number, url: string) => invoke<void>("refresh_address", { id, url }),
  openFile: (id: number) => invoke<void>("open_file", { id }),
  openFolder: (id: number) => invoke<void>("open_folder", { id }),
  probe: (url: string, headers: [string, string][] = []) => invoke<ProbeResult>("probe_url", { url, headers }),
  placement: (fileName: string) => invoke<{ category: string; destDir: string }>("placement_for", { fileName }),
  settings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<void>("save_settings", { settings }),
  queues: () => invoke<Queue[]>("list_queues"),
  saveQueue: (queue: Queue) => invoke<number>("save_queue", { queue }),
  deleteQueue: (id: number) => invoke<void>("delete_queue", { id }),
  startQueue: (id: number) => invoke<void>("start_queue", { id }),
  stopQueue: (id: number) => invoke<void>("stop_queue", { id }),
  setQueue: (id: number, queueId: number | null) => invoke<void>("set_download_queue", { id, queueId }),
  pending: (token: string) => invoke<Pending>("get_pending", { token }),
  closePending: (token: string) => invoke<void>("close_pending", { token }),
  videoInfo: (token: string) => invoke<VideoInfoResult>("video_info", { token }),
  addVideo: (a: {
    token: string;
    sourceUrl: string;
    choice: string;
    fileName: string;
    destDir: string;
    start: boolean;
    queueId: number | null;
  }) => invoke<number>("add_video", a),
  addStreamDirect: (a: { token: string; url: string; fileName: string; destDir: string; start: boolean }) =>
    invoke<number>("add_stream_direct", a),
  tools: () => invoke<ToolStatus>("tool_status"),
  captureUrl: (url: string) => invoke<void>("capture_url", { url }),
  browsers: () => invoke<BrowserStatus[]>("list_browsers"),
  /** Opens the browser and copies its extensions-page address (returned). */
  openBrowserSetup: (id: string) => invoke<string | null>("open_browser_setup", { id }),
  revealExtension: (id: string) => invoke<void>("reveal_extension", { id }),
  showMain: () => invoke<void>("show_main"),
  about: () => invoke<{ version: string; projectUrl: string; supportUrl: string; supportEmail: string }>("about"),
  openLink: (which: "project" | "issues" | "releases" | "support") => invoke<void>("open_link", { which }),
  takeBrowserSelection: () => invoke<string[]>("take_browser_selection"),
  clipboardLink: () => invoke<string | null>("clipboard_link"),
  openBrowserSetupWindow: (selected: string[] = []) => invoke<void>("open_browser_setup_window", { selected }),
};

export const MAIN_QUEUE = 1;

export function fmtBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}

export function fmtSpeed(bps: number): string {
  return bps > 0 ? `${fmtBytes(Math.round(bps))}/s` : "";
}

export function fmtEta(secs: number | null | undefined): string {
  if (secs == null || !isFinite(secs)) return "";
  if (secs < 60) return `${secs} sec`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return h > 0 ? `${h} hr ${m} min` : `${m} min ${s.toString().padStart(2, "0")} sec`;
}

export function fmtDate(unix: number | null | undefined): string {
  if (!unix) return "";
  return new Date(unix * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function percent(done: number, total: number | null | undefined): number | null {
  return total ? Math.min(100, (done / total) * 100) : null;
}

/** Splits a file name into stem and extension (".zip"). */
export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("\\") || dir.endsWith("/") ? dir + name : `${dir}\\${name}`;
}

export type FixAction = "fix-link" | "retry" | "settings" | null;

/** Turns engine/yt-dlp error text into plain language plus the most useful next step. */
export function describeError(raw: string | null | undefined): { text: string; action: FixAction } {
  const e = (raw ?? "").toLowerCase();
  if (!e) return { text: "Something went wrong.", action: "retry" };
  if (e.includes("link expired") || e.includes("http 401") || e.includes("http 403") || e.includes("http 410"))
    return { text: "The link expired or needs you to be signed in.", action: "fix-link" };
  if (e.includes("http 404")) return { text: "The file isn't on the server any more.", action: "fix-link" };
  if (e.includes("drm")) return { text: "This video is copy-protected (DRM) and can't be downloaded.", action: null };
  if (e.includes("isn't supported for video") || e.includes("unsupported url")) return { text: "This site isn't supported for video downloads.", action: null };
  if (e.includes("yt-dlp was not found")) return { text: "Video downloads need yt-dlp, which wasn't found.", action: "settings" };
  if (e.includes("disk error") || e.includes("space")) return { text: "Couldn't save the file. Check free space and the folder.", action: "retry" };
  if (e.includes("http 5")) return { text: "The website's server had a problem.", action: "retry" };
  if (e.includes("network") || e.includes("connection") || e.includes("timed out") || e.includes("dns"))
    return { text: "Connection problem. Check your internet and try again.", action: "retry" };
  return { text: raw!.replace(/^error:\s*/i, ""), action: "retry" };
}

/** "about 2 min left" style wording. */
export function fmtEtaFriendly(secs: number | null | undefined): string {
  if (secs == null || !isFinite(secs)) return "";
  if (secs < 10) return "a few seconds left";
  if (secs < 60) return `${secs} sec left`;
  if (secs < 3600) return `about ${Math.round(secs / 60)} min left`;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  return `about ${h} hr${m ? ` ${m} min` : ""} left`;
}

export function fmtRelative(unix: number | null | undefined): string {
  if (!unix) return "";
  const d = Date.now() / 1000 - unix;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  const date = new Date(unix * 1000);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return `today ${date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (date.toDateString() === y.toDateString()) return "yesterday";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

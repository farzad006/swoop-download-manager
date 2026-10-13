// Dev-only stand-in for the Rust backend so the UI can be previewed in a plain
// browser (`npm run dev`, open http://localhost:1420). Never bundled into the app:
// main.tsx only imports it when import.meta.env.DEV and Tauri is absent.
import { emit } from "@tauri-apps/api/event";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import type { Download, Progress, Queue, Settings } from "../api";

const MB = 1024 * 1024;
const now = Math.floor(Date.now() / 1000);
const dl = (p: Partial<Download> & Pick<Download, "id" | "fileName" | "category" | "status">): Download => ({
  url: `https://downloads.example.com/${encodeURIComponent(p.fileName)}`,
  pageUrl: null,
  destDir: `C:\\Users\\you\\Downloads\\${p.category}`,
  size: null,
  downloaded: 0,
  headers: [],
  kind: "http",
  videoFormat: null,
  queueId: null,
  description: "",
  error: null,
  resumable: true,
  addedAt: now - p.id * 3600,
  lastTryAt: now - p.id * 3000,
  completedAt: null,
  ...p,
});

const downloads: Download[] = [
  dl({ id: 1, fileName: "ubuntu-26.04-desktop-amd64.iso", category: "Compressed", status: "downloading", size: 6144 * MB, downloaded: 2310 * MB }),
  dl({ id: 2, fileName: "Big Buck Bunny (1080p).mp4", category: "Video", status: "downloading", kind: "video", size: 412 * MB, downloaded: 98 * MB, description: "Big Buck Bunny" }),
  dl({ id: 3, fileName: "vlc-4.0.0-win64.exe", category: "Programs", status: "completed", size: 44 * MB, downloaded: 44 * MB, completedAt: now - 7200 }),
  dl({ id: 4, fileName: "annual-report-2026.pdf", category: "Documents", status: "completed", size: 8.4 * MB, downloaded: 8.4 * MB }),
  dl({ id: 5, fileName: "podcast-episode-212.mp3", category: "Music", status: "paused", size: 96 * MB, downloaded: 31 * MB }),
  dl({ id: 6, fileName: "dataset-full.tar.zst", category: "Compressed", status: "failed", size: 2048 * MB, downloaded: 400 * MB, error: "link expired or access denied (HTTP 403); refresh the download address" }),
  dl({ id: 7, fileName: "nightly-build.zip", category: "Compressed", status: "queued", queueId: 1, size: 310 * MB }),
];

const settings: Settings = {
  connections: 8,
  maxRetries: 10,
  speedLimitKbps: 0,
  downloadRoot: "C:\\Users\\you\\Downloads",
  useCategoryFolders: true,
  captureExtensions: "3GP 7Z AAC APK AVI EXE ISO MKV MP3 MP4 MSI PDF RAR ZIP".split(" "),
  captureMinSizeKb: 0,
  excludedSites: ["*.update.microsoft.com"],
  showCaptureDialog: true,
  showProgressWindow: true,
  showCompleteDialog: true,
  clipboardMonitor: true,
  startWithWindows: false,
  videoPanel: true,
  proxy: null,
  preferMp4: true,
  updateYtdlp: true,
  connectedBrowsers: {},
  // Preview the welcome tour with ?onboarding=1
  onboarded: !location.search.includes("onboarding"),
} as Settings;

const queues: Queue[] = [
  { id: 1, name: "Main download queue", maxConcurrent: 2, schedule: { startTime: "02:00", stopTime: "07:00", days: [1, 2, 3, 4, 5] }, afterDone: "nothing", running: false },
];

const ext = "C:\\Users\\you\\AppData\\Local\\Swoop\\extension";
const browsers = [
  { id: "chrome", name: "Google Chrome", exe: "chrome.exe", engine: "chromium", connectedAt: null, extensionPath: `${ext}\\chrome-mv3`, signedXpi: false },
  { id: "edge", name: "Microsoft Edge", exe: "msedge.exe", engine: "chromium", connectedAt: now - 60, extensionPath: `${ext}\\chrome-mv3`, signedXpi: false },
  { id: "opera", name: "Opera", exe: "opera.exe", engine: "chromium", connectedAt: null as number | null, extensionPath: `${ext}\\chrome-mv3`, signedXpi: false },
  { id: "firefox", name: "Mozilla Firefox", exe: "firefox.exe", engine: "firefox", connectedAt: null, extensionPath: `${ext}\\firefox-mv2\\manifest.json`, signedXpi: false },
];

export function installMockBackend() {
  // Simulate the extension reporting in from Opera a few seconds after opening setup.
  if (location.hash.startsWith("#/browsers")) {
    setTimeout(() => {
      browsers[2].connectedAt = Math.floor(Date.now() / 1000);
      emit("browser-connected", "opera");
    }, 4000);
  }
  const label = location.hash.startsWith("#/progress") ? "progress-1" : "main";
  mockWindows(label);
  mockIPC(
    (cmd, args: any) => {
      switch (cmd) {
        case "list_downloads":
          return location.search.includes("empty") ? [] : downloads;
        case "get_download":
          return downloads.find((d) => d.id === args.id) ?? null;
        case "get_settings":
          return structuredClone(settings);
        case "save_settings":
          Object.assign(settings, args.settings);
          return null;
        case "take_browser_selection":
          return ["chrome", "edge"];
        case "clipboard_link":
          return location.search.includes("clip") ? "https://releases.example.org/tools/setup-2.4.1.exe" : null;
        case "capture_url":
          return null;
        case "list_queues":
          return queues;
        case "tool_status":
          return { ytdlp: "C:\\Tools\\yt-dlp.exe", ffmpeg: "C:\\Tools\\ffmpeg.exe", nativeHost: "C:\\Program Files\\Swoop\\swoop-host.exe", extensionDir: "C:\\Users\\you\\AppData\\Local\\Swoop\\extension", chromeExtensionId: "fhnkijclhenhpkpllphcclallnnkkiib", firefoxExtensionId: "swoop@alistudio", version: "0.1.0" };
        case "placement_for": {
          const ext = String(args.fileName).split(".").pop()?.toLowerCase();
          const category = ext === "mp4" ? "Video" : ext === "mp3" ? "Music" : ext === "zip" ? "Compressed" : "General";
          return { category, destDir: category === "General" ? settings.downloadRoot : `${settings.downloadRoot}\\${category}` };
        }
        case "list_browsers":
          // Fresh objects each call, like real IPC (same refs would skip React updates).
          return structuredClone(browsers);
        case "get_pending":
          return location.hash.startsWith("#/video")
            ? { type: "video", pageUrl: "https://videos.example.com/watch?v=abc", title: "Big Buck Bunny", streams: [] }
            : { type: "download", url: "https://github.com/videolan/vlc/releases/download/4.0.0/vlc-4.0.0-win64.zip", fileName: null, fileSize: null };
        case "probe_url":
          return { fileName: "vlc-4.0.0-win64.zip", size: 52_428_800, resumable: true, contentType: "application/zip", finalUrl: args.url, category: "Compressed", destDir: `${settings.downloadRoot}\\Compressed` };
        case "video_info":
          return {
            info: {
              title: "Big Buck Bunny",
              thumbnail: null,
              duration: 596,
              extractor: "Generic",
              webpageUrl: "https://videos.example.com/watch?v=abc",
              isLive: false,
              choices: [
                { id: "best", label: "Best quality", height: 2160, size: 1_310_720_000 },
                { id: "h2160", label: "2160p", height: 2160, size: 1_310_720_000 },
                { id: "h1080", label: "1080p", height: 1080, size: 412 * MB },
                { id: "h720", label: "720p", height: 720, size: 210 * MB },
                { id: "h360", label: "360p", height: 360, size: 61 * MB },
                { id: "audio", label: "Audio only (MP3)", height: null, size: 9 * MB },
              ],
            },
            sourceUrl: "https://videos.example.com/watch?v=abc",
            error: null,
            title: "Big Buck Bunny",
            pageUrl: "https://videos.example.com/watch?v=abc",
            streams: [],
          };
        default:
          return null;
      }
    },
    { shouldMockEvents: true },
  );

  // Simulated live progress for the two running downloads.
  const segs = (size: number, done: number, n: number) =>
    Array.from({ length: n }, (_, i) => {
      const start = Math.floor((size / n) * i);
      const end = Math.floor((size / n) * (i + 1));
      return { start, end, pos: Math.min(end, start + Math.floor((done / n) * (0.6 + 0.8 * ((i * 37) % 10) / 10))) };
    });
  setInterval(() => {
    for (const d of downloads.filter((x) => x.status === "downloading")) {
      d.downloaded = Math.min(d.size!, d.downloaded + (d.kind === "video" ? 3 : 11) * MB);
      const speed = (d.kind === "video" ? 6 : 22) * MB * (0.9 + Math.random() * 0.2);
      const p: Progress = {
        id: d.id,
        status: "downloading",
        downloaded: d.downloaded,
        total: d.size,
        speed,
        etaSecs: Math.round((d.size! - d.downloaded) / speed),
        connections: d.kind === "video" ? 0 : 8,
        segments: d.kind === "video" ? [] : segs(d.size!, d.downloaded, 8),
        fileName: d.fileName,
        phase: null,
        error: null,
      };
      emit("progress", p);
    }
  }, 500);
}

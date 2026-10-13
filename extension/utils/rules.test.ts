import { describe, expect, it } from "vitest";
import { classifyMedia, DEFAULT_CONFIG, detectBrowser, extensionOf, mediaKey, shouldCapture, siteExcluded } from "./rules";

const cfg = { ...DEFAULT_CONFIG, captureExtensions: ["ZIP", "EXE", "R0*", "MP4"] };

describe("shouldCapture", () => {
  it("captures configured file types over http(s)", () => {
    expect(shouldCapture({ url: "https://x.com/a.zip", filename: "", totalBytes: -1 }, cfg)).toBe(true);
    expect(shouldCapture({ url: "https://x.com/dl?id=1", filename: "setup.EXE", totalBytes: 0 }, cfg)).toBe(true);
    expect(shouldCapture({ url: "https://x.com/a.r01", filename: "", totalBytes: 0 }, cfg)).toBe(true);
  });
  it("uses the Firefox full path's file name", () => {
    expect(shouldCapture({ url: "https://x.com/get", filename: "C:\\Users\\me\\Downloads\\a.zip", totalBytes: 0 }, cfg)).toBe(true);
  });
  it("falls back to the MIME type", () => {
    expect(shouldCapture({ url: "https://x.com/get", filename: "", totalBytes: 0, mime: "application/zip" }, cfg)).toBe(true);
  });
  it("leaves other downloads to the browser", () => {
    expect(shouldCapture({ url: "https://x.com/a.html", filename: "a.html", totalBytes: 10 }, cfg)).toBe(false);
    expect(shouldCapture({ url: "blob:https://x.com/123", filename: "a.zip", totalBytes: 10 }, cfg)).toBe(false);
    expect(shouldCapture({ url: "data:application/zip;base64,AA", filename: "a.zip", totalBytes: 10 }, cfg)).toBe(false);
  });
  it("respects minimum size and excluded sites", () => {
    const c = { ...cfg, minSizeKb: 100, excludedSites: ["*.example.org"] };
    expect(shouldCapture({ url: "https://x.com/a.zip", filename: "", totalBytes: 50 * 1024 }, c)).toBe(false);
    expect(shouldCapture({ url: "https://x.com/a.zip", filename: "", totalBytes: -1 }, c)).toBe(true);
    expect(shouldCapture({ url: "https://dl.example.org/a.zip", filename: "", totalBytes: -1 }, c)).toBe(false);
  });
});

describe("classifyMedia", () => {
  it("recognises manifests regardless of size", () => {
    expect(classifyMedia("https://cdn/x/master.m3u8?t=1", "application/vnd.apple.mpegurl", 300)?.kind).toBe("hls");
    expect(classifyMedia("https://cdn/x/manifest", "application/dash+xml", 300)?.kind).toBe("dash");
  });
  it("keeps sizeable media files", () => {
    const hit = classifyMedia("https://cdn/v.mp4", "video/mp4", 10_000_000);
    expect(hit).toEqual({ url: "https://cdn/v.mp4", kind: "file", mime: "video/mp4", size: 10_000_000 });
    expect(classifyMedia("https://cdn/v.mp4", "application/octet-stream", null)?.kind).toBe("file");
  });
  it("drops segments, small responses and non-media", () => {
    expect(classifyMedia("https://cdn/seg-1.ts", "video/mp2t", 2_000_000)).toBeNull();
    expect(classifyMedia("https://cdn/chunk.m4s", "video/mp4", 2_000_000)).toBeNull();
    expect(classifyMedia("https://cdn/v.mp4", "video/mp4", 1000)).toBeNull();
    expect(classifyMedia("https://cdn/page", "text/html", 5_000_000)).toBeNull();
    expect(classifyMedia("blob:https://x/1", "video/mp4", 5_000_000)).toBeNull();
  });
});

describe("detectBrowser", () => {
  const chromeUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
  it("tells the browsers apart", () => {
    expect(detectBrowser(chromeUA, ["Chromium", "Google Chrome", "Not=A?Brand"])).toBe("chrome");
    expect(detectBrowser(`${chromeUA} Edg/155.0.0.0`, ["Chromium", "Microsoft Edge"])).toBe("edge");
    expect(detectBrowser(`${chromeUA} OPR/135.0.0.0`, ["Chromium", "Opera"])).toBe("opera");
    expect(detectBrowser(chromeUA, ["Chromium", "Brave"], true)).toBe("brave");
    expect(detectBrowser("Mozilla/5.0 (Windows NT 10.0; rv:150.0) Gecko/20100101 Firefox/150.0")).toBe("firefox");
    expect(detectBrowser(chromeUA, ["Chromium"])).toBe("chromium");
  });
});

describe("helpers", () => {
  it("extensionOf handles urls, names and paths", () => {
    expect(extensionOf("https://x.com/a/b.tar.gz?x=1")).toBe("GZ");
    expect(extensionOf("C:\\dl\\movie.MKV")).toBe("MKV");
    expect(extensionOf("noext")).toBe("");
  });
  it("mediaKey ignores byte-range params", () => {
    expect(mediaKey("https://v/x.mp4?id=1&range=0-100")).toBe(mediaKey("https://v/x.mp4?id=1&range=100-200"));
  });
  it("siteExcluded matches host wildcards", () => {
    expect(siteExcluded("https://a.update.microsoft.com/x", ["*.update.microsoft.com"])).toBe(true);
    expect(siteExcluded("https://microsoft.com/x", ["*.update.microsoft.com"])).toBe(false);
  });
});

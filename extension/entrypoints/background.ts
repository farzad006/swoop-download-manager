import { browser } from "wxt/browser";
import { classifyMedia, fileNameFromPath, isOpaqueVideoHost, mediaKey, shouldCapture, type MediaHit } from "@/utils/rules";
import { cookieHeader, cookieObjects, getConfig, sendNative } from "@/utils/native";

type TabMedia = Record<string, MediaHit>;

export default defineBackground(() => {
  // ---- per-tab detected media (kept in session storage: MV3 workers sleep) ----
  const media = new Map<number, TabMedia>();
  const sessionStore = browser.storage.session ?? browser.storage.local;
  // MV2 (Firefox) calls the toolbar button browserAction.
  const action = browser.action ?? (browser as unknown as { browserAction: typeof browser.action }).browserAction;

  async function loadTab(tabId: number): Promise<TabMedia> {
    if (!media.has(tabId)) {
      const key = `media:${tabId}`;
      const saved = (await sessionStore.get(key))[key] as TabMedia | undefined;
      media.set(tabId, saved ?? {});
    }
    return media.get(tabId)!;
  }

  async function saveTab(tabId: number) {
    const m = media.get(tabId) ?? {};
    await sessionStore.set({ [`media:${tabId}`]: m });
    const n = Object.keys(m).length;
    action?.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
    action?.setBadgeBackgroundColor({ tabId, color: "#0f6cbd" }).catch(() => {});
  }

  async function clearTab(tabId: number) {
    media.set(tabId, {});
    await saveTab(tabId);
  }

  browser.webRequest.onHeadersReceived.addListener(
    (d) => {
      if (d.tabId < 0 || isOpaqueVideoHost(d.url)) return;
      const header = (name: string) => d.responseHeaders?.find((h) => h.name.toLowerCase() === name)?.value ?? null;
      const len = header("content-length");
      const range = header("content-range");
      // For partial responses the total size is after the slash.
      const total = range?.includes("/") ? Number(range.split("/")[1]) || null : len ? Number(len) : null;
      const hit = classifyMedia(d.url, header("content-type"), total);
      if (!hit) return;
      loadTab(d.tabId).then((m) => {
        const key = mediaKey(hit.url);
        if (m[key]) return;
        const keys = Object.keys(m);
        if (keys.length >= 50) delete m[keys[0]!];
        m[key] = hit;
        saveTab(d.tabId);
      });
    },
    { urls: ["<all_urls>"], types: ["media", "xmlhttprequest", "other", "object"] },
    ["responseHeaders"],
  );

  browser.tabs.onUpdated.addListener((tabId, info) => {
    if (info.status === "loading" && info.url) clearTab(tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    media.delete(tabId);
    sessionStore.remove(`media:${tabId}`);
  });

  // ---- download takeover ----
  let bypassUntil = 0;
  const handedOff = new Set<number>();

  async function captureEnabled(): Promise<boolean> {
    const { captureEnabled = true } = await browser.storage.local.get("captureEnabled");
    return captureEnabled as boolean;
  }

  /** Decides on one browser download; returns true if OurIDM took it. */
  async function maybeTakeOver(item: Browser.downloads.DownloadItem): Promise<boolean> {
    if (handedOff.has(item.id) || Date.now() < bypassUntil || !(await captureEnabled())) return false;
    const url = item.finalUrl || item.url;
    const cfg = await getConfig();
    if (!shouldCapture({ url, filename: item.filename ?? "", totalBytes: item.fileSize || item.totalBytes || -1, mime: item.mime }, cfg)) {
      return false;
    }
    handedOff.add(item.id);
    await browser.downloads.cancel(item.id).catch(() => {});
    const reply = await sendNative({
      type: "download",
      url,
      referrer: item.referrer || null,
      cookies: await cookieHeader(url),
      userAgent: navigator.userAgent,
      fileName: item.filename ? fileNameFromPath(item.filename) : null,
      fileSize: item.totalBytes > 0 ? item.totalBytes : null,
      mime: item.mime || null,
    });
    if (!reply.ok) {
      // OurIDM isn't installed or didn't answer: give the download back to the browser.
      console.warn("OurIDM unavailable, browser keeps the download:", reply.error);
      bypassUntil = Date.now() + 5000;
      await browser.downloads.download({ url }).catch(() => {});
      return false;
    }
    await browser.downloads.erase({ id: item.id }).catch(() => {});
    return true;
  }

  const onDetermining = (browser.downloads as unknown as { onDeterminingFilename?: Browser.events.Event<any> }).onDeterminingFilename;
  if (onDetermining) {
    // Chromium holds the download until suggest() is called, so nothing is written yet.
    onDetermining.addListener((item: Browser.downloads.DownloadItem, suggest: () => void) => {
      maybeTakeOver(item).finally(() => {
        try {
          suggest();
        } catch {
          /* already cancelled */
        }
      });
      return true;
    });
  } else {
    // Firefox: no filename hook, take over as soon as the download appears.
    browser.downloads.onCreated.addListener((item) => {
      if (item.state === "in_progress") maybeTakeOver(item);
    });
  }

  // ---- video capture ----
  async function sendVideo(tabId: number, pageUrl: string, title: string, extraSrc?: string) {
    const m = await loadTab(tabId);
    const streams = Object.values(m);
    if (extraSrc && /^https?:/i.test(extraSrc) && !streams.some((s) => s.url === extraSrc)) {
      streams.unshift({ url: extraSrc, kind: "file", mime: null, size: null });
    }
    const urls = [pageUrl, ...streams.map((s) => s.url)];
    return sendNative({
      type: "video",
      pageUrl,
      title,
      streams,
      cookies: await cookieObjects(urls),
      userAgent: navigator.userAgent,
    });
  }

  browser.runtime.onMessage.addListener((msg: any, sender) => {
    const tabId = sender.tab?.id ?? msg.tabId;
    switch (msg?.type) {
      case "bypass":
        bypassUntil = Date.now() + 3000;
        return;
      case "video-click":
        if (tabId != null) return sendVideo(tabId, msg.pageUrl, msg.title, msg.src);
        return;
      case "get-config":
        return getConfig();
      case "popup-state":
        return (async () => ({
          ping: await sendNative({ type: "ping" }),
          captureEnabled: await captureEnabled(),
          media: tabId != null ? Object.values(await loadTab(tabId)) : [],
        }))();
      case "set-capture":
        return browser.storage.local.set({ captureEnabled: !!msg.enabled });
      case "popup-video":
        return sendVideo(msg.tabId, msg.pageUrl, msg.title);
      case "popup-download":
        return sendNative({ type: "download", url: msg.url, referrer: msg.pageUrl, userAgent: navigator.userAgent, forceDialog: true });
    }
  });

  // ---- context menus ----
  browser.runtime.onInstalled.addListener(() => {
    browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({ id: "dl-link", title: "Download with OurIDM", contexts: ["link", "image", "video", "audio"] });
      browser.contextMenus.create({ id: "dl-all", title: "Download all links with OurIDM", contexts: ["page", "selection"] });
      browser.contextMenus.create({ id: "dl-video", title: "Download video from this page with OurIDM", contexts: ["page", "video"] });
    });
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    const pageUrl = info.frameUrl || info.pageUrl || tab?.url || "";
    if (info.menuItemId === "dl-link") {
      const url = info.linkUrl || info.srcUrl;
      if (!url) return;
      await sendNative({
        type: "download",
        url,
        referrer: pageUrl,
        cookies: await cookieHeader(url),
        userAgent: navigator.userAgent,
        forceDialog: true,
      });
    } else if (info.menuItemId === "dl-all" && tab?.id != null) {
      const links = (await browser.tabs.sendMessage(tab.id, { type: "collect-links", selectionOnly: !!info.selectionText }, { frameId: 0 }).catch(() => [])) as { url: string; text: string }[];
      await sendNative({
        type: "links",
        pageUrl,
        links,
        cookies: await cookieHeader(pageUrl),
        userAgent: navigator.userAgent,
      });
    } else if (info.menuItemId === "dl-video" && tab?.id != null) {
      await sendVideo(tab.id, pageUrl, tab.title ?? "", info.srcUrl);
    }
  });

  getConfig(true);
});

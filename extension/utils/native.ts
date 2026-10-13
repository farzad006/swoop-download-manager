import { browser } from "wxt/browser";
import { DEFAULT_CONFIG, type AppConfig } from "./rules";

export const HOST = "com.ouridm.host";

export interface NativeReply {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

export async function sendNative(msg: Record<string, unknown>): Promise<NativeReply> {
  try {
    return (await browser.runtime.sendNativeMessage(HOST, msg)) as NativeReply;
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

let cached: { cfg: AppConfig; at: number } | null = null;

/** Capture rules from the app, refreshed every few minutes. */
export async function getConfig(force = false): Promise<AppConfig> {
  if (!force && cached && Date.now() - cached.at < 5 * 60_000) return cached.cfg;
  const r = await sendNative({ type: "config" });
  if (r.ok) {
    cached = {
      cfg: {
        captureExtensions: (r.captureExtensions as string[]) ?? DEFAULT_CONFIG.captureExtensions,
        excludedSites: (r.excludedSites as string[]) ?? [],
        minSizeKb: (r.minSizeKb as number) ?? 0,
        videoPanel: (r.videoPanel as boolean) ?? true,
      },
      at: Date.now(),
    };
    return cached.cfg;
  }
  return cached?.cfg ?? DEFAULT_CONFIG;
}

export async function cookieHeader(url: string): Promise<string> {
  try {
    const cookies = await browser.cookies.getAll({ url });
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return "";
  }
}

/** Cookies for several URLs as plain objects (the app writes a cookies.txt for yt-dlp). */
export async function cookieObjects(urls: string[]) {
  const seen = new Map<string, object>();
  for (const url of urls) {
    try {
      for (const c of await browser.cookies.getAll({ url })) {
        seen.set(`${c.domain}|${c.path}|${c.name}`, {
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          secure: c.secure,
          hostOnly: c.hostOnly,
          expirationDate: c.expirationDate ?? null,
        });
      }
    } catch {
      /* invalid url */
    }
  }
  return [...seen.values()];
}

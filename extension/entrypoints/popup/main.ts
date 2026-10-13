import { browser } from "wxt/browser";
import type { MediaHit } from "@/utils/rules";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function fmtBytes(n: number | null): string {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

async function init() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const state: any = await browser.runtime.sendMessage({ type: "popup-state", tabId: tab?.id });

  const status = $("status");
  if (state.ping?.ok) {
    status.textContent = `Connected · v${state.ping.version}`;
    status.className = "status ok";
  } else {
    status.textContent = "Swoop not reachable";
    status.className = "status bad";
    status.title = state.ping?.error ?? "";
  }

  const capture = $<HTMLInputElement>("capture");
  capture.checked = state.captureEnabled;
  capture.addEventListener("change", () => browser.runtime.sendMessage({ type: "set-capture", enabled: capture.checked }));

  $("video").addEventListener("click", async () => {
    await browser.runtime.sendMessage({ type: "popup-video", tabId: tab.id, pageUrl: tab.url, title: tab.title });
    window.close();
  });

  const list = $("media");
  const media: MediaHit[] = state.media ?? [];
  $("empty").style.display = media.length ? "none" : "";
  for (const m of media) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.title = m.url;
    name.textContent = decodeURIComponent(new URL(m.url).pathname.split("/").pop() || m.url);
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = m.kind === "file" ? fmtBytes(m.size) || "file" : m.kind;
    const btn = document.createElement("button");
    btn.textContent = "Download";
    btn.addEventListener("click", async () => {
      // Streams need yt-dlp (quality picker); plain files go straight to the engine.
      if (m.kind === "file") await browser.runtime.sendMessage({ type: "popup-download", url: m.url, pageUrl: tab.url });
      else await browser.runtime.sendMessage({ type: "popup-video", tabId: tab.id, pageUrl: tab.url, title: tab.title });
      window.close();
    });
    li.append(name, kind, btn);
    list.append(li);
  }
}

init();

import { browser } from "wxt/browser";

const MIN_W = 240;
const MIN_H = 135;

export default defineContentScript({
  matches: ["<all_urls>"],
  allFrames: true,
  matchAboutBlank: true,
  runAt: "document_idle",

  async main(ctx) {
    // Alt+click lets the browser keep a download, like IDM.
    document.addEventListener(
      "click",
      (e) => {
        if (e.altKey && (e.target as Element)?.closest?.("a[href]")) browser.runtime.sendMessage({ type: "bypass" });
      },
      true,
    );

    if (window === window.top) {
      browser.runtime.onMessage.addListener((msg: any) => {
        if (msg?.type !== "collect-links") return;
        return Promise.resolve(collectLinks(msg.selectionOnly));
      });
    }

    const cfg = await browser.runtime.sendMessage({ type: "get-config" }).catch(() => null);
    if (cfg && cfg.videoPanel === false) return;

    const panel = createPanel();
    let current: HTMLVideoElement | null = null;
    let hideTimer = 0;

    const eligible = (v: HTMLVideoElement) => {
      const r = v.getBoundingClientRect();
      return r.width >= MIN_W && r.height >= MIN_H && r.bottom > 0 && r.top < innerHeight && !document.fullscreenElement;
    };

    const place = () => {
      if (!current || !current.isConnected || !eligible(current)) {
        panel.hide();
        return;
      }
      const r = current.getBoundingClientRect();
      panel.show(Math.max(4, r.right - panel.width - 10), Math.max(4, r.top + 10));
    };

    // As soon as a real video shows on the page, ask Swoop to look it up so a
    // click opens the quality list instantly (yt-dlp needs several seconds).
    // Once per page address: YouTube keeps the same <video> while you move
    // between videos. The background page limits it further.
    let prefetchedUrl = "";
    let prefetchTimer = 0;
    const prefetch = (v: HTMLVideoElement) => {
      if (prefetchedUrl === location.href || prefetchTimer) return;
      prefetchTimer = window.setTimeout(() => {
        prefetchTimer = 0;
        if (!v.isConnected || !eligible(v) || prefetchedUrl === location.href) return;
        prefetchedUrl = location.href;
        const src = v.currentSrc && !v.currentSrc.startsWith("blob:") ? v.currentSrc : undefined;
        browser.runtime.sendMessage({ type: "video-prefetch", pageUrl: location.href, title: document.title, src }).catch(() => {});
      }, 300);
    };

    const activate = (v: HTMLVideoElement) => {
      clearTimeout(hideTimer);
      hideTimer = 0;
      current = v;
      place();
      prefetch(v);
    };

    const attach = (v: HTMLVideoElement) => {
      if ((v as any).__swoop) return;
      (v as any).__swoop = true;
      v.addEventListener("playing", () => activate(v));
      v.addEventListener("loadedmetadata", () => eligible(v) && prefetch(v));
      if (!v.paused && eligible(v)) activate(v);
      else if (eligible(v)) prefetch(v);
    };

    // Players and browsers (Opera's pop-out button, YouTube's controls) lay
    // elements over the <video>, so hover is hit-tested against its rectangle
    // instead of relying on mouseenter reaching the element.
    let frame = 0;
    const onPointer = (e: MouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const under = [...document.querySelectorAll("video")].find((v) => {
          const r = v.getBoundingClientRect();
          return eligible(v as HTMLVideoElement) && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
        }) as HTMLVideoElement | undefined;
        if (under) activate(under);
        else if (current && !panel.hovered() && !hideTimer) {
          hideTimer = window.setTimeout(() => {
            hideTimer = 0;
            if (!panel.hovered()) panel.hide();
          }, 2500);
        }
      });
    };
    document.addEventListener("mousemove", onPointer, { passive: true, capture: true });

    const scan = () => document.querySelectorAll("video").forEach((v) => attach(v as HTMLVideoElement));
    scan();
    const mo = new MutationObserver(() => scan());
    mo.observe(document.documentElement, { childList: true, subtree: true });
    ctx.onInvalidated(() => {
      mo.disconnect();
      document.removeEventListener("mousemove", onPointer, { capture: true });
      panel.remove();
    });
    addEventListener("scroll", place, { passive: true, capture: true });
    addEventListener("resize", place);
    document.addEventListener("fullscreenchange", place);

    panel.onClick(async () => {
      panel.busy(true);
      const src = current?.currentSrc && !current.currentSrc.startsWith("blob:") ? current.currentSrc : undefined;
      const reply: any = await browser.runtime
        .sendMessage({ type: "video-click", pageUrl: location.href, title: document.title, src })
        .catch((e: Error) => ({ ok: false, error: e.message }));
      panel.busy(false);
      if (reply && reply.ok === false) panel.flash("Swoop isn't running or isn't installed");
    });
  },
});

function collectLinks(selectionOnly: boolean): { url: string; text: string }[] {
  let anchors = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
  const sel = getSelection();
  if (selectionOnly && sel && sel.rangeCount > 0) {
    const range = sel.getRangeAt(0);
    anchors = anchors.filter((a) => range.intersectsNode(a));
  }
  return anchors
    .filter((a) => /^https?:/i.test(a.href))
    .map((a) => ({ url: a.href, text: (a.textContent ?? "").trim().slice(0, 200) }));
}

/** The floating button, isolated from page styles in a closed shadow root. */
function createPanel() {
  const host = document.createElement("swoop-panel");
  host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; display: none;";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      button {
        all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 6px;
        height: 30px; padding: 0 12px 0 9px; border-radius: 8px; cursor: pointer;
        font: 600 12px/1 "Segoe UI", system-ui, sans-serif; color: #fff;
        background: rgba(37,99,235,.95); box-shadow: 0 2px 10px rgba(0,0,0,.35);
        transition: background .15s;
      }
      button:hover { background: #1d4fd8; }
      button:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
      button[disabled] { opacity: .7; cursor: progress; }
      svg { width: 16px; height: 16px; flex: none; }
      .msg { margin-top: 4px; padding: 4px 8px; border-radius: 4px; background: #c42b1c; color: #fff; font: 12px "Segoe UI", sans-serif; display: none; }
    </style>
    <button type="button" aria-label="Download this video with Swoop">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>
      </svg>
      <span>Download this video</span>
    </button>
    <div class="msg" role="status"></div>`;
  (document.body ?? document.documentElement).appendChild(host);
  const btn = root.querySelector("button")!;
  const msg = root.querySelector<HTMLDivElement>(".msg")!;
  let hovered = false;
  host.addEventListener("mouseenter", () => (hovered = true));
  host.addEventListener("mouseleave", () => {
    hovered = false;
  });
  return {
    get width() {
      return btn.getBoundingClientRect().width || 170;
    },
    show(x: number, y: number) {
      host.style.display = "block";
      host.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    },
    hide() {
      host.style.display = "none";
    },
    hovered: () => hovered,
    remove: () => host.remove(),
    onClick(f: () => void) {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        f();
      });
    },
    busy(on: boolean) {
      btn.toggleAttribute("disabled", on);
    },
    flash(text: string) {
      msg.textContent = text;
      msg.style.display = "block";
      setTimeout(() => (msg.style.display = "none"), 4000);
    },
  };
}

import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Clock, Download, Link2, Search } from "lucide-react";
import { api, LinksCapture, MAIN_QUEUE, NewDownload } from "../api";
import { Button } from "../components/ui";

const TYPES: Record<string, string[]> = {
  All: [],
  Videos: ["mp4", "mkv", "webm", "avi", "mov", "m4v", "flv", "wmv", "ts"],
  Music: ["mp3", "m4a", "flac", "wav", "ogg", "opus", "aac"],
  Archives: ["zip", "rar", "7z", "gz", "tar", "xz", "bz2", "iso"],
  Documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "txt"],
  Programs: ["exe", "msi", "apk", "dmg", "deb", "rpm"],
  Images: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"],
};

function fileNameOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "") || "download";
  } catch {
    return "download";
  }
}

function extOf(url: string): string {
  const n = fileNameOf(url);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
}

/** "Download all links" from the browser's right-click menu. */
export default function Grabber({ token }: { token: string }) {
  const [cap, setCap] = useState<LinksCapture | null>(null);
  const [type, setType] = useState("All");
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const win = getCurrentWindow();

  useEffect(() => {
    api
      .pending(token)
      .then((p) => {
        if (p.type !== "links") throw new Error("Unexpected request");
        const seen = new Set<string>();
        setCap({ ...p, links: p.links.filter((l) => !seen.has(l.url) && seen.add(l.url)) });
      })
      .catch((e) => setErr(String(e)));
  }, [token]);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const [t, exts] of Object.entries(TYPES)) c[t] = (cap?.links ?? []).filter((l) => exts.length === 0 || exts.includes(extOf(l.url))).length;
    return c;
  }, [cap]);

  const rows = useMemo(() => {
    const exts = TYPES[type]!;
    const q = text.toLowerCase();
    return (cap?.links ?? []).filter(
      (l) => (exts.length === 0 || exts.includes(extOf(l.url))) && (!q || l.url.toLowerCase().includes(q) || l.text.toLowerCase().includes(q)),
    );
  }, [cap, type, text]);

  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.url));
  const toggleAll = () => {
    const n = new Set(checked);
    rows.forEach((r) => (allChecked ? n.delete(r.url) : n.add(r.url)));
    setChecked(n);
  };
  const toggle = (url: string) => {
    const n = new Set(checked);
    n.has(url) ? n.delete(url) : n.add(url);
    setChecked(n);
  };

  const close = async () => {
    await api.closePending(token);
    await win.close();
  };

  const go = async (start: boolean) => {
    if (!cap) return;
    const headers: [string, string][] = [["Referer", cap.pageUrl]];
    if (cap.cookies) headers.push(["Cookie", cap.cookies]);
    if (cap.userAgent) headers.push(["User-Agent", cap.userAgent]);
    try {
      const items: NewDownload[] = [];
      for (const url of checked) {
        const fileName = fileNameOf(url);
        const p = await api.placement(fileName);
        items.push({ url, pageUrl: cap.pageUrl, fileName, destDir: p.destDir, category: p.category, headers, kind: "http", queueId: start ? null : MAIN_QUEUE });
      }
      await api.addMany(items, start);
      await close();
    } catch (e) {
      setErr(String(e));
    }
  };

  let host = "";
  try {
    host = cap ? new URL(cap.pageUrl).hostname : "";
  } catch {
    /* ignore */
  }

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <span className="size-10 rounded-xl bg-accent-soft text-accent grid place-items-center"><Link2 size={20} /></span>
          <div>
            <div className="text-[16px] font-semibold font-[family-name:var(--font-display)]">Choose what to download</div>
            <div className="text-muted text-[12.5px]">{cap?.links.length ?? 0} links found{host && ` on ${host}`}</div>
          </div>
        </div>
        <div className="flex gap-2 items-center mt-4">
          <div className="flex gap-1.5 flex-wrap">
            {Object.keys(TYPES).map((t) => (
              <button
                key={t}
                aria-pressed={type === t}
                onClick={() => setType(t)}
                disabled={counts[t] === 0}
                className={`h-8 px-3 rounded-full border text-[12.5px] cursor-pointer disabled:opacity-40 disabled:cursor-default transition-colors ${
                  type === t ? "border-accent bg-accent-soft text-accent font-medium" : "border-line hover:bg-hover"
                }`}
              >
                {t} <span className="text-faint">{counts[t]}</span>
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface-2 focus-within:border-accent w-48">
            <Search size={14} className="text-faint" />
            <input placeholder="Filter" aria-label="Filter links" value={text} onChange={(e) => setText(e.target.value)} className="flex-1 min-w-0 bg-transparent outline-none text-[13px]" />
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto mx-6 border border-line rounded-xl">
        <label className="sticky top-0 z-10 flex items-center gap-3 px-3 h-10 bg-surface-2 border-b border-line cursor-pointer text-[12.5px] text-muted">
          <input type="checkbox" checked={allChecked} onChange={toggleAll} className="accent-[var(--color-accent)] size-4" />
          Select all {rows.length} shown
        </label>
        {rows.map((l) => (
          <label key={l.url} className={`flex items-center gap-3 px-3 h-12 border-b border-line last:border-0 cursor-pointer ${checked.has(l.url) ? "bg-selected" : "hover:bg-hover"}`}>
            <input type="checkbox" checked={checked.has(l.url)} onChange={() => toggle(l.url)} className="accent-[var(--color-accent)] size-4" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{fileNameOf(l.url)}</div>
              <div className="truncate text-[12px] text-muted" title={l.url}>{l.text ? `${l.text} · ` : ""}{l.url}</div>
            </div>
          </label>
        ))}
        {rows.length === 0 && <div className="text-center text-muted py-10">No links of this type.</div>}
      </div>
      <div className="flex items-center gap-2 px-6 py-4">
        <span className="text-muted">{checked.size} selected</span>
        {err && <span className="text-danger truncate">{err}</span>}
        <div className="ml-auto flex gap-2">
          <Button variant="ghost" onClick={close}>Cancel</Button>
          <Button icon={Clock} disabled={checked.size === 0} onClick={() => go(false)}>Later</Button>
          <Button variant="primary" icon={Download} disabled={checked.size === 0} onClick={() => go(true)}>Download {checked.size || ""}</Button>
        </div>
      </div>
    </div>
  );
}

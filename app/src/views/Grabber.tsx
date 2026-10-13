import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, LinksCapture, MAIN_QUEUE, NewDownload } from "../api";
import { Button, TextInput } from "../components/ui";

const TYPES: Record<string, string[]> = {
  All: [],
  Video: ["mp4", "mkv", "webm", "avi", "mov", "m4v", "flv", "wmv", "ts"],
  Audio: ["mp3", "m4a", "flac", "wav", "ogg", "opus", "aac"],
  Archives: ["zip", "rar", "7z", "gz", "tar", "xz", "bz2", "iso"],
  Documents: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub", "txt"],
  Programs: ["exe", "msi", "apk", "dmg", "deb", "rpm"],
  Images: ["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"],
};

function fileNameOf(url: string): string {
  try {
    const n = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return n || "download";
  } catch {
    return "download";
  }
}

function extOf(url: string): string {
  const n = fileNameOf(url);
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i + 1).toLowerCase() : "";
}

/** "Download all links" from the page context menu. */
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
        // Same URL linked twice → one row.
        const seen = new Set<string>();
        setCap({ ...p, links: p.links.filter((l) => !seen.has(l.url) && seen.add(l.url)) });
      })
      .catch((e) => setErr(String(e)));
  }, [token]);

  const rows = useMemo(() => {
    const exts = TYPES[type];
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

  return (
    <div className="h-full flex flex-col p-3 gap-2 bg-surface">
      <div className="flex gap-2 items-center">
        <div className="flex gap-1">
          {Object.keys(TYPES).map((t) => (
            <button
              key={t}
              aria-pressed={type === t}
              onClick={() => setType(t)}
              className={`h-7 px-2.5 rounded border cursor-pointer ${type === t ? "bg-accent text-on-accent border-accent" : "border-line hover:bg-hover"}`}
            >
              {t}
            </button>
          ))}
        </div>
        <TextInput className="ml-auto w-56" placeholder="Filter" aria-label="Filter links" value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div className="flex-1 overflow-auto border border-line rounded-md">
        <table className="w-full table-fixed text-[12px]">
          <thead className="sticky top-0 bg-surface">
            <tr className="h-8 text-muted text-left">
              <th className="w-8 px-2 font-normal">
                <input type="checkbox" aria-label="Select all" checked={allChecked} onChange={toggleAll} className="accent-[var(--color-accent)]" />
              </th>
              <th className="w-[30%] px-2 font-normal">File</th>
              <th className="w-[25%] px-2 font-normal">Link text</th>
              <th className="px-2 font-normal">Address</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => (
              <tr key={l.url} className="h-7 odd:bg-surface-2 hover:bg-hover cursor-pointer" onClick={() => {
                const n = new Set(checked);
                n.has(l.url) ? n.delete(l.url) : n.add(l.url);
                setChecked(n);
              }}>
                <td className="px-2"><input type="checkbox" readOnly checked={checked.has(l.url)} className="accent-[var(--color-accent)]" aria-label={`Select ${fileNameOf(l.url)}`} /></td>
                <td className="px-2 truncate">{fileNameOf(l.url)}</td>
                <td className="px-2 truncate text-muted">{l.text}</td>
                <td className="px-2 truncate text-muted" title={l.url}>{l.url}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted">{checked.size} selected of {cap?.links.length ?? 0} links</span>
        {err && <span className="text-danger truncate">{err}</span>}
        <div className="ml-auto flex gap-2">
          <Button disabled={checked.size === 0} onClick={() => go(false)}>Add to queue</Button>
          <Button primary disabled={checked.size === 0} onClick={() => go(true)}>Download now</Button>
          <Button onClick={close}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

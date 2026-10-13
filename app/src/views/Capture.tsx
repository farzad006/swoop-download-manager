import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Clock, Download, Loader2, RotateCcw, TriangleAlert } from "lucide-react";
import { api, DownloadCapture, fmtBytes, joinPath, MAIN_QUEUE, splitExt } from "../api";
import { CATEGORIES, FileTile } from "../categories";
import { Badge, Button, Field, FolderInput, TextInput } from "../components/ui";

/** Shown when a download is caught (browser, clipboard or pasted link). */
export default function Capture({ token }: { token: string }) {
  const [cap, setCap] = useState<DownloadCapture | null>(null);
  const [fileName, setFileName] = useState("");
  const [destDir, setDestDir] = useState("");
  const [category, setCategory] = useState("General");
  const [size, setSize] = useState<number | null>(null);
  const [resumable, setResumable] = useState(false);
  const [probing, setProbing] = useState(true);
  const [warning, setWarning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const win = getCurrentWindow();

  const headers = (c: DownloadCapture): [string, string][] => {
    const h: [string, string][] = [];
    if (c.cookies) h.push(["Cookie", c.cookies]);
    const ref = c.referrer || c.pageUrl;
    if (ref) h.push(["Referer", ref]);
    if (c.userAgent) h.push(["User-Agent", c.userAgent]);
    return h;
  };

  const place = async (name: string) => {
    const p = await api.placement(name);
    setCategory(p.category);
    setDestDir(p.destDir);
  };

  useEffect(() => {
    (async () => {
      try {
        const p = await api.pending(token);
        if (p.type !== "download") throw new Error("Unexpected request");
        setCap(p);
        if (p.fileName) {
          setFileName(p.fileName);
          await place(p.fileName);
        }
        if (p.fileSize) setSize(p.fileSize);
        try {
          const r = await api.probe(p.url, headers(p));
          if (!p.fileName) {
            setFileName(r.fileName);
            setCategory(r.category);
            setDestDir(r.destDir);
          }
          setSize(r.size ?? p.fileSize ?? null);
          setResumable(r.resumable);
        } catch {
          setWarning("Couldn't reach the website to check the file. You can still try downloading it.");
          if (!p.fileName) {
            const guess = decodeURIComponent(new URL(p.url).pathname.split("/").pop() || "download");
            setFileName(guess);
            await place(guess);
          }
        }
      } catch (e) {
        setWarning(String(e));
      } finally {
        setProbing(false);
      }
    })();
  }, [token]);

  const close = async () => {
    await api.closePending(token);
    await win.close();
  };

  const submit = async (start: boolean) => {
    if (!cap) return;
    setBusy(true);
    try {
      await api.add(
        {
          url: cap.url,
          pageUrl: cap.pageUrl ?? cap.referrer ?? null,
          fileName,
          destDir,
          category,
          size,
          headers: headers(cap),
          kind: "http",
          queueId: start ? null : MAIN_QUEUE,
          resumable,
        },
        start,
      );
      await close();
    } catch (e) {
      setWarning(String(e));
      setBusy(false);
    }
  };

  const changeCategory = async (cat: string) => {
    setCategory(cat);
    const s = await api.settings();
    setDestDir(s.useCategoryFolders && cat !== "General" ? joinPath(s.downloadRoot, cat) : s.downloadRoot);
  };

  const [, ext] = splitExt(fileName);
  let host = "";
  try {
    host = cap ? new URL(cap.url).hostname : "";
  } catch {
    /* ignore */
  }

  return (
    <div className="h-full flex flex-col bg-surface" onKeyDown={(e) => e.key === "Escape" && close()}>
      <div className="flex items-center gap-4 px-6 pt-5 pb-4">
        <FileTile categoryKey={category} size={48} />
        <div className="flex-1 min-w-0">
          <div className="text-[15.5px] font-semibold truncate font-[family-name:var(--font-display)]" title={fileName}>
            {probing && !fileName ? "Getting file details…" : fileName || "Download"}
          </div>
          <div className="flex items-center gap-2 mt-1 text-[12.5px] text-muted">
            {probing ? (
              <span className="flex items-center gap-1.5"><Loader2 size={13} className="animate-spin" /> Checking the file…</span>
            ) : (
              <>
                <span className="font-medium text-fg">{size != null ? fmtBytes(size) : "Size unknown"}</span>
                {host && <span className="truncate">from {host}</span>}
                {resumable ? <Badge tone="ok" icon={RotateCcw}>Can pause & resume</Badge> : <Badge tone="warn">Can't resume</Badge>}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-6 space-y-4">
        <Field label="File name">
          <TextInput className="w-full" value={fileName} onChange={(e) => setFileName(e.target.value)} aria-label="File name" />
        </Field>
        <Field label="Save to">
          <FolderInput value={destDir} onChange={setDestDir} />
        </Field>
        <div>
          <span className="block text-[12.5px] font-medium text-muted mb-1.5">Type</span>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="File type">
            {CATEGORIES.map((c) => (
              <button
                key={c.key}
                role="radio"
                aria-checked={category === c.key}
                onClick={() => changeCategory(c.key)}
                className={`h-8 px-3 rounded-full border text-[12.5px] flex items-center gap-1.5 cursor-pointer transition-colors ${
                  category === c.key ? "border-accent bg-accent-soft text-accent font-medium" : "border-line hover:bg-hover"
                }`}
              >
                <c.icon size={14} /> {c.label}
              </button>
            ))}
          </div>
        </div>
        {warning && (
          <div className="flex gap-2 items-start p-3 rounded-lg bg-warn-soft text-[12.5px]">
            <TriangleAlert size={15} className="text-warn shrink-0 mt-0.5" />
            <span>{warning}</span>
          </div>
        )}
        {ext === "" && !probing && <div className="text-[12px] text-faint">Tip: add a file extension (like .zip) so Windows knows how to open it.</div>}
      </div>

      <div className="flex items-center gap-2 px-6 py-4 border-t border-line bg-surface-2 mt-3">
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <div className="ml-auto flex gap-2">
          <Button icon={Clock} onClick={() => submit(false)} disabled={!cap || !fileName || busy} title="Adds it to the queue to download later">
            Later
          </Button>
          <Button variant="primary" icon={Download} autoFocus onClick={() => submit(true)} disabled={!cap || !fileName || busy}>
            Download now
          </Button>
        </div>
      </div>
    </div>
  );
}

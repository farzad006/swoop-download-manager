import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, DownloadCapture, fmtBytes, joinPath, MAIN_QUEUE } from "../api";
import { Button, Field, FolderInput, TextInput } from "../components/ui";

const CATEGORIES = ["General", "Compressed", "Documents", "Music", "Programs", "Video"];

/** IDM's "Download File Info" dialog for a captured or pasted link. */
export default function Capture({ token }: { token: string }) {
  const [cap, setCap] = useState<DownloadCapture | null>(null);
  const [fileName, setFileName] = useState("");
  const [destDir, setDestDir] = useState("");
  const [category, setCategory] = useState("General");
  const [description, setDescription] = useState("");
  const [size, setSize] = useState<number | null>(null);
  const [resumable, setResumable] = useState(false);
  const [probing, setProbing] = useState(true);
  const [err, setErr] = useState<string | null>(null);
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
        } catch (e) {
          setErr(`Couldn't contact the server: ${e}`);
          if (!p.fileName) {
            const guess = decodeURIComponent(new URL(p.url).pathname.split("/").pop() || "download");
            setFileName(guess);
            await place(guess);
          }
        }
      } catch (e) {
        setErr(String(e));
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
          description,
          resumable,
        },
        start,
      );
      await close();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <div className="h-full flex flex-col p-4 gap-2.5 bg-surface" onKeyDown={(e) => e.key === "Escape" && close()}>
      <Field label="URL">
        <TextInput className="w-full" readOnly value={cap?.url ?? ""} />
      </Field>
      <Field label="Category">
        <select
          className="h-8 px-2 rounded-md border border-line bg-surface"
          value={category}
          onChange={async (e) => {
            const cat = e.target.value;
            setCategory(cat);
            const s = await api.settings();
            setDestDir(s.useCategoryFolders && cat !== "General" ? joinPath(s.downloadRoot, cat) : s.downloadRoot);
          }}
        >
          {CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Save to">
        <FolderInput value={destDir} onChange={setDestDir} />
      </Field>
      <Field label="File name">
        <TextInput className="w-full" value={fileName} onChange={(e) => setFileName(e.target.value)} />
      </Field>
      <Field label="Description">
        <TextInput className="w-full" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="text-[12px] text-muted pl-[128px]">
        {probing ? "Getting file information…" : `${size != null ? fmtBytes(size) : "Unknown size"}${resumable ? " · resumable" : " · resume not supported"}`}
        {err && <div className="text-danger">{err}</div>}
      </div>
      <div className="mt-auto flex justify-end gap-2">
        <Button onClick={() => submit(false)} disabled={!cap || !fileName}>Download later</Button>
        <Button primary autoFocus onClick={() => submit(true)} disabled={!cap || !fileName}>Start download</Button>
        <Button onClick={close}>Cancel</Button>
      </div>
    </div>
  );
}

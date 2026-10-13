import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Loader2, ShieldAlert } from "lucide-react";
import { api, fmtBytes, MAIN_QUEUE, VideoInfoResult } from "../api";
import { Button, Field, FolderInput, TextInput } from "../components/ui";

function safeName(s: string) {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "video";
}

/** Quality picker for the "Download this video" button. */
export default function Video({ token }: { token: string }) {
  const [res, setRes] = useState<VideoInfoResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [choice, setChoice] = useState("best");
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const win = getCurrentWindow();

  useEffect(() => {
    api
      .videoInfo(token)
      .then(async (r) => {
        setRes(r);
        const title = r.info?.title ?? r.title ?? "video";
        setName(safeName(title));
        setDir((await api.placement("x.mp4")).destDir);
      })
      .catch((e) => setLoadErr(String(e)));
  }, [token]);

  const ext = choice === "audio" ? ".mp3" : ".mp4";
  useEffect(() => {
    api.placement(`x${ext}`).then((p) => setDir(p.destDir));
  }, [ext]);

  const directFiles = useMemo(() => (res?.streams ?? []).filter((s) => s.kind === "file"), [res]);
  const drm = res?.error?.includes("DRM");

  const close = async () => {
    await api.closePending(token);
    await win.close();
  };

  const add = async (start: boolean) => {
    if (!res?.sourceUrl) return;
    setBusy(true);
    try {
      await api.addVideo({ token, sourceUrl: res.sourceUrl, choice, fileName: name + ext, destDir: dir, start, queueId: start ? null : MAIN_QUEUE });
      await close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const addDirect = async (url: string) => {
    const fromUrl = decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    const fileName = fromUrl.includes(".") ? fromUrl : `${name || "video"}.mp4`;
    try {
      const p = await api.placement(fileName);
      await api.addStreamDirect({ token, url, fileName, destDir: p.destDir, start: true });
      await close();
    } catch (e) {
      setErr(String(e));
    }
  };

  if (!res && !loadErr) {
    return (
      <div className="h-full grid place-items-center bg-surface text-muted">
        <div className="flex items-center gap-2">
          <Loader2 className="animate-spin" size={18} /> Reading video information…
        </div>
      </div>
    );
  }

  const info = res?.info;
  return (
    <div className="h-full flex flex-col p-4 gap-3 bg-surface" onKeyDown={(e) => e.key === "Escape" && close()}>
      {info ? (
        <>
          <div className="flex gap-3">
            {info.thumbnail && <img src={info.thumbnail} alt="" className="w-40 h-[90px] object-cover rounded border border-line shrink-0" />}
            <div className="min-w-0">
              <div className="font-semibold text-[14px] line-clamp-2">{info.title}</div>
              <div className="text-muted text-[12px] mt-1">
                {info.extractor}
                {info.duration ? ` · ${Math.floor(info.duration / 60)}:${String(Math.round(info.duration % 60)).padStart(2, "0")}` : ""}
                {info.isLive ? " · live (records until stopped)" : ""}
              </div>
            </div>
          </div>
          <div className="border border-line rounded-md overflow-auto max-h-[210px]" role="radiogroup" aria-label="Quality">
            {info.choices.map((c) => (
              <label key={c.id} className={`flex items-center gap-2 h-8 px-3 cursor-pointer ${choice === c.id ? "bg-selected" : "hover:bg-hover"}`}>
                <input type="radio" name="q" className="accent-[var(--color-accent)]" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                <span className="flex-1">{c.label}</span>
                <span className="text-muted">{c.size ? `~${fmtBytes(c.size)}` : ""}</span>
              </label>
            ))}
          </div>
          <Field label="File name">
            <div className="flex items-center gap-1">
              <TextInput className="flex-1 min-w-0" value={name} onChange={(e) => setName(e.target.value)} />
              <span className="text-muted w-10">{ext}</span>
            </div>
          </Field>
          <Field label="Save to">
            <FolderInput value={dir} onChange={setDir} />
          </Field>
        </>
      ) : (
        <div className="space-y-2">
          <div className={`flex gap-2 items-start ${drm ? "text-danger" : ""}`}>
            {drm && <ShieldAlert size={18} className="shrink-0 mt-0.5" />}
            <div>{loadErr ?? res?.error ?? "No downloadable video found on this page."}</div>
          </div>
          {!drm && directFiles.length > 0 && (
            <div>
              <div className="text-muted mb-1">Media files detected on the page:</div>
              <div className="border border-line rounded-md max-h-[260px] overflow-auto">
                {directFiles.map((s) => (
                  <div key={s.url} className="flex items-center gap-2 h-8 px-2 odd:bg-surface-2">
                    <span className="flex-1 truncate text-[12px]" title={s.url}>{s.url}</span>
                    <span className="text-muted text-[12px]">{fmtBytes(s.size ?? null)}</span>
                    <Button className="h-7 px-2" onClick={() => addDirect(s.url)}>Download</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {err && <div className="text-danger">{err}</div>}
      <div className="mt-auto flex justify-end gap-2">
        {info && <Button onClick={() => add(false)} disabled={busy || !name}>Download later</Button>}
        {info && <Button primary autoFocus onClick={() => add(true)} disabled={busy || !name}>Download</Button>}
        <Button onClick={close}>{info ? "Cancel" : "Close"}</Button>
      </div>
    </div>
  );
}

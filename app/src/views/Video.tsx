import { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Clock, Download, Film, Loader2, Music, ShieldAlert } from "lucide-react";
import { api, fmtBytes, MAIN_QUEUE, MediaStream, VideoChoice, VideoInfoResult } from "../api";
import { Badge, Button, Check, Field, FolderInput, TextInput } from "../components/ui";

function safeName(s: string) {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "video";
}

function qualityName(c: VideoChoice): { title: string; sub: string } {
  if (c.id === "audio") return { title: "Audio only", sub: "MP3, for music and podcasts" };
  if (c.id === "best") return { title: "Best available", sub: c.height ? `${c.height}p, the highest the site offers` : "Highest the site offers" };
  const h = c.height ?? 0;
  if (h >= 2160) return { title: "4K Ultra HD", sub: `${h}p` };
  if (h >= 1440) return { title: "2K Quad HD", sub: `${h}p` };
  if (h >= 1080) return { title: "Full HD", sub: `${h}p` };
  if (h >= 720) return { title: "HD", sub: `${h}p` };
  if (h >= 480) return { title: "Standard", sub: `${h}p` };
  return { title: "Small", sub: `${h}p, smallest file` };
}

function fileNameOf(url: string) {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").pop() || url);
  } catch {
    return url;
  }
}

/** Whole video files from the page, without the short hover previews many
 *  video sites play (they're small); the one the clicked player shows comes first. */
export function likelyVideos(streams: MediaStream[]): MediaStream[] {
  return streams.filter((s) => s.kind === "file" && (s.size == null || s.size >= 2_000_000)).slice(0, 3);
}

/** Quality picker for "Download this video". */
export default function Video({ token }: { token: string }) {
  const [res, setRes] = useState<VideoInfoResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const win = getCurrentWindow();

  // Files the browser already loaded while playing (the playing one first),
  // offered straight away while yt-dlp looks for every quality.
  const [playing, setPlaying] = useState<MediaStream[]>([]);
  const [pageTitle, setPageTitle] = useState("");
  useEffect(() => {
    api
      .pending(token)
      .then((p) => {
        if (p.type !== "video") return;
        setPlaying(likelyVideos(p.streams));
        setPageTitle(p.title ?? "");
      })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    api
      .videoInfo(token)
      .then((r) => {
        setRes(r);
        setName(safeName(r.info?.title ?? r.title ?? "video"));
      })
      .catch((e) => setLoadErr(String(e)));
  }, [token]);

  // Full HD is the sweet spot: sharp on most screens, sensible size.
  const recommended = useMemo(() => {
    const cs = res?.info?.choices ?? [];
    return cs.find((c) => c.id === "h1080")?.id ?? cs.find((c) => c.id.startsWith("h"))?.id ?? cs[0]?.id ?? "best";
  }, [res]);
  const picked = choice ?? recommended;
  const ext = picked === "audio" ? ".mp3" : ".mp4";
  useEffect(() => {
    api.placement(`x${ext}`).then((p) => setDir(p.destDir));
  }, [ext]);

  // Short hover previews (a few hundred KB) are left out, as above.
  const directFiles = likelyVideos(res?.streams ?? []);
  const drm = res?.error?.includes("DRM");

  const close = async () => {
    await api.closePending(token);
    await win.close();
  };

  const add = async (start: boolean) => {
    if (!res?.sourceUrl) return;
    setBusy(true);
    try {
      await api.addVideo({ token, sourceUrl: res.sourceUrl, choice: picked, fileName: name + ext, destDir: dir, start, queueId: start ? null : MAIN_QUEUE });
      if (remember) {
        // Next time the video button downloads straight away in this quality.
        const s = await api.settings();
        await api.saveSettings({ ...s, videoClickAction: picked });
      }
      await close();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  };

  const addDirect = async (url: string) => {
    // Named after the video's title when known: links are often just "659700.mp4".
    const fromUrl = fileNameOf(url);
    const urlExt = fromUrl.match(/\.(mp4|webm|mkv|mov|m4v|flv|3gp|ts)$/i)?.[0] ?? ".mp4";
    const title = name || pageTitle;
    const fileName = title ? safeName(title) + urlExt : fromUrl.includes(".") ? fromUrl : "video.mp4";
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
      <div className="h-full flex flex-col bg-surface text-muted">
        <div className="flex-1 grid place-items-center">
          <div className="text-center">
            <Loader2 className="animate-spin mx-auto mb-3 text-accent" size={28} />
            <div className="font-medium text-fg">{playing.length ? "Looking for every quality…" : "Looking at the video…"}</div>
            <div className="text-[12.5px] mt-0.5">This takes a few seconds.</div>
          </div>
        </div>
        {playing.length > 0 && (
          <div className="px-6 pb-5">
            <div className="font-medium text-fg mb-1">Don't want to wait?</div>
            <div className="text-[12.5px] mb-2">Download the video your browser is playing, in the quality it's playing.</div>
            <div className="border border-line rounded-xl divide-y divide-line">
              {playing.map((s, i) => (
                <div key={s.url} className="flex items-center gap-2 h-11 px-3">
                  <Film size={15} className="text-rose-500 shrink-0" />
                  <span className="flex-1 truncate text-[12.5px] text-fg" title={s.url}>{fileNameOf(s.url)}</span>
                  {i === 0 && playing.length > 1 && <Badge tone="accent">Playing</Badge>}
                  <span className="text-[12px]">{fmtBytes(s.size ?? null)}</span>
                  <Button size="sm" variant={i === 0 ? "primary" : undefined} icon={Download} onClick={() => addDirect(s.url)}>Download</Button>
                </div>
              ))}
            </div>
            {err && <div className="text-danger pt-2">{err}</div>}
          </div>
        )}
      </div>
    );
  }

  const info = res?.info;
  return (
    <div className="h-full flex flex-col bg-surface" onKeyDown={(e) => e.key === "Escape" && close()}>
      {info ? (
        <>
          <div className="flex gap-4 px-6 pt-5 pb-4">
            {info.thumbnail ? (
              <img src={info.thumbnail} alt="" className="w-[150px] h-[84px] object-cover rounded-xl border border-line shrink-0" />
            ) : (
              <span className="w-[150px] h-[84px] rounded-xl bg-rose-500/12 text-rose-500 grid place-items-center shrink-0"><Film size={30} /></span>
            )}
            <div className="min-w-0">
              <div className="font-semibold text-[15px] line-clamp-2 font-[family-name:var(--font-display)]">{info.title}</div>
              <div className="text-muted text-[12.5px] mt-1 flex items-center gap-2 flex-wrap">
                {info.extractor && <span>{info.extractor}</span>}
                {info.duration ? <span>· {Math.floor(info.duration / 60)}:{String(Math.round(info.duration % 60)).padStart(2, "0")}</span> : null}
                {info.isLive && <Badge tone="danger">Live, records until stopped</Badge>}
              </div>
            </div>
          </div>
          <div className="flex-1 overflow-auto px-6 space-y-4">
            <div>
              <span className="block text-[12.5px] font-medium text-muted mb-1.5">Quality</span>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Quality">
                {info.choices.filter((c) => c.id !== "best" || info.choices.length <= 2).map((c) => {
                  const q = qualityName(c);
                  const on = picked === c.id;
                  return (
                    <button
                      key={c.id}
                      role="radio"
                      aria-checked={on}
                      onClick={() => setChoice(c.id)}
                      className={`text-left p-3 rounded-xl border transition-colors cursor-pointer ${on ? "border-accent bg-accent-soft ring-1 ring-accent" : "border-line hover:bg-hover"}`}
                    >
                      <div className="flex items-center gap-2">
                        {c.id === "audio" ? <Music size={15} className="text-violet-500" /> : <Film size={15} className="text-rose-500" />}
                        <span className="font-medium">{q.title}</span>
                        {c.id === recommended && <Badge tone="accent">Recommended</Badge>}
                      </div>
                      <div className="text-[12px] text-muted mt-0.5">{q.sub}{c.size ? ` · about ${fmtBytes(c.size)}` : ""}</div>
                    </button>
                  );
                })}
              </div>
            </div>
            <Field label="File name">
              <div className="flex items-center gap-2">
                <TextInput className="flex-1 min-w-0" value={name} onChange={(e) => setName(e.target.value)} aria-label="File name" />
                <span className="text-muted w-10">{ext}</span>
              </div>
            </Field>
            <Field label="Save to">
              <FolderInput value={dir} onChange={setDir} />
            </Field>
            <Check
              checked={remember}
              onChange={setRemember}
              label="Always download in this quality without asking (change it in Settings → Videos)"
            />
          </div>
        </>
      ) : (
        <div className="flex-1 overflow-auto p-6 space-y-4">
          <div className={`flex gap-3 items-start p-4 rounded-xl ${drm ? "bg-danger-soft" : "bg-warn-soft"}`}>
            <ShieldAlert size={20} className={`${drm ? "text-danger" : "text-warn"} shrink-0`} />
            <div>
              <div className="font-medium">{drm ? "This video is copy-protected" : "Swoop couldn't read this video"}</div>
              <div className="text-muted text-[12.5px] mt-0.5">{drm ? "Streaming services like Netflix and Disney+ lock their videos (DRM), so they can't be saved." : loadErr ?? res?.error ?? "No downloadable video was found on this page."}</div>
            </div>
          </div>
          {!drm && directFiles.length > 0 && (
            <div>
              <div className="font-medium mb-2">Video files found on the page</div>
              <div className="border border-line rounded-xl divide-y divide-line">
                {directFiles.map((s) => (
                  <div key={s.url} className="flex items-center gap-2 h-11 px-3">
                    <span className="flex-1 truncate text-[12.5px]" title={s.url}>{decodeURIComponent(new URL(s.url).pathname.split("/").pop() || s.url)}</span>
                    <span className="text-muted text-[12px]">{fmtBytes(s.size ?? null)}</span>
                    <Button size="sm" icon={Download} onClick={() => addDirect(s.url)}>Download</Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      {err && <div className="text-danger px-6 pt-2">{err}</div>}
      <div className="flex items-center gap-2 px-6 py-4 border-t border-line bg-surface-2 mt-3">
        <Button variant="ghost" onClick={close}>{info ? "Cancel" : "Close"}</Button>
        {info && (
          <div className="ml-auto flex gap-2">
            <Button icon={Clock} onClick={() => add(false)} disabled={busy || !name}>Later</Button>
            <Button variant="primary" icon={Download} autoFocus onClick={() => add(true)} disabled={busy || !name}>Download</Button>
          </div>
        )}
      </div>
    </div>
  );
}

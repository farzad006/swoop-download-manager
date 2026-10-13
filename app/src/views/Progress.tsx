import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AlertCircle, CheckCircle2, ChevronDown, ExternalLink, FolderOpen, Pause, Play, Wrench } from "lucide-react";
import { api, describeError, Download, fmtBytes, fmtEtaFriendly, fmtSpeed, joinPath, percent, Progress as P } from "../api";
import { FileTile } from "../categories";
import { Button, ProgressBar, SegmentBar } from "../components/ui";

/** Per-download window: big progress, speed, time left; becomes "Download complete". */
export default function Progress({ id }: { id: number }) {
  const [d, setD] = useState<Download | null>(null);
  const [p, setP] = useState<P | null>(null);
  const [details, setDetails] = useState(false);
  const [showComplete, setShowComplete] = useState(true);
  const win = getCurrentWindow();

  useEffect(() => {
    api.get(id).then(setD);
    api.settings().then((s) => setShowComplete(s.showCompleteDialog));
    const un = [
      listen<P>("progress", (e) => e.payload.id === id && setP(e.payload)),
      listen<Download>("download-updated", (e) => e.payload.id === id && setD(e.payload)),
      listen<number>("download-removed", (e) => e.payload === id && win.close()),
    ];
    return () => un.forEach((x) => x.then((f) => f()));
  }, [id, win]);

  const status = p?.status ?? d?.status;
  useEffect(() => {
    if (status === "completed" && !showComplete) win.close();
  }, [status, showComplete, win]);

  const downloaded = p?.downloaded ?? d?.downloaded ?? 0;
  const total = p?.total ?? d?.size ?? null;
  const pc = percent(downloaded, total);
  useEffect(() => {
    if (d) win.setTitle(status === "completed" ? "Download complete" : pc != null ? `${pc.toFixed(0)}% · ${d.fileName}` : d.fileName).catch(() => {});
  }, [d, pc, status, win]);

  if (!d) return null;
  const running = status === "downloading" || status === "probing";

  if (status === "completed") {
    return (
      <div className="h-full flex flex-col bg-surface anim-fade-up">
        <div className="flex-1 flex flex-col items-center justify-center text-center px-8">
          <div className="size-16 rounded-full bg-ok-soft text-ok grid place-items-center mb-4">
            <CheckCircle2 size={34} />
          </div>
          <div className="text-[18px] font-semibold font-[family-name:var(--font-display)]">Download complete</div>
          <div className="mt-1 font-medium truncate max-w-full" title={d.fileName}>{d.fileName}</div>
          <div className="text-muted text-[12.5px] mt-0.5 truncate max-w-full" title={joinPath(d.destDir, d.fileName)}>
            {fmtBytes(d.size)} · {d.destDir}
          </div>
        </div>
        <div className="flex gap-2 px-6 py-4 border-t border-line bg-surface-2">
          <Button variant="ghost" onClick={() => win.close()}>Close</Button>
          <div className="ml-auto flex gap-2">
            <Button icon={FolderOpen} onClick={() => api.openFolder(id)}>Show in folder</Button>
            <Button variant="primary" icon={ExternalLink} autoFocus onClick={() => api.openFile(id).then(() => win.close())}>Open</Button>
          </div>
        </div>
      </div>
    );
  }

  const err = status === "failed" ? describeError(p?.error ?? d.error) : null;
  const headline =
    status === "failed"
      ? err!.text
      : status === "probing"
        ? "Connecting…"
        : p?.phase
          ? "Finishing up (joining audio and video)…"
          : running
            ? fmtEtaFriendly(p?.etaSecs) || "Downloading…"
            : status === "queued"
              ? "Waiting in the queue"
              : "Paused";

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="flex items-center gap-3.5 px-6 pt-5">
        <FileTile categoryKey={d.category} size={44} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold truncate" title={d.fileName}>{d.fileName}</div>
          <div className="text-muted text-[12.5px] truncate" title={d.url}>{new URL(d.url).hostname}</div>
        </div>
      </div>

      <div className="px-6 pt-5">
        <div className="flex items-end justify-between mb-2">
          <div className={`text-[15px] font-medium ${status === "failed" ? "text-danger" : ""}`}>
            {status === "failed" && <AlertCircle size={16} className="inline -mt-0.5 mr-1.5" />}
            {headline}
          </div>
          {pc != null && <div className="text-[26px] font-semibold tabular-nums leading-none font-[family-name:var(--font-display)]">{pc.toFixed(0)}<span className="text-[15px] text-muted">%</span></div>}
        </div>
        <ProgressBar value={status === "probing" ? null : pc} height={10} tone={status === "failed" ? "danger" : running ? "accent" : "warn"} animated={running && pc != null} />
        <div className="grid grid-cols-3 gap-3 mt-4">
          <Stat label="Downloaded" value={`${fmtBytes(downloaded) || "0 B"}${total ? ` of ${fmtBytes(total)}` : ""}`} />
          <Stat label="Speed" value={running ? fmtSpeed(p?.speed ?? 0) || "—" : "—"} />
          <Stat label="Can resume" value={d.kind === "video" || d.resumable ? "Yes" : "No"} />
        </div>
      </div>

      {d.kind === "http" && (
        <div className="px-6 pt-3 min-h-0 flex-1 flex flex-col">
          <button className="flex items-center gap-1 text-muted hover:text-fg text-[12.5px] cursor-pointer self-start" onClick={() => setDetails(!details)} aria-expanded={details}>
            <ChevronDown size={14} className={`transition-transform ${details ? "rotate-180" : ""}`} />
            {details ? "Hide connections" : `Show connections (${p?.connections ?? 0} active)`}
          </button>
          {details && (
            <div className="mt-2 space-y-2 min-h-0 flex flex-col anim-fade-up">
              <SegmentBar segments={p?.segments ?? []} total={total} />
              <div className="min-h-0 max-h-[92px] overflow-auto rounded-lg border border-line text-[12px]">
                {(p?.segments ?? []).map((s, i) => (
                  <div key={i} className="flex gap-3 px-3 h-7 items-center odd:bg-surface-2">
                    <span className="text-faint w-5">{i + 1}</span>
                    <span className="tabular-nums flex-1">{fmtBytes(s.pos - s.start)} of {fmtBytes(s.end - s.start)}</span>
                    <span className="text-muted">{s.pos >= s.end ? "Done" : running ? "Receiving" : "Waiting"}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-auto flex gap-2 px-6 py-4 border-t border-line bg-surface-2">
        <Button
          variant="ghost"
          onClick={() => {
            if (running) api.pause(id);
            win.close();
          }}
        >
          {running ? "Stop and close" : "Close"}
        </Button>
        <div className="ml-auto">
          {running ? (
            <Button variant="primary" icon={Pause} onClick={() => api.pause(id)}>Pause</Button>
          ) : err?.action === "fix-link" ? (
            <Button variant="primary" icon={Wrench} onClick={() => api.showMain().then(() => win.close())}>Fix in OurIDM</Button>
          ) : (
            <Button variant="primary" icon={Play} onClick={() => api.start(id)}>{status === "failed" ? "Try again" : "Resume"}</Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-surface-2 border border-line px-3 py-2">
      <div className="text-[11.5px] text-faint">{label}</div>
      <div className="font-medium tabular-nums truncate">{value}</div>
    </div>
  );
}

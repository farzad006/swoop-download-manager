import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2 } from "lucide-react";
import { api, Download, fmtBytes, fmtEta, fmtSpeed, joinPath, percent, Progress as P } from "../api";
import { Button, ProgressBar, SegmentBar } from "../components/ui";

export default function Progress({ id }: { id: number }) {
  const [d, setD] = useState<Download | null>(null);
  const [p, setP] = useState<P | null>(null);
  const [details, setDetails] = useState(true);
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

  if (!d) return null;
  const downloaded = p?.downloaded ?? d.downloaded;
  const total = p?.total ?? d.size;
  const pc = percent(downloaded, total);
  const running = status === "downloading" || status === "probing";

  if (status === "completed") {
    return (
      <div className="h-full flex flex-col p-5 gap-3 bg-surface">
        <div className="flex items-center gap-2 text-[15px] font-semibold">
          <CheckCircle2 className="text-ok" size={22} /> Download complete
        </div>
        <Info label="File" value={d.fileName} />
        <Info label="Size" value={fmtBytes(d.size)} />
        <Info label="Saved to" value={joinPath(d.destDir, d.fileName)} />
        <Info label="Address" value={d.url} />
        <div className="mt-auto flex justify-end gap-2">
          <Button onClick={() => api.openFolder(id)}>Open folder</Button>
          <Button primary autoFocus onClick={() => api.openFile(id).then(() => win.close())}>Open</Button>
          <Button onClick={() => win.close()}>Close</Button>
        </div>
      </div>
    );
  }

  const title = pc != null ? `${pc.toFixed(0)}% ${d.fileName}` : d.fileName;
  win.setTitle(title).catch(() => {});

  return (
    <div className="h-full flex flex-col p-4 gap-2 bg-surface">
      <Info label="Address" value={d.url} />
      <Info
        label="Status"
        value={
          status === "failed"
            ? p?.error ?? d.error ?? "Error"
            : status === "probing"
              ? "Connecting…"
              : p?.phase ?? (running ? "Receiving data…" : status === "queued" ? "Queued" : "Stopped")
        }
        danger={status === "failed"}
      />
      <Info label="File size" value={fmtBytes(total) || "Unknown"} />
      <Info label="Downloaded" value={`${fmtBytes(downloaded)}${pc != null ? ` (${pc.toFixed(2)}%)` : ""}`} />
      <Info label="Transfer rate" value={running ? fmtSpeed(p?.speed ?? 0) : ""} />
      <Info label="Time left" value={running ? fmtEta(p?.etaSecs) : ""} />
      <Info label="Resume capability" value={d.kind === "video" ? "Yes" : d.resumable ? "Yes" : "No"} />
      <ProgressBar value={pc} />

      {details && d.kind === "http" && (
        <div className="mt-1 space-y-1.5">
          <SegmentBar segments={p?.segments ?? []} total={total} />
          <div className="text-[12px] text-muted">
            {p?.connections ?? 0} active connection{p?.connections === 1 ? "" : "s"} · {p?.segments.length ?? 0} segments
          </div>
          <div className="max-h-[96px] overflow-auto border border-line rounded">
            <table className="w-full text-[12px]">
              <tbody>
                {(p?.segments ?? []).map((s, i) => (
                  <tr key={i} className="odd:bg-surface-2">
                    <td className="px-2 w-8 text-muted">{i + 1}</td>
                    <td className="px-2">{fmtBytes(s.pos - s.start)} / {fmtBytes(s.end - s.start)}</td>
                    <td className="px-2 text-muted">{s.pos >= s.end ? "Done" : running ? "Receiving data…" : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="mt-auto flex justify-end gap-2 pt-2">
        {d.kind === "http" && <Button onClick={() => setDetails(!details)}>{details ? "<< Hide details" : "Show details >>"}</Button>}
        {running ? (
          <Button primary onClick={() => api.pause(id)}>Pause</Button>
        ) : (
          <Button primary onClick={() => api.start(id)}>Resume</Button>
        )}
        <Button
          onClick={() => {
            api.pause(id);
            win.close();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function Info({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2">
      <span className="text-muted">{label}</span>
      <span className={`truncate select-text ${danger ? "text-danger" : ""}`} title={value}>{value}</span>
    </div>
  );
}

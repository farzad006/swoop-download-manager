import { useEffect, useState } from "react";
import { api, Settings, ToolStatus } from "../api";
import { Button, Check, Field, FolderInput, Modal, TextInput } from "../components/ui";

const TABS = ["General", "File types", "Save to", "Connection", "Video", "Browsers"] as const;
type Tab = (typeof TABS)[number];

export function OptionsDialog({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [tab, setTab] = useState<Tab>("General");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.settings().then(setS);
    api.tools().then(setTools);
  }, []);
  if (!s) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  const save = async () => {
    try {
      await api.saveSettings(s);
      onClose();
    } catch (e) {
      setErr(String(e));
    }
  };

  return (
    <Modal
      title="Options"
      width={680}
      onClose={onClose}
      footer={
        <>
          {err && <span className="text-danger mr-auto self-center">{err}</span>}
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={save}>OK</Button>
        </>
      }
    >
      <div className="flex gap-1 border-b border-line mb-3" role="tablist">
        {TABS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`px-3 h-8 -mb-px border-b-2 cursor-pointer ${tab === t ? "border-accent font-medium" : "border-transparent text-muted hover:text-fg"}`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-[300px] space-y-2">
        {tab === "General" && (
          <>
            <Check checked={s.startWithWindows} onChange={(v) => set("startWithWindows", v)} label="Launch OurIDM when Windows starts" />
            <Check checked={s.showCaptureDialog} onChange={(v) => set("showCaptureDialog", v)} label="Show the download dialog for captured downloads (off = start immediately)" />
            <Check checked={s.showProgressWindow} onChange={(v) => set("showProgressWindow", v)} label="Show the progress window when a download starts" />
            <Check checked={s.showCompleteDialog} onChange={(v) => set("showCompleteDialog", v)} label="Show the 'Download complete' window" />
            <Check checked={s.clipboardMonitor} onChange={(v) => set("clipboardMonitor", v)} label="Watch the clipboard for download links" />
          </>
        )}

        {tab === "File types" && (
          <>
            <p className="text-muted">OurIDM takes over browser downloads of these file types. Use * as a wildcard (R0*).</p>
            <textarea
              className="w-full h-32 p-2 rounded-md border border-line bg-surface font-mono text-[12px] outline-none focus:border-accent"
              aria-label="File types to capture"
              value={s.captureExtensions.join(" ")}
              onChange={(e) => set("captureExtensions", e.target.value.split(/[\s,]+/).filter(Boolean))}
            />
            <Field label="Minimum size" hint="Smaller downloads stay in the browser. 0 = capture all.">
              <TextInput type="number" min={0} className="w-28" value={s.captureMinSizeKb} onChange={(e) => set("captureMinSizeKb", Number(e.target.value))} /> KB
            </Field>
            <p className="text-muted pt-2">Don't capture downloads from these sites (one per line, * wildcards):</p>
            <textarea
              className="w-full h-20 p-2 rounded-md border border-line bg-surface font-mono text-[12px] outline-none focus:border-accent"
              aria-label="Excluded sites"
              value={s.excludedSites.join("\n")}
              onChange={(e) => set("excludedSites", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))}
            />
          </>
        )}

        {tab === "Save to" && (
          <>
            <Field label="Download folder">
              <FolderInput value={s.downloadRoot} onChange={(v) => set("downloadRoot", v)} />
            </Field>
            <Check
              checked={s.useCategoryFolders}
              onChange={(v) => set("useCategoryFolders", v)}
              label="Sort into category subfolders (Compressed, Documents, Music, Programs, Video)"
            />
          </>
        )}

        {tab === "Connection" && (
          <>
            <Field label="Connections" hint="Parallel connections per download (IDM's default is 8; servers may limit this).">
              <select
                className="h-8 px-2 rounded-md border border-line bg-surface"
                value={s.connections}
                onChange={(e) => set("connections", Number(e.target.value))}
              >
                {[1, 2, 4, 8, 16, 24, 32].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </Field>
            <Field label="Speed limit" hint="Total for all downloads. 0 = unlimited.">
              <TextInput type="number" min={0} className="w-28" value={s.speedLimitKbps} onChange={(e) => set("speedLimitKbps", Number(e.target.value))} /> KB/s
            </Field>
            <Field label="Retries" hint="Per connection, before the download fails.">
              <TextInput type="number" min={0} max={100} className="w-28" value={s.maxRetries} onChange={(e) => set("maxRetries", Number(e.target.value))} />
            </Field>
            <Field label="Proxy" hint="Empty = system proxy. e.g. http://127.0.0.1:8080 or socks5://127.0.0.1:1080">
              <TextInput className="w-full" value={s.proxy ?? ""} onChange={(e) => set("proxy", e.target.value || null)} />
            </Field>
          </>
        )}

        {tab === "Video" && (
          <>
            <Check checked={s.videoPanel} onChange={(v) => set("videoPanel", v)} label="Show the 'Download this video' button over web videos" />
            <Check checked={s.preferMp4} onChange={(v) => set("preferMp4", v)} label="Prefer MP4 (best compatibility) over WebM/MKV" />
            <Check checked={s.updateYtdlp} onChange={(v) => set("updateYtdlp", v)} label="Update the bundled yt-dlp at startup (sites change often)" />
            <div className="pt-3 space-y-1 text-[12px]">
              <ToolRow name="yt-dlp" path={tools?.ytdlp} />
              <ToolRow name="ffmpeg" path={tools?.ffmpeg} />
            </div>
            <p className="text-muted text-[12px] pt-2">
              DRM-protected streams (Netflix, Prime Video, Disney+, Spotify…) can't be downloaded.
            </p>
          </>
        )}

        {tab === "Browsers" && tools && (
          <div className="space-y-3">
            <ToolRow name="Native host" path={tools.nativeHost} />
            <div>
              <div className="font-medium mb-1">Chrome, Edge, Opera, Brave</div>
              <ol className="list-decimal pl-5 space-y-0.5 text-muted">
                <li>Open <code>chrome://extensions</code> (Edge: <code>edge://extensions</code>, Opera: <code>opera://extensions</code>).</li>
                <li>Turn on <b>Developer mode</b>, click <b>Load unpacked</b>, pick <code>extension\.output\chrome-mv3</code>.</li>
                <li>The extension ID must read <code className="text-fg select-all">{tools.chromeExtensionId}</code>.</li>
              </ol>
            </div>
            <div>
              <div className="font-medium mb-1">Firefox</div>
              <ol className="list-decimal pl-5 space-y-0.5 text-muted">
                <li>Open <code>about:debugging#/runtime/this-firefox</code> → <b>Load Temporary Add-on</b>.</li>
                <li>Pick <code>extension\.output\firefox-mv2\manifest.json</code> (ID <code className="select-all">{tools.firefoxExtensionId}</code>).</li>
              </ol>
            </div>
            <p className="text-[12px] text-muted">OurIDM {tools.version}</p>
          </div>
        )}
      </div>
    </Modal>
  );
}

function ToolRow({ name, path }: { name: string; path: string | null | undefined }) {
  return (
    <div className="flex gap-2">
      <span className="w-24 text-muted">{name}</span>
      {path ? <span className="text-ok truncate" title={path}>Found: {path}</span> : <span className="text-danger">Not found</span>}
    </div>
  );
}

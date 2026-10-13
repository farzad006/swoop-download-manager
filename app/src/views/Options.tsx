import { useEffect, useState } from "react";
import { Bug, CheckCircle2, Copy, Download, ExternalLink, Film, Gauge, Gift, GitBranch, Heart, Puzzle, Settings as Cog, SlidersHorizontal, FileType2, XCircle } from "lucide-react";
import { Logo } from "../components/Logo";
import { api, BrowserStatus, joinPath, Settings, ToolStatus } from "../api";
import { Button, FolderInput, Modal, Select, SettingRow, Switch, TextInput, useToast } from "../components/ui";

const SECTIONS = [
  { key: "general", label: "General", icon: Cog },
  { key: "downloads", label: "Downloads", icon: Download },
  { key: "browsers", label: "Browsers", icon: Puzzle },
  { key: "speed", label: "Speed", icon: Gauge },
  { key: "videos", label: "Videos", icon: Film },
  { key: "files", label: "File types", icon: FileType2 },
  { key: "advanced", label: "Advanced", icon: SlidersHorizontal },
  { key: "about", label: "About", icon: Heart },
] as const;
type Section = (typeof SECTIONS)[number]["key"];

/** Settings, grouped into plain-language sections. Changes apply on Save. */
export function SettingsDialog({ onClose, initialTab }: { onClose: () => void; initialTab?: string }) {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [tools, setTools] = useState<ToolStatus | null>(null);
  const [browsers, setBrowsers] = useState<BrowserStatus[] | null>(null);
  const [tab, setTab] = useState<Section>((SECTIONS.find((x) => x.key === initialTab)?.key ?? "general") as Section);

  useEffect(() => {
    api.settings().then(setS);
    api.tools().then(setTools);
    api.browsers().then(setBrowsers);
  }, []);
  if (!s) return null;
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS({ ...s, [k]: v });

  const save = async () => {
    try {
      await api.saveSettings(s);
      toast("Settings saved", "ok");
      onClose();
    } catch (e) {
      toast(String(e), "error");
    }
  };

  return (
    <Modal
      title="Settings"
      icon={Cog}
      width={820}
      onClose={onClose}
      bodyClass="!p-0"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save}>Save</Button>
        </>
      }
    >
      <div className="flex h-[480px] border-t border-line">
        <nav className="w-[190px] shrink-0 p-2.5 space-y-0.5 bg-surface-2 border-r border-line" role="tablist" aria-orientation="vertical">
          {SECTIONS.map((x) => (
            <button
              key={x.key}
              role="tab"
              aria-selected={tab === x.key}
              onClick={() => setTab(x.key)}
              className={`w-full flex items-center gap-2.5 h-9 px-2.5 rounded-lg text-left cursor-pointer transition-colors ${
                tab === x.key ? "bg-surface shadow-[var(--shadow-card)] font-medium" : "hover:bg-hover"
              }`}
            >
              <x.icon size={16} className={tab === x.key ? "text-accent" : "text-muted"} />
              {x.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 overflow-auto px-6 py-2 divide-y divide-line">
          {tab === "general" && (
            <>
              <SettingRow title="Start Swoop with Windows" description="Runs quietly in the system tray so browser downloads always have somewhere to go.">
                <Switch label="Start with Windows" checked={s.startWithWindows} onChange={(v) => set("startWithWindows", v)} />
              </SettingRow>
              <SettingRow title="Ask before downloading" description="Shows the file name and folder first. Turn off to start browser downloads straight away.">
                <Switch label="Ask before downloading" checked={s.showCaptureDialog} onChange={(v) => set("showCaptureDialog", v)} />
              </SettingRow>
              <SettingRow title="Show a progress window" description="Opens a small window for each download you start.">
                <Switch label="Show progress window" checked={s.showProgressWindow} onChange={(v) => set("showProgressWindow", v)} />
              </SettingRow>
              <SettingRow title="Tell me when a download finishes" description="Turns the progress window into a “Download complete” window with Open and Show in folder buttons.">
                <Switch label="Download complete window" checked={s.showCompleteDialog} onChange={(v) => set("showCompleteDialog", v)} />
              </SettingRow>
              <SettingRow title="Notice copied links" description="When you copy a link to a file, Swoop offers to download it.">
                <Switch label="Watch clipboard" checked={s.clipboardMonitor} onChange={(v) => set("clipboardMonitor", v)} />
              </SettingRow>
              <SettingRow title="Welcome tour" description="See the first-run introduction again.">
                <Button
                  size="sm"
                  onClick={async () => {
                    await api.saveSettings({ ...s, onboarded: false });
                    onClose();
                  }}
                >
                  Show again
                </Button>
              </SettingRow>
            </>
          )}

          {tab === "downloads" && (
            <>
              <div className="py-4">
                <div className="font-medium mb-1">Save downloads to</div>
                <FolderInput value={s.downloadRoot} onChange={(v) => set("downloadRoot", v)} />
              </div>
              <SettingRow
                title="Sort into folders by type"
                description={
                  <>
                    Videos go to <code>{joinPath(s.downloadRoot, "Video")}</code>, music to <code>…\Music</code>, and so on.
                  </>
                }
              >
                <Switch label="Category folders" checked={s.useCategoryFolders} onChange={(v) => set("useCategoryFolders", v)} />
              </SettingRow>
            </>
          )}

          {tab === "browsers" && (
            <div className="py-4 space-y-4">
              <p className="text-muted">The Swoop extension sends downloads and web videos from your browser to Swoop.</p>
              <div className="border border-line rounded-xl divide-y divide-line">
                {(browsers ?? []).map((b) => (
                  <div key={b.id} className="flex items-center gap-3 h-11 px-3.5">
                    <span className="flex-1 font-medium">{b.name}</span>
                    {b.connectedAt ? (
                      <span className="flex items-center gap-1.5 text-ok text-[12.5px]"><CheckCircle2 size={15} /> Connected</span>
                    ) : (
                      <span className="flex items-center gap-1.5 text-faint text-[12.5px]"><XCircle size={15} /> Not connected</span>
                    )}
                  </div>
                ))}
                {browsers?.length === 0 && <div className="px-3.5 py-3 text-muted">No supported browsers were found.</div>}
              </div>
              <Button variant="primary" icon={Puzzle} onClick={() => api.openBrowserSetupWindow()}>Connect a browser…</Button>
              <SettingRow title="“Download this video” button" description="Shows a button on videos you play on websites.">
                <Switch label="Video button" checked={s.videoPanel} onChange={(v) => set("videoPanel", v)} />
              </SettingRow>
              <p className="text-[12px] text-faint">
                Tip: hold <b>Alt</b> while clicking a link to let the browser download it instead.
              </p>
            </div>
          )}

          {tab === "speed" && (
            <>
              <SettingRow title="Limit download speed" description="Leaves bandwidth for video calls and browsing. Applies to all downloads together.">
                <Switch label="Limit speed" checked={s.speedLimitKbps > 0} onChange={(v) => set("speedLimitKbps", v ? 2048 : 0)} />
              </SettingRow>
              {s.speedLimitKbps > 0 && (
                <div className="py-3.5 flex items-center gap-3">
                  <span className="text-muted">Maximum</span>
                  <TextInput type="number" min={64} className="w-28" value={Math.round(s.speedLimitKbps / 1024 * 10) / 10} step={0.5} onChange={(e) => set("speedLimitKbps", Math.max(64, Math.round(Number(e.target.value) * 1024)))} aria-label="Speed limit in MB per second" />
                  <span className="text-muted">MB/s</span>
                </div>
              )}
              <SettingRow title="Connections per download" description="More connections can be faster. Some sites limit this; 8 works well almost everywhere.">
                <Select value={s.connections} onChange={(e) => set("connections", Number(e.target.value))} aria-label="Connections per download">
                  {[1, 2, 4, 8, 16, 24, 32].map((n) => (
                    <option key={n} value={n}>{n}{n === 8 ? " (recommended)" : ""}</option>
                  ))}
                </Select>
              </SettingRow>
            </>
          )}

          {tab === "videos" && (
            <>
              <SettingRow title="Prefer MP4" description="Plays on every device and TV. Turn off to allow WebM/MKV, which some sites use for top quality.">
                <Switch label="Prefer MP4" checked={s.preferMp4} onChange={(v) => set("preferMp4", v)} />
              </SettingRow>
              <SettingRow title="Keep the video downloader up to date" description="Websites change often; Swoop checks for a new yt-dlp once a day.">
                <Switch label="Update yt-dlp" checked={s.updateYtdlp} onChange={(v) => set("updateYtdlp", v)} />
              </SettingRow>
              <div className="py-4 space-y-2">
                <div className="font-medium">Video tools</div>
                <ToolLine name="yt-dlp" hint="finds the video on a page" path={tools?.ytdlp} />
                <ToolLine name="ffmpeg" hint="joins video and audio" path={tools?.ffmpeg} />
                <p className="text-[12px] text-faint pt-1">Copy-protected streams (Netflix, Prime Video, Disney+, Spotify) can't be downloaded.</p>
              </div>
            </>
          )}

          {tab === "files" && (
            <div className="py-4 space-y-4">
              <div>
                <div className="font-medium">Take over these file types from the browser</div>
                <p className="text-muted text-[12.5px] mb-2">Separate with spaces. Use * as a wildcard, like R0* for split archives.</p>
                <textarea
                  className="w-full h-28 p-3 rounded-lg border border-line-strong bg-surface font-mono text-[12px] outline-none focus:border-accent"
                  aria-label="File types to take over"
                  value={s.captureExtensions.join(" ")}
                  onChange={(e) => set("captureExtensions", e.target.value.split(/[\s,]+/).filter(Boolean))}
                />
              </div>
              <SettingRow title="Skip small files" description="Files smaller than this stay in the browser. 0 means take over everything.">
                <div className="flex items-center gap-2">
                  <TextInput type="number" min={0} className="w-24" value={s.captureMinSizeKb} onChange={(e) => set("captureMinSizeKb", Number(e.target.value))} aria-label="Minimum size in KB" />
                  <span className="text-muted">KB</span>
                </div>
              </SettingRow>
              <div>
                <div className="font-medium">Never take over downloads from</div>
                <p className="text-muted text-[12.5px] mb-2">One site per line, e.g. <code>*.example.com</code>.</p>
                <textarea
                  className="w-full h-20 p-3 rounded-lg border border-line-strong bg-surface font-mono text-[12px] outline-none focus:border-accent"
                  aria-label="Sites to skip"
                  value={s.excludedSites.join("\n")}
                  onChange={(e) => set("excludedSites", e.target.value.split("\n").map((x) => x.trim()).filter(Boolean))}
                />
              </div>
            </div>
          )}

          {tab === "about" && <About />}

          {tab === "advanced" && (
            <>
              <SettingRow title="Proxy" description="Leave empty to use Windows' proxy settings. Example: http://127.0.0.1:8080 or socks5://127.0.0.1:1080">
                <TextInput className="w-64" value={s.proxy ?? ""} onChange={(e) => set("proxy", e.target.value || null)} aria-label="Proxy" placeholder="System proxy" />
              </SettingRow>
              <SettingRow title="Retries" description="How often a dropped connection is retried before the download stops.">
                <TextInput type="number" min={0} max={100} className="w-24" value={s.maxRetries} onChange={(e) => set("maxRetries", Number(e.target.value))} aria-label="Retries" />
              </SettingRow>
              <div className="py-4 text-[12px] text-faint space-y-0.5">
                <div>Swoop {tools?.version} · made by Ali Studio</div>
                <div>Extension ID (Chrome, Edge, Opera, Brave): <code className="select-all">{tools?.chromeExtensionId}</code></div>
                <div>Extension ID (Firefox): <code>{tools?.firefoxExtensionId}</code></div>
                <div>Extension files: <code className="select-all">{tools?.extensionDir ?? "not found"}</code></div>
                <div>Browser connector: <code className="select-all">{tools?.nativeHost ?? "not found"}</code></div>
              </div>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ToolLine({ name, hint, path }: { name: string; hint: string; path: string | null | undefined }) {
  return (
    <div className="flex items-center gap-3 px-3.5 h-11 rounded-xl border border-line">
      {path ? <CheckCircle2 size={16} className="text-ok" /> : <XCircle size={16} className="text-danger" />}
      <span className="font-medium w-16">{name}</span>
      <span className="text-muted flex-1 truncate" title={path ?? undefined}>{path ? hint : "not found — video downloads won't work"}</span>
    </div>
  );
}

function About() {
  const toast = useToast();
  const [info, setInfo] = useState<{ version: string; supportEmail: string } | null>(null);
  useEffect(() => {
    api.about().then(setInfo);
  }, []);
  if (!info) return null;
  const copyEmail = () => navigator.clipboard.writeText(info.supportEmail).then(() => toast("Email copied", "ok"));
  return (
    <div className="py-5 space-y-5">
      <div className="flex items-center gap-4">
        <Logo size={64} className="drop-shadow-md" />
        <div>
          <div className="text-[20px] font-semibold font-[family-name:var(--font-display)]">Swoop</div>
          <div className="text-muted">Version {info.version} · made by Ali Studio</div>
          <div className="text-faint text-[12.5px]">Free and open source (MIT license)</div>
        </div>
      </div>
      <div className="flex gap-2 flex-wrap">
        <Button size="sm" icon={GitBranch} onClick={() => api.openLink("project")}>Project on GitHub</Button>
        <Button size="sm" icon={Download} onClick={() => api.openLink("releases")}>Check for updates</Button>
        <Button size="sm" icon={Bug} onClick={() => api.openLink("issues")}>Report a problem</Button>
      </div>
      <div className="rounded-2xl border border-line bg-gradient-to-br from-accent-soft to-surface p-5">
        <div className="flex items-center gap-2 font-semibold text-[15px]">
          <Gift size={18} className="text-accent" /> Enjoying Swoop?
        </div>
        <p className="text-muted mt-1.5">
          Swoop is free. If it saves you time, you can say thanks with an Amazon Pay gift card (amazon.in), sent by email to:
        </p>
        <div className="mt-3 flex items-center gap-2">
          <code className="px-3 h-9 leading-9 rounded-lg border border-line bg-surface select-all font-medium">{info.supportEmail}</code>
          <Button size="sm" icon={Copy} className="h-9" onClick={copyEmail}>Copy</Button>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            variant="primary"
            icon={ExternalLink}
            onClick={async () => {
              await navigator.clipboard.writeText(info.supportEmail).catch(() => {});
              await api.openLink("support");
              toast("Email copied. Paste it as the recipient on Amazon.", "ok");
            }}
          >
            Send a gift card
          </Button>
          <span className="text-[12px] text-faint">Opens amazon.in; any amount you like. Thank you!</span>
        </div>
      </div>
    </div>
  );
}

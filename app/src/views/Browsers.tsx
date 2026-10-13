import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, Copy, ExternalLink, FolderOpen, Puzzle } from "lucide-react";
import { api, BrowserStatus } from "../api";
import { Button } from "../components/ui";

const DEV_MODE_SPOT: Record<string, string> = {
  edge: "in the left sidebar",
  chrome: "at the top right",
  opera: "at the top right",
  brave: "at the top right",
  vivaldi: "at the top right",
};

/** "Connect OurIDM to your browsers" — opened after install for the browsers
 *  ticked in the installer, and from Options → Browsers. */
export default function Browsers({ selected }: { selected: string[] }) {
  const [list, setList] = useState<BrowserStatus[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const win = getCurrentWindow();

  const load = useCallback(() => api.browsers().then(setList).catch((e) => setErr(String(e))), []);
  useEffect(() => {
    load();
    const un = listen("browser-connected", () => load());
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  const run = (p: Promise<unknown>) => p.catch((e) => setErr(String(e)));
  if (!list) return null;

  const picked = list.filter((b) => selected.length === 0 || selected.includes(b.id));
  const others = list.filter((b) => !picked.includes(b));
  const done = picked.filter((b) => b.connectedAt).length;

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="px-5 pt-4 pb-3 border-b border-line">
        <div className="text-[15px] font-semibold flex items-center gap-2">
          <Puzzle size={18} className="text-accent" /> Connect OurIDM to your browsers
        </div>
        <p className="text-muted mt-1">
          Browsers only let their own stores add extensions automatically, so each one needs a one-time step of about
          20 seconds. A browser turns green here as soon as the extension is working in it.
        </p>
      </div>

      <div className="flex-1 overflow-auto px-5 py-3 space-y-2.5">
        {list.length === 0 && <p className="text-muted">No supported browsers were found on this PC.</p>}
        {picked.map((b) => (
          <Card key={b.id} b={b} expanded onAction={run} />
        ))}
        {others.length > 0 && (
          <>
            <div className="pt-2 text-[11px] uppercase tracking-wide text-muted">Other browsers on this PC</div>
            {others.map((b) => (
              <Card key={b.id} b={b} expanded={false} onAction={run} />
            ))}
          </>
        )}
        {err && <div className="text-danger">{err}</div>}
      </div>

      <div className="px-5 py-3 border-t border-line bg-surface-2 flex items-center">
        <span className="text-muted">
          {picked.length > 0 && `${done} of ${picked.length} connected`}
        </span>
        <Button primary className="ml-auto" onClick={() => win.close()}>
          {done === picked.length && picked.length > 0 ? "Done" : "Close"}
        </Button>
      </div>
    </div>
  );
}

function Card({ b, expanded, onAction }: { b: BrowserStatus; expanded: boolean; onAction: (p: Promise<unknown>) => void }) {
  const [open, setOpen] = useState(expanded && !b.connectedAt);
  useEffect(() => {
    if (b.connectedAt) setOpen(false);
  }, [b.connectedAt]);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    if (!b.extensionPath) return;
    navigator.clipboard.writeText(b.extensionPath);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={`border rounded-lg ${b.connectedAt ? "border-ok/40" : "border-line"}`}>
      <button className="w-full flex items-center gap-3 px-3 h-11 cursor-pointer text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-medium flex-1">{b.name}</span>
        {b.connectedAt ? (
          <span className="flex items-center gap-1 text-ok text-[12px]">
            <CheckCircle2 size={15} /> Connected
          </span>
        ) : (
          <span className="text-muted text-[12px]">Not connected</span>
        )}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-2.5">
          {b.engine === "chromium" ? (
            <>
              <Step n={1}>
                <OpenPage b={b} onAction={onAction} />
              </Step>
              <Step n={2}>
                Turn on <b>Developer mode</b> ({DEV_MODE_SPOT[b.id] ?? "on that page"}).
              </Step>
              <Step n={3}>
                <div className="space-y-1.5">
                  <Button className="h-7 px-3" onClick={() => onAction(api.revealExtension(b.id))}>
                    <span className="inline-flex items-center gap-1.5"><FolderOpen size={14} /> Show the extension folder</span>
                  </Button>
                  <div className="text-muted">
                    Drag the selected <code>chrome-mv3</code> folder onto the extensions page, or click <b>Load unpacked</b> and paste this path:
                  </div>
                  <PathRow path={b.extensionPath} copied={copied} onCopy={copy} />
                </div>
              </Step>
            </>
          ) : b.signedXpi ? (
            <Step n={1}>
              <Button className="h-7 px-3" onClick={() => onAction(api.openBrowserSetup(b.id))}>
                <span className="inline-flex items-center gap-1.5"><ExternalLink size={14} /> Install in Firefox</span>
              </Button>
              <span className="text-muted ml-2">Firefox asks you to confirm with <b>Add</b>.</span>
            </Step>
          ) : (
            <>
              <Step n={1}>
                <OpenPage b={b} onAction={onAction} />
              </Step>
              <Step n={2}>
                <div className="space-y-1.5">
                  <div>
                    Click <b>Load Temporary Add-on…</b> and pick this file:
                  </div>
                  <PathRow path={b.extensionPath} copied={copied} onCopy={copy} />
                  <div className="text-muted text-[12px]">
                    Firefox removes temporary add-ons when it restarts. A Mozilla-signed copy installs permanently; see the README.
                  </div>
                </div>
              </Step>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const PAGE: Record<string, string> = {
  edge: "edge://extensions",
  opera: "opera://extensions",
  brave: "brave://extensions",
  vivaldi: "vivaldi://extensions",
  firefox: "about:debugging#/runtime/this-firefox",
};

/** Browsers refuse to open their settings pages for other programs, so this
 *  opens the browser and copies the address for a quick paste. */
function OpenPage({ b, onAction }: { b: BrowserStatus; onAction: (p: Promise<unknown>) => void }) {
  const [opened, setOpened] = useState(false);
  const page = PAGE[b.id] ?? "chrome://extensions";
  return (
    <div className="space-y-1">
      <Button
        className="h-7 px-3"
        onClick={() => {
          setOpened(true);
          onAction(api.openBrowserSetup(b.id));
        }}
      >
        <span className="inline-flex items-center gap-1.5"><ExternalLink size={14} /> Open {b.name}</span>
      </Button>
      <div className={opened ? "" : "text-muted"}>
        {opened ? "In the browser, press " : "Then go to "}
        {opened && (
          <>
            <kbd className="px-1 border border-line rounded text-[11px]">Ctrl</kbd>+<kbd className="px-1 border border-line rounded text-[11px]">L</kbd>,{" "}
            <kbd className="px-1 border border-line rounded text-[11px]">Ctrl</kbd>+<kbd className="px-1 border border-line rounded text-[11px]">V</kbd>,{" "}
            <kbd className="px-1 border border-line rounded text-[11px]">Enter</kbd> to go to{" "}
          </>
        )}
        <code className="select-all">{page}</code>
        {opened ? " (copied for you)." : "."}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 items-start">
      <span className="size-5 shrink-0 rounded-full bg-accent text-on-accent grid place-items-center text-[11px] font-semibold mt-0.5">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

function PathRow({ path, copied, onCopy }: { path: string | null; copied: boolean; onCopy: () => void }) {
  if (!path) return <div className="text-danger">The extension files weren't found next to OurIDM.</div>;
  return (
    <div className="flex items-center gap-1">
      <code className="flex-1 min-w-0 truncate select-all px-2 h-7 leading-7 rounded border border-line bg-surface-2 text-[12px]" title={path}>
        {path}
      </code>
      <button
        onClick={onCopy}
        aria-label="Copy path"
        title="Copy path"
        className="h-7 px-2 rounded border border-line hover:bg-hover cursor-pointer inline-flex items-center gap-1 text-[12px]"
      >
        <Copy size={13} /> {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

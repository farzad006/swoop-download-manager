import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CheckCircle2, ChevronDown, Copy, ExternalLink, FolderOpen, Puzzle } from "lucide-react";
import { api, BrowserStatus } from "../api";
import { Button, Kbd, useToast } from "../components/ui";

const DEV_MODE_SPOT: Record<string, string> = {
  edge: "in the left sidebar",
  chrome: "at the top right",
  opera: "at the top right",
  brave: "at the top right",
  vivaldi: "at the top right",
};

const PAGE: Record<string, string> = {
  edge: "edge://extensions",
  opera: "opera://extensions",
  brave: "brave://extensions",
  vivaldi: "vivaldi://extensions",
  firefox: "about:debugging#/runtime/this-firefox",
};

/** Live list of browsers with setup steps; reports how many are connected. */
export function BrowserList({ selected, onCount }: { selected: string[]; onCount?: (connected: number, picked: number) => void }) {
  const [list, setList] = useState<BrowserStatus[] | null>(null);
  const toast = useToast();
  const load = useCallback(() => api.browsers().then(setList).catch((e) => toast(String(e), "error")), [toast]);
  useEffect(() => {
    load();
    const un = listen<string>("browser-connected", () => load());
    return () => {
      un.then((f) => f());
    };
  }, [load]);

  const picked = (list ?? []).filter((b) => selected.length === 0 || selected.includes(b.id));
  const others = (list ?? []).filter((b) => !picked.includes(b));
  useEffect(() => {
    if (list) onCount?.(picked.filter((b) => b.connectedAt).length, picked.length);
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list) return null;
  const run = (p: Promise<unknown>) => p.catch((e) => toast(String(e), "error"));
  return (
    <div className="space-y-2.5">
      {list.length === 0 && <p className="text-muted">No supported browsers were found on this PC.</p>}
      {picked.map((b, i) => (
        <Card key={b.id} b={b} expanded={i === picked.findIndex((x) => !x.connectedAt)} onAction={run} />
      ))}
      {others.length > 0 && (
        <>
          <div className="pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">Other browsers on this PC</div>
          {others.map((b) => (
            <Card key={b.id} b={b} expanded={false} onAction={run} />
          ))}
        </>
      )}
    </div>
  );
}

/** "Connect Swoop to your browsers" window (installer follow-up, Settings). */
export default function Browsers({ selected }: { selected: string[] }) {
  const [count, setCount] = useState<[number, number]>([0, 0]);
  const win = getCurrentWindow();
  const [done, picked] = count;
  return (
    <div className="h-full flex flex-col bg-bg">
      <div className="px-6 pt-5 pb-4">
        <div className="flex items-center gap-3">
          <span className="size-10 rounded-xl bg-accent-soft text-accent grid place-items-center">
            <Puzzle size={20} />
          </span>
          <div>
            <div className="text-[17px] font-semibold font-[family-name:var(--font-display)]">Connect Swoop to your browsers</div>
            <div className="text-muted text-[12.5px]">A one-time step of about 20 seconds per browser.</div>
          </div>
        </div>
      </div>
      <div className="flex-1 overflow-auto px-6 pb-4">
        <BrowserList selected={selected} onCount={(a, b) => setCount([a, b])} />
        <p className="text-[12px] text-faint mt-4 leading-relaxed">
          Why isn't this automatic? Browsers only let their own add-on stores install extensions without your help, which keeps
          unwanted extensions out. A browser turns green here as soon as Swoop works in it.
        </p>
      </div>
      <div className="px-6 py-3 border-t border-line bg-surface flex items-center">
        <span className="text-muted">{picked > 0 && `${done} of ${picked} connected`}</span>
        <Button variant="primary" className="ml-auto" onClick={() => win.close()}>
          {done === picked && picked > 0 ? "Done" : "Close"}
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
    <div className={`rounded-xl border bg-surface shadow-[var(--shadow-card)] transition-colors ${b.connectedAt ? "border-ok/40" : "border-line"}`}>
      <button className="w-full flex items-center gap-3 px-4 h-12 cursor-pointer text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="font-medium flex-1">{b.name}</span>
        {b.connectedAt ? (
          <span className="flex items-center gap-1.5 text-ok text-[12.5px] font-medium">
            <CheckCircle2 size={16} /> Connected
          </span>
        ) : (
          <span className="text-faint text-[12.5px]">Not connected</span>
        )}
        <ChevronDown size={16} className={`text-faint transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-3 anim-fade-up">
          {b.engine === "chromium" ? (
            <>
              <Step n={1}>
                <OpenPage b={b} onAction={onAction} />
              </Step>
              <Step n={2}>
                Turn on <b>Developer mode</b> ({DEV_MODE_SPOT[b.id] ?? "on that page"}).
              </Step>
              <Step n={3}>
                <div className="space-y-2">
                  <Button size="sm" icon={FolderOpen} onClick={() => onAction(api.revealExtension(b.id))}>
                    Show the extension folder
                  </Button>
                  <div className="text-muted">
                    Drag the highlighted <b>chrome-mv3</b> folder onto the extensions page, or click <b>Load unpacked</b> and paste this:
                  </div>
                  <PathRow path={b.extensionPath} copied={copied} onCopy={copy} />
                </div>
              </Step>
            </>
          ) : b.signedXpi ? (
            <Step n={1}>
              <Button size="sm" variant="primary" icon={ExternalLink} onClick={() => onAction(api.openBrowserSetup(b.id))}>
                Install in Firefox
              </Button>
              <span className="text-muted ml-2">Firefox asks you to confirm with <b>Add</b>.</span>
            </Step>
          ) : (
            <>
              <Step n={1}>
                <OpenPage b={b} onAction={onAction} />
              </Step>
              <Step n={2}>
                <div className="space-y-2">
                  <div>
                    Click <b>Load Temporary Add-on…</b> and pick this file:
                  </div>
                  <PathRow path={b.extensionPath} copied={copied} onCopy={copy} />
                  <div className="text-faint text-[12px]">Firefox removes temporary add-ons when it restarts. A Mozilla-signed copy installs permanently (see the README).</div>
                </div>
              </Step>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Browsers refuse to open their settings pages for other programs, so this
 *  opens the browser and copies the address for a quick paste. */
function OpenPage({ b, onAction }: { b: BrowserStatus; onAction: (p: Promise<unknown>) => void }) {
  const [opened, setOpened] = useState(false);
  const page = PAGE[b.id] ?? "chrome://extensions";
  return (
    <div className="space-y-1.5">
      <Button
        size="sm"
        variant="primary"
        icon={ExternalLink}
        onClick={() => {
          setOpened(true);
          onAction(api.openBrowserSetup(b.id));
        }}
      >
        Open {b.name}
      </Button>
      <div className="text-muted">
        {opened ? (
          <>
            In {b.name}, press <Kbd>Ctrl</Kbd>+<Kbd>L</Kbd>, then <Kbd>Ctrl</Kbd>+<Kbd>V</Kbd>, then <Kbd>Enter</Kbd>. The address <code>{page}</code> is already copied.
          </>
        ) : (
          <>
            Then go to <code className="select-all">{page}</code>
          </>
        )}
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start">
      <span className="size-6 shrink-0 rounded-full bg-accent-soft text-accent grid place-items-center text-[12px] font-semibold">{n}</span>
      <div className="min-w-0 flex-1 pt-0.5">{children}</div>
    </div>
  );
}

function PathRow({ path, copied, onCopy }: { path: string | null; copied: boolean; onCopy: () => void }) {
  if (!path) return <div className="text-danger">The extension files weren't found next to Swoop.</div>;
  return (
    <div className="flex items-center gap-1.5">
      <code className="flex-1 min-w-0 truncate select-all px-2.5 h-8 leading-8 rounded-lg border border-line bg-surface-2 text-[12px]" title={path}>
        {path}
      </code>
      <Button size="sm" icon={Copy} className="h-8" onClick={onCopy}>{copied ? "Copied" : "Copy"}</Button>
    </div>
  );
}

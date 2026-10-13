import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  AlertCircle,
  ArrowDownCircle,
  CalendarClock,
  CheckCircle2,
  ClipboardPaste,
  Copy,
  Download as DownloadIcon,
  ExternalLink,
  FolderOpen,
  Layers,
  Link2,
  ListOrdered,
  ListPlus,
  ListX,
  MoreHorizontal,
  Pause,
  PauseCircle,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  Search,
  Settings as SettingsIcon,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { api, BrowserStatus, describeError, Download, fmtBytes, fmtEtaFriendly, fmtRelative, fmtSpeed, percent, Progress, Queue, Settings, Status } from "../api";
import { CATEGORIES, FileTile, category } from "../categories";
import { Badge, Button, Check, IconButton, Kbd, Menu, MenuItem, Modal, ProgressBar, TextInput, useToast } from "../components/ui";
import { SettingsDialog } from "./Options";
import { SchedulerDialog } from "./Scheduler";
import Onboarding from "./Onboarding";
import { Logo } from "../components/Logo";

type StatusKey = "all" | "active" | "queued" | "paused" | "completed" | "failed";
type Filter = { kind: "status"; key: StatusKey } | { kind: "category"; key: string } | { kind: "queue"; id: number };
type SortKey = "newest" | "name" | "size";

const STATUS_FILTERS: { key: StatusKey; label: string; icon: typeof Layers }[] = [
  { key: "all", label: "All downloads", icon: Layers },
  { key: "active", label: "Downloading", icon: ArrowDownCircle },
  { key: "queued", label: "Queued", icon: ListOrdered },
  { key: "paused", label: "Paused", icon: PauseCircle },
  { key: "completed", label: "Completed", icon: CheckCircle2 },
  { key: "failed", label: "Needs attention", icon: AlertCircle },
];

/** Live status wins over the stored one while a transfer runs. */
function effective(d: Download, p?: Progress): Status {
  if (p && (p.status === "downloading" || p.status === "probing")) return p.status;
  return d.status;
}

function statusGroup(s: Status): StatusKey {
  if (s === "downloading" || s === "probing") return "active";
  return s as StatusKey;
}

export default function Main() {
  const toast = useToast();
  const [downloads, setDownloads] = useState<Map<number, Download>>(new Map());
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  const [queues, setQueues] = useState<Queue[]>([]);
  const [browsers, setBrowsers] = useState<BrowserStatus[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [filter, setFilter] = useState<Filter>({ kind: "status", key: "all" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [sort, setSort] = useState<SortKey>("newest");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<null | "settings" | "scheduler" | "delete" | "fix">(null);
  const [settingsTab, setSettingsTab] = useState<string | undefined>();
  const [menu, setMenu] = useState<{ x: number; y: number; ids: number[] } | null>(null);
  const [fixTarget, setFixTarget] = useState<Download | null>(null);
  const [dragging, setDragging] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const reloadQueues = useCallback(() => api.queues().then(setQueues), []);
  const reloadBrowsers = useCallback(() => api.browsers().then(setBrowsers).catch(() => {}), []);
  const reloadSettings = useCallback(() => api.settings().then(setSettings), []);

  useEffect(() => {
    api.list().then((l) => setDownloads(new Map(l.map((d) => [d.id, d]))));
    reloadQueues();
    reloadBrowsers();
    reloadSettings();
    const un = [
      listen<Download>("download-updated", (e) => setDownloads((m) => new Map(m).set(e.payload.id, e.payload))),
      listen<number>("download-removed", (e) => {
        setDownloads((m) => {
          const n = new Map(m);
          n.delete(e.payload);
          return n;
        });
        setSelected((s) => {
          const n = new Set(s);
          n.delete(e.payload);
          return n;
        });
      }),
      listen<Progress>("progress", (e) => setProgress((m) => new Map(m).set(e.payload.id, e.payload))),
      listen("queues-changed", () => reloadQueues()),
      listen("browser-connected", () => reloadBrowsers()),
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [reloadQueues, reloadBrowsers, reloadSettings]);

  const all = useMemo(() => [...downloads.values()], [downloads]);
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: all.length };
    for (const d of all) {
      const g = statusGroup(effective(d, progress.get(d.id)));
      c[g] = (c[g] ?? 0) + 1;
      c[`cat:${d.category}`] = (c[`cat:${d.category}`] ?? 0) + 1;
      if (d.queueId != null && d.status !== "completed") c[`q:${d.queueId}`] = (c[`q:${d.queueId}`] ?? 0) + 1;
    }
    return c;
  }, [all, progress]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = all.filter((d) => {
      if (q && !d.fileName.toLowerCase().includes(q) && !d.url.toLowerCase().includes(q)) return false;
      if (filter.kind === "category") return d.category === filter.key;
      if (filter.kind === "queue") return d.queueId === filter.id && d.status !== "completed";
      return filter.key === "all" || statusGroup(effective(d, progress.get(d.id))) === filter.key;
    });
    list.sort((a, b) =>
      sort === "name" ? a.fileName.localeCompare(b.fileName) : sort === "size" ? (b.size ?? 0) - (a.size ?? 0) : b.addedAt - a.addedAt || b.id - a.id,
    );
    return list;
  }, [all, progress, filter, sort, query]);

  const run = useCallback((f: () => Promise<unknown>) => f().catch((e) => toast(String(e), "error")), [toast]);
  const sel = [...selected].map((id) => downloads.get(id)).filter((d): d is Download => !!d);
  const active = [...progress.values()].filter((p) => p.status === "downloading" || p.status === "probing");
  const totalSpeed = active.reduce((s, p) => s + p.speed, 0);

  const addLink = useCallback(
    (url: string) => {
      const u = url.trim();
      if (!/^https?:\/\/\S+$/i.test(u)) {
        toast("That doesn't look like a web link. It should start with http:// or https://", "error");
        return false;
      }
      run(() => api.captureUrl(u));
      return true;
    },
    [run, toast],
  );

  // Ctrl+V adds a copied link, Del deletes, Ctrl+F searches, Ctrl+A selects all.
  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest("input, textarea, select");
      if (dialog || typing) return;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && k === "v") {
        const link = await api.clipboardLink();
        if (link) addLink(link);
        else toast("Copy a download link first, then press Ctrl+V here.");
      } else if (e.ctrlKey && k === "f") {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.ctrlKey && k === "a") {
        e.preventDefault();
        setSelected(new Set(visible.map((d) => d.id)));
      } else if (e.key === "Delete" && selected.size > 0) {
        setDialog("delete");
      } else if (e.key === "Escape") {
        setSelected(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog, visible, selected, addLink, toast]);

  const onCardClick = (e: React.MouseEvent, id: number) => {
    if (e.shiftKey && anchor != null) {
      const ids = visible.map((d) => d.id);
      const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
      setSelected(new Set(ids.slice(a, b + 1)));
    } else if (e.ctrlKey) {
      const n = new Set(selected);
      n.has(id) ? n.delete(id) : n.add(id);
      setSelected(n);
      setAnchor(id);
    } else {
      setSelected(new Set([id]));
      setAnchor(id);
    }
  };

  const resume = (ds: Download[]) => run(async () => { for (const d of ds) if (d.status !== "completed") await api.start(d.id); });
  const pause = (ds: Download[]) => run(async () => { for (const d of ds) await api.pause(d.id); });
  const openFix = (d: Download) => {
    setFixTarget(d);
    setDialog("fix");
  };

  const menuItems = (ids: number[]): MenuItem[] => {
    const ds = ids.map((i) => downloads.get(i)).filter((d): d is Download => !!d);
    const one = ds.length === 1 ? ds[0]! : null;
    const items: MenuItem[] = [];
    if (one && one.status === "completed") {
      items.push({ label: "Open file", icon: ExternalLink, onClick: () => run(() => api.openFile(one.id)) });
      items.push({ label: "Show in folder", icon: FolderOpen, onClick: () => run(() => api.openFolder(one.id)) });
      items.push("separator");
    }
    if (ds.some((d) => d.status !== "completed" && effective(d, progress.get(d.id)) !== "downloading"))
      items.push({ label: "Start / resume", icon: Play, onClick: () => resume(ds) });
    if (ds.some((d) => effective(d, progress.get(d.id)) === "downloading")) items.push({ label: "Pause", icon: Pause, onClick: () => pause(ds) });
    if (one && one.status !== "completed" && one.kind === "http") items.push({ label: "Fix link…", icon: Wrench, onClick: () => openFix(one) });
    if (ds.every((d) => d.status !== "completed")) {
      if (ds.some((d) => d.queueId != null))
        items.push({ label: "Remove from queue", icon: ListX, onClick: () => run(async () => { for (const d of ds) await api.setQueue(d.id, null); }) });
      else
        items.push({
          label: "Download later (add to queue)",
          icon: ListPlus,
          onClick: () =>
            run(async () => {
              for (const d of ds) await api.setQueue(d.id, queues[0]?.id ?? 1);
              toast("Added to the queue. Start it from the sidebar, or set a schedule.", "ok");
            }),
        });
    }
    items.push({
      label: ds.length > 1 ? "Copy links" : "Copy link",
      icon: Copy,
      onClick: () => navigator.clipboard.writeText(ds.map((d) => d.url).join("\n")).then(() => toast("Copied", "ok")),
    });
    items.push("separator");
    items.push({
      label: ds.length > 1 ? `Delete ${ds.length} downloads…` : "Delete…",
      icon: Trash2,
      danger: true,
      onClick: () => {
        setSelected(new Set(ids));
        setDialog("delete");
      },
    });
    return items;
  };

  const queueOfFilter = filter.kind === "queue" ? queues.find((q) => q.id === filter.id) : undefined;
  const title =
    filter.kind === "status" ? STATUS_FILTERS.find((s) => s.key === filter.key)!.label : filter.kind === "category" ? category(filter.key).label : queueOfFilter?.name ?? "Queue";
  const connected = browsers.filter((b) => b.connectedAt);

  if (settings && !settings.onboarded) {
    return (
      <Onboarding
        onDone={() => {
          reloadSettings();
          reloadBrowsers();
        }}
      />
    );
  }

  return (
    <div
      className="h-full flex flex-col relative"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/uri-list") || e.dataTransfer.types.includes("text/plain")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        const text = e.dataTransfer.getData("text/uri-list") || e.dataTransfer.getData("text/plain");
        const links = text.split(/\s+/).filter((l) => /^https?:\/\//i.test(l));
        if (links.length === 0) toast("Drop a link from your browser to download it.");
        links.slice(0, 20).forEach(addLink);
      }}
    >
      <Header
        totalSpeed={totalSpeed}
        activeCount={active.length}
        onAdd={addLink}
        onPauseAll={() => run(api.pauseAll)}
        onSettings={() => {
          setSettingsTab(undefined);
          setDialog("settings");
        }}
        onScheduler={() => setDialog("scheduler")}
      />
      <ClipboardHint knownUrls={all.map((d) => d.url)} onAdd={addLink} />

      <div className="flex-1 flex min-h-0">
        <nav className="w-[228px] shrink-0 flex flex-col px-3 pb-3 pt-1 overflow-auto" aria-label="Filters">
          <div className="space-y-0.5">
            {STATUS_FILTERS.map((s) => (
              <NavItem
                key={s.key}
                icon={s.icon}
                label={s.label}
                count={counts[s.key]}
                active={filter.kind === "status" && filter.key === s.key}
                warn={s.key === "failed" && (counts.failed ?? 0) > 0}
                onClick={() => setFilter({ kind: "status", key: s.key })}
              />
            ))}
          </div>
          <SectionLabel>File types</SectionLabel>
          <div className="space-y-0.5">
            {CATEGORIES.map((c) => (
              <NavItem
                key={c.key}
                icon={c.icon}
                label={c.label}
                count={counts[`cat:${c.key}`]}
                active={filter.kind === "category" && filter.key === c.key}
                onClick={() => setFilter({ kind: "category", key: c.key })}
              />
            ))}
          </div>
          <SectionLabel action={<IconButton icon={CalendarClock} label="Queues and schedule" className="size-6" onClick={() => setDialog("scheduler")} />}>
            Queues
          </SectionLabel>
          <div className="space-y-0.5">
            {queues.map((q) => (
              <NavItem
                key={q.id}
                icon={ListOrdered}
                label={q.name}
                count={counts[`q:${q.id}`]}
                active={filter.kind === "queue" && filter.id === q.id}
                badge={q.running ? <span className="size-2 rounded-full bg-ok" title="Running" /> : undefined}
                onClick={() => setFilter({ kind: "queue", id: q.id })}
              />
            ))}
          </div>

          <div className="mt-auto pt-3">
            <button
              onClick={() => api.openBrowserSetupWindow()}
              className={`w-full text-left rounded-xl border px-3 py-2.5 cursor-pointer transition-colors ${
                connected.length ? "border-line bg-surface hover:bg-hover" : "border-warn/40 bg-warn-soft hover:brightness-[0.98]"
              }`}
            >
              <div className="flex items-center gap-2 font-medium">
                <Puzzle size={15} className={connected.length ? "text-ok" : "text-warn"} />
                {connected.length ? "Browser connected" : "Connect your browser"}
              </div>
              <div className="text-[12px] text-muted mt-0.5 leading-snug">
                {connected.length
                  ? connected.map((b) => b.name.replace(/^(Google|Microsoft|Mozilla) /, "")).join(", ")
                  : "So downloads and videos open here automatically."}
              </div>
            </button>
          </div>
        </nav>

        <main className="flex-1 min-w-0 flex flex-col bg-surface border-l border-t border-line rounded-tl-2xl">
          <div className="flex items-center gap-3 px-5 pt-4 pb-3">
            <h1 className="text-[17px] font-semibold font-[family-name:var(--font-display)] truncate">{title}</h1>
            <span className="text-muted tabular-nums">{visible.length}</span>
            {queueOfFilter && (
              <Button
                size="sm"
                variant={queueOfFilter.running ? "secondary" : "primary"}
                icon={queueOfFilter.running ? Pause : Play}
                onClick={() => run(() => (queueOfFilter.running ? api.stopQueue(queueOfFilter.id) : api.startQueue(queueOfFilter.id)))}
              >
                {queueOfFilter.running ? "Stop queue" : "Start queue"}
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <div className="flex items-center gap-2 h-8 px-2.5 rounded-lg border border-line bg-surface-2 focus-within:border-accent w-[220px]">
                <Search size={14} className="text-faint" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search downloads"
                  aria-label="Search downloads"
                  className="flex-1 min-w-0 bg-transparent outline-none text-[13px]"
                />
                {query && (
                  <button aria-label="Clear search" onClick={() => setQuery("")} className="text-faint hover:text-fg cursor-pointer">
                    <X size={14} />
                  </button>
                )}
              </div>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                aria-label="Sort"
                className="h-8 px-2 rounded-lg border border-line bg-surface-2 text-[13px] cursor-pointer outline-none"
              >
                <option value="newest">Newest first</option>
                <option value="name">Name</option>
                <option value="size">Largest first</option>
              </select>
            </div>
          </div>

          {selected.size > 1 && (
            <div className="anim-fade-up mx-5 mb-2 flex items-center gap-2 px-3 h-11 rounded-xl bg-accent-soft">
              <span className="font-medium text-accent">{selected.size} selected</span>
              <div className="ml-auto flex gap-1.5">
                <Button size="sm" icon={Play} onClick={() => resume(sel)}>Resume</Button>
                <Button size="sm" icon={Pause} onClick={() => pause(sel)}>Pause</Button>
                <Button size="sm" icon={Trash2} onClick={() => setDialog("delete")}>Delete</Button>
                <IconButton icon={X} label="Clear selection" onClick={() => setSelected(new Set())} />
              </div>
            </div>
          )}

          <div className="flex-1 overflow-auto px-5 pb-5" onClick={(e) => e.target === e.currentTarget && setSelected(new Set())}>
            {visible.length === 0 ? (
              all.length === 0 ? (
                <WelcomeEmpty connected={connected.length > 0} />
              ) : (
                <div className="text-center text-muted mt-20">
                  <Search size={28} className="mx-auto mb-2 text-faint" />
                  {query ? `Nothing matches “${query}”.` : "Nothing here right now."}
                </div>
              )
            ) : (
              <div className="space-y-2">
                {visible.map((d) => (
                  <DownloadCard
                    key={d.id}
                    d={d}
                    p={progress.get(d.id)}
                    queue={queues.find((q) => q.id === d.queueId)}
                    selected={selected.has(d.id)}
                    onClick={(e) => onCardClick(e, d.id)}
                    onMenu={(x, y) => {
                      const ids = selected.has(d.id) && selected.size > 1 ? [...selected] : [d.id];
                      if (!selected.has(d.id)) setSelected(new Set([d.id]));
                      setMenu({ x, y, ids });
                    }}
                    onResume={() => resume([d])}
                    onPause={() => pause([d])}
                    onOpen={() => run(() => api.openFile(d.id))}
                    onFolder={() => run(() => api.openFolder(d.id))}
                    onFix={() => openFix(d)}
                    onSettings={() => {
                      setSettingsTab("videos");
                      setDialog("settings");
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        </main>
      </div>

      {dragging && (
        <div className="absolute inset-3 z-40 rounded-2xl border-2 border-dashed border-accent bg-accent-soft/85 grid place-items-center pointer-events-none">
          <div className="text-center text-accent">
            <DownloadIcon size={36} className="mx-auto mb-2" />
            <div className="text-[16px] font-semibold">Drop the link to download it</div>
          </div>
        </div>
      )}

      {menu && <Menu anchor={menu} items={menuItems(menu.ids)} onClose={() => setMenu(null)} />}
      {dialog === "settings" && (
        <SettingsDialog
          initialTab={settingsTab}
          onClose={() => {
            setDialog(null);
            reloadSettings();
            reloadBrowsers();
          }}
        />
      )}
      {dialog === "scheduler" && <SchedulerDialog queues={queues} onChanged={reloadQueues} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog items={sel} onClose={() => setDialog(null)} onError={(e) => toast(e, "error")} />}
      {dialog === "fix" && fixTarget && <FixLinkDialog item={fixTarget} onClose={() => setDialog(null)} onError={(e) => toast(e, "error")} />}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  totalSpeed,
  activeCount,
  onAdd,
  onPauseAll,
  onSettings,
  onScheduler,
}: {
  totalSpeed: number;
  activeCount: number;
  onAdd: (url: string) => boolean;
  onPauseAll: () => void;
  onSettings: () => void;
  onScheduler: () => void;
}) {
  const [url, setUrl] = useState("");
  const submit = () => {
    if (url.trim() && onAdd(url)) setUrl("");
  };
  return (
    <header className="flex items-center gap-4 px-4 h-[62px] shrink-0">
      <div className="flex items-center gap-2.5 w-[200px] shrink-0 pl-1">
        <Logo size={34} className="drop-shadow-sm" />
        <span className="text-[16px] font-semibold font-[family-name:var(--font-display)]">OurIDM</span>
      </div>
      <form
        className="flex-1 max-w-[720px] flex items-center gap-2 h-10 pl-3 pr-1 rounded-xl border border-line-strong bg-surface shadow-[var(--shadow-card)] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15 transition-shadow"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Link2 size={16} className="text-faint shrink-0" />
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a download link here…"
          aria-label="Download link"
          className="flex-1 min-w-0 bg-transparent outline-none text-[14px] placeholder:text-faint"
        />
        <Button type="submit" variant="primary" size="sm" icon={Plus} className="h-8 px-3" disabled={!url.trim()}>
          Download
        </Button>
      </form>
      <div className="ml-auto flex items-center gap-1">
        {activeCount > 0 && (
          <>
            <Badge tone="accent" icon={ArrowDownCircle}>{fmtSpeed(totalSpeed) || "starting…"}</Badge>
            <IconButton icon={PauseCircle} label="Pause all downloads" onClick={onPauseAll} />
          </>
        )}
        <IconButton icon={CalendarClock} label="Queues and schedule" onClick={onScheduler} />
        <IconButton icon={SettingsIcon} label="Settings" onClick={onSettings} />
      </div>
    </header>
  );
}

/** Offers the link on the clipboard whenever the window gets focus. */
function ClipboardHint({ knownUrls, onAdd }: { knownUrls: string[]; onAdd: (url: string) => boolean }) {
  const [link, setLink] = useState<string | null>(null);
  const dismissed = useRef(new Set<string>());
  const known = useRef(knownUrls);
  known.current = knownUrls;
  useEffect(() => {
    const check = () =>
      api
        .clipboardLink()
        .then((l) => setLink(l && !dismissed.current.has(l) && !known.current.includes(l) ? l : null))
        .catch(() => {});
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);
  if (!link || known.current.includes(link)) return null;
  const close = () => {
    dismissed.current.add(link);
    setLink(null);
  };
  return (
    <div className="anim-fade-up mb-2 ml-[244px] mr-4 max-w-[720px] flex items-center gap-3 px-3 h-10 rounded-xl bg-accent-soft text-[13px]">
      <ClipboardPaste size={16} className="text-accent shrink-0" />
      <span className="text-muted shrink-0">You copied a link:</span>
      <span className="truncate font-medium" title={link}>{link}</span>
      <Button
        size="sm"
        variant="primary"
        className="ml-auto"
        onClick={() => {
          onAdd(link);
          close();
        }}
      >
        Download it
      </Button>
      <IconButton icon={X} label="Dismiss" className="size-7" onClick={close} />
    </div>
  );
}

function SectionLabel({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between pt-4 pb-1 px-2.5">
      <span className="text-[11px] font-semibold uppercase tracking-wider text-faint">{children}</span>
      {action}
    </div>
  );
}

function NavItem({
  icon: Icon,
  label,
  count,
  active,
  warn,
  badge,
  onClick,
}: {
  icon: typeof Layers;
  label: string;
  count?: number;
  active: boolean;
  warn?: boolean;
  badge?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`w-full flex items-center gap-2.5 h-8 px-2.5 rounded-lg text-left cursor-pointer transition-colors duration-150 ${
        active ? "bg-surface shadow-[var(--shadow-card)] font-medium" : "hover:bg-hover"
      }`}
    >
      <Icon size={17} className={warn ? "text-danger" : active ? "text-accent" : "text-muted"} />
      <span className="flex-1 truncate">{label}</span>
      {badge}
      {!!count && <span className={`text-[12px] tabular-nums ${warn ? "text-danger font-semibold" : "text-faint"}`}>{count}</span>}
    </button>
  );
}

function DownloadCard({
  d,
  p,
  queue,
  selected,
  onClick,
  onMenu,
  onResume,
  onPause,
  onOpen,
  onFolder,
  onFix,
  onSettings,
}: {
  d: Download;
  p?: Progress;
  queue?: Queue;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onMenu: (x: number, y: number) => void;
  onResume: () => void;
  onPause: () => void;
  onOpen: () => void;
  onFolder: () => void;
  onFix: () => void;
  onSettings: () => void;
}) {
  const st = effective(d, p);
  const live = st === "downloading" || st === "probing";
  const downloaded = live ? p?.downloaded ?? d.downloaded : d.downloaded;
  const total = (live ? p?.total : null) ?? d.size;
  const pc = percent(downloaded, total);
  const err = st === "failed" ? describeError(d.error) : null;

  let line: React.ReactNode;
  let tone: "accent" | "ok" | "warn" | "danger" | "muted" = "accent";
  if (st === "probing") line = "Connecting…";
  else if (st === "downloading") {
    line = p?.phase ? (
      "Finishing up (joining audio and video)…"
    ) : (
      <>
        <span className="text-fg font-medium tabular-nums">{fmtSpeed(p?.speed ?? 0) || "Starting…"}</span>
        {p?.etaSecs != null && <span> · {fmtEtaFriendly(p.etaSecs)}</span>}
        <span className="tabular-nums"> · {fmtBytes(downloaded)}{total ? ` of ${fmtBytes(total)}` : ""}</span>
      </>
    );
  } else if (st === "completed") {
    tone = "ok";
    line = (
      <>
        <CheckCircle2 size={13} className="inline -mt-0.5 mr-1 text-ok" />
        Saved to {d.destDir.split("\\").slice(-2).join("\\")} · {fmtRelative(d.completedAt ?? d.lastTryAt)}
      </>
    );
  } else if (st === "failed") {
    tone = "danger";
    line = (
      <span className="text-danger">
        <AlertCircle size={13} className="inline -mt-0.5 mr-1" />
        {err!.text}
      </span>
    );
  } else if (st === "queued") {
    tone = "muted";
    line = <>Waiting in {queue ? `“${queue.name}”` : "the queue"}{pc ? ` · ${pc.toFixed(0)}% done` : ""}</>;
  } else {
    tone = "warn";
    line = pc ? <>Paused · {pc.toFixed(0)}% done ({fmtBytes(downloaded)} of {fmtBytes(total)})</> : "Not started yet";
  }

  return (
    <div
      onClick={onClick}
      onDoubleClick={() => (st === "completed" ? onOpen() : live ? undefined : onResume())}
      onContextMenu={(e) => {
        e.preventDefault();
        onMenu(e.clientX, e.clientY);
      }}
      className={`group flex items-center gap-3.5 px-3.5 py-3 rounded-[var(--radius-card)] border transition-colors duration-150 cursor-default ${
        selected ? "border-accent/50 bg-selected" : "border-line bg-surface hover:border-line-strong hover:bg-surface-2"
      }`}
      title={d.url}
    >
      <FileTile categoryKey={d.category} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium truncate">{d.fileName}</span>
          {d.kind === "video" && <Badge>Video</Badge>}
          {total != null && <span className="ml-auto text-[12.5px] text-faint tabular-nums shrink-0">{fmtBytes(total)}</span>}
        </div>
        <div className="text-[12.5px] text-muted truncate mt-0.5">{line}</div>
        {st !== "completed" && st !== "failed" && (
          <div className="mt-2 flex items-center gap-2.5">
            <div className="flex-1">
              <ProgressBar value={st === "probing" ? null : pc} tone={tone} animated={live && !!pc} />
            </div>
            {pc != null && <span className="text-[12px] text-muted tabular-nums w-9 text-right">{pc.toFixed(0)}%</span>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        {st === "completed" ? (
          <>
            <Button size="sm" onClick={onOpen}>Open</Button>
            <IconButton icon={FolderOpen} label="Show in folder" onClick={onFolder} />
          </>
        ) : live ? (
          <IconButton icon={Pause} label="Pause" tone="accent" onClick={onPause} />
        ) : err?.action === "fix-link" ? (
          <Button size="sm" variant="primary" icon={Wrench} onClick={onFix}>Fix link</Button>
        ) : err?.action === "settings" ? (
          <Button size="sm" onClick={onSettings}>Open settings</Button>
        ) : st === "failed" ? (
          <Button size="sm" icon={RotateCcw} onClick={onResume}>Try again</Button>
        ) : (
          <IconButton icon={Play} label={pc ? "Resume" : "Start"} tone="accent" onClick={onResume} />
        )}
        <IconButton
          icon={MoreHorizontal}
          label="More actions"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            onMenu(r.right - 240, r.bottom + 4);
          }}
        />
      </div>
    </div>
  );
}

function WelcomeEmpty({ connected }: { connected: boolean }) {
  return (
    <div className="anim-fade-up max-w-[560px] mx-auto mt-10 text-center">
      <Logo size={64} className="mx-auto mb-4 drop-shadow-md" />
      <h2 className="text-[19px] font-semibold font-[family-name:var(--font-display)]">Your downloads will appear here</h2>
      <p className="text-muted mt-1">Three easy ways to start:</p>
      <div className="mt-5 grid gap-2.5 text-left">
        <Tip n={1} title="Paste a link" text={<>Put any download link in the box at the top, or press <Kbd>Ctrl</Kbd> + <Kbd>V</Kbd> in this window.</>} />
        <Tip
          n={2}
          title="Download from your browser"
          text={
            connected
              ? "Click any download link, or use the “Download this video” button on web videos. OurIDM takes it from there."
              : "Connect your browser once, and downloads and web videos open in OurIDM automatically."
          }
          action={!connected ? <Button size="sm" variant="primary" icon={Puzzle} onClick={() => api.openBrowserSetupWindow()}>Connect browser</Button> : undefined}
        />
        <Tip n={3} title="Copy a link anywhere" text="When you copy a link to a file, OurIDM offers to download it." />
      </div>
    </div>
  );
}

function Tip({ n, title, text, action }: { n: number; title: string; text: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex gap-3 items-start p-3.5 rounded-xl border border-line bg-surface-2">
      <span className="size-6 shrink-0 rounded-full bg-accent text-on-accent grid place-items-center text-[12px] font-semibold">{n}</span>
      <div className="flex-1">
        <div className="font-medium">{title}</div>
        <div className="text-muted text-[12.5px] mt-0.5">{text}</div>
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

function DeleteDialog({ items, onClose, onError }: { items: Download[]; onClose: () => void; onError: (e: string) => void }) {
  const [withFile, setWithFile] = useState(false);
  if (items.length === 0) return null;
  const unfinished = items.filter((d) => d.status !== "completed").length;
  const go = async () => {
    try {
      for (const d of items) await api.remove(d.id, withFile);
    } catch (e) {
      onError(String(e));
    }
    onClose();
  };
  return (
    <Modal
      title={items.length === 1 ? "Remove this download?" : `Remove ${items.length} downloads?`}
      icon={Trash2}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={withFile ? "danger" : "primary"} onClick={go}>{withFile ? "Remove and delete files" : "Remove from list"}</Button>
        </>
      }
    >
      <p className="text-muted mb-3">
        {items.length === 1 ? <b className="text-fg">{items[0]!.fileName}</b> : `${items.length} items`} will be removed from OurIDM.
        {unfinished > 0 && " Unfinished parts are cleaned up."}
      </p>
      <Check checked={withFile} onChange={setWithFile} label="Also delete the downloaded file from my computer" />
    </Modal>
  );
}

function FixLinkDialog({ item, onClose, onError }: { item: Download; onClose: () => void; onError: (e: string) => void }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    api.clipboardLink().then((l) => l && l !== item.url && setUrl(l));
  }, [item.url]);
  const go = async () => {
    try {
      await api.refreshAddress(item.id, url.trim());
      await api.start(item.id);
    } catch (e) {
      onError(String(e));
    }
    onClose();
  };
  return (
    <Modal
      title="Fix the download link"
      subtitle="Everything downloaded so far is kept"
      icon={Wrench}
      width={560}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!/^https?:\/\//i.test(url.trim())} onClick={go}>Update link and continue</Button>
        </>
      }
    >
      <ol className="space-y-1.5 mb-4 text-muted list-decimal pl-5">
        <li>Go back to the web page where you got <b className="text-fg">{item.fileName}</b>.</li>
        <li>Start the download again (sign in first if the site needs it).</li>
        <li>Copy the new download link and paste it below.</li>
      </ol>
      <TextInput autoFocus className="w-full" placeholder="https://…" aria-label="New link" value={url} onChange={(e) => setUrl(e.target.value)} />
    </Modal>
  );
}

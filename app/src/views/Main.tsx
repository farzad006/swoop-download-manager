import { useCallback, useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Archive,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clapperboard,
  FileText,
  Folder,
  ListOrdered,
  Music,
  Package,
  Pause,
  PauseOctagon,
  Play,
  PlayCircle,
  Plus,
  Settings as SettingsIcon,
  SquareStop,
  Trash2,
  Eraser,
  Layers,
} from "lucide-react";
import { api, Download, fmtBytes, fmtDate, fmtEta, fmtSpeed, percent, Progress, Queue } from "../api";
import { Button, Check, Modal, TextInput } from "../components/ui";
import { OptionsDialog } from "./Options";
import { SchedulerDialog } from "./Scheduler";

type Filter = { kind: "all" } | { kind: "category"; name: string } | { kind: "unfinished" } | { kind: "finished" } | { kind: "queue"; id: number };
type SortKey = "fileName" | "size" | "status" | "eta" | "speed" | "lastTry" | "description";

const CATEGORY_ICONS: Record<string, typeof Folder> = {
  Compressed: Archive,
  Documents: FileText,
  Music: Music,
  Programs: Package,
  Video: Clapperboard,
  General: Folder,
};

function statusText(d: Download, p?: Progress): string {
  const st = p?.status ?? d.status;
  switch (st) {
    case "completed":
      return "Complete";
    case "failed":
      return "Error";
    case "queued":
      return "Queued";
    case "probing":
      return "Connecting…";
    case "downloading": {
      if (p?.phase) return p.phase;
      const pc = percent(p?.downloaded ?? d.downloaded, p?.total ?? d.size);
      return pc == null ? "Receiving data…" : `${pc.toFixed(2)}%`;
    }
    default: {
      const pc = percent(d.downloaded, d.size);
      return pc == null || pc === 0 ? "Stopped" : `${pc.toFixed(2)}% (stopped)`;
    }
  }
}

export default function Main() {
  const [downloads, setDownloads] = useState<Map<number, Download>>(new Map());
  const [progress, setProgress] = useState<Map<number, Progress>>(new Map());
  const [queues, setQueues] = useState<Queue[]>([]);
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "lastTry", asc: false });
  const [dialog, setDialog] = useState<null | "add" | "options" | "scheduler" | "delete" | "refresh">(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadQueues = useCallback(() => api.queues().then(setQueues), []);

  useEffect(() => {
    api.list().then((l) => setDownloads(new Map(l.map((d) => [d.id, d]))));
    reloadQueues();
    const un = [
      listen<Download>("download-updated", (e) =>
        setDownloads((m) => new Map(m).set(e.payload.id, e.payload)),
      ),
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
    ];
    return () => un.forEach((p) => p.then((f) => f()));
  }, [reloadQueues]);

  const visible = useMemo(() => {
    let list = [...downloads.values()];
    list = list.filter((d) => {
      switch (filter.kind) {
        case "all":
          return true;
        case "category":
          return d.category === filter.name;
        case "unfinished":
          return d.status !== "completed";
        case "finished":
          return d.status === "completed";
        case "queue":
          return d.queueId === filter.id;
      }
    });
    const key = (d: Download): string | number => {
      const p = progress.get(d.id);
      switch (sort.key) {
        case "fileName":
          return d.fileName.toLowerCase();
        case "size":
          return d.size ?? 0;
        case "status":
          return percent(d.downloaded, d.size) ?? 0;
        case "eta":
          return p?.etaSecs ?? Infinity;
        case "speed":
          return p?.speed ?? 0;
        case "lastTry":
          return d.lastTryAt ?? d.addedAt;
        case "description":
          return d.description.toLowerCase();
      }
    };
    list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.asc ? 1 : -1);
    });
    return list;
  }, [downloads, progress, filter, sort]);

  const sel = [...selected].map((id) => downloads.get(id)).filter((d): d is Download => !!d);
  const active = [...progress.values()].filter((p) => p.status === "downloading" || p.status === "probing");
  const totalSpeed = active.reduce((s, p) => s + p.speed, 0);

  const run = (f: () => Promise<unknown>) => f().catch((e) => setError(String(e)));

  const onRowClick = (e: React.MouseEvent, id: number) => {
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

  const onRowDouble = (d: Download) =>
    run(() => (d.status === "completed" ? api.openFile(d.id) : api.start(d.id)));

  const resumeSel = () => run(async () => { for (const d of sel) if (d.status !== "completed") await api.start(d.id); });
  const stopSel = () => run(async () => { for (const d of sel) await api.pause(d.id); });

  const runningQueue = filter.kind === "queue" ? filter.id : 1;
  const queueRunning = queues.find((q) => q.id === runningQueue)?.running ?? false;

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of downloads.values()) c[d.category] = (c[d.category] ?? 0) + 1;
    return c;
  }, [downloads]);

  const isSel = (f: Filter) => JSON.stringify(f) === JSON.stringify(filter);
  const navItem = (f: Filter, label: string, Icon: typeof Folder, count?: number, indent = false) => (
    <button
      key={label}
      onClick={() => setFilter(f)}
      className={`w-full flex items-center gap-2 h-7 rounded-md text-left cursor-pointer transition-colors ${indent ? "pl-7" : "pl-2"} pr-2 ${
        isSel(f) ? "bg-selected font-medium" : "hover:bg-hover"
      }`}
    >
      <Icon size={15} className="shrink-0 text-muted" />
      <span className="truncate flex-1">{label}</span>
      {count != null && count > 0 && <span className="text-[11px] text-muted">{count}</span>}
    </button>
  );

  const tool = (label: string, Icon: typeof Folder, onClick: () => void, disabled = false) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-center justify-center gap-0.5 w-[74px] h-[54px] rounded-md hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default transition-colors"
    >
      <Icon size={22} strokeWidth={1.6} className="text-accent" />
      <span className="text-[12px] leading-tight">{label}</span>
    </button>
  );

  const col = (key: SortKey, label: string, cls: string) => (
    <th className={`font-normal text-muted text-left px-2 h-8 border-b border-line ${cls}`}>
      <button
        className="w-full text-left cursor-pointer hover:text-fg"
        onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : true }))}
      >
        {label}
        {sort.key === key ? (sort.asc ? " ▴" : " ▾") : ""}
      </button>
    </th>
  );

  return (
    <div className="h-full flex flex-col" onClick={() => setMenu(null)}>
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 px-2 py-1 bg-surface border-b border-line">
        {tool("Add URL", Plus, () => setDialog("add"))}
        {tool("Resume", Play, resumeSel, !sel.some((d) => d.status !== "completed"))}
        {tool("Stop", Pause, stopSel, sel.length === 0)}
        {tool("Stop All", PauseOctagon, () => run(api.pauseAll), active.length === 0)}
        {tool("Delete", Trash2, () => setDialog("delete"), sel.length === 0)}
        {tool("Delete Co…", Eraser, () => run(api.removeCompleted))}
        <div className="w-px h-10 bg-line mx-1" />
        {tool("Options", SettingsIcon, () => setDialog("options"))}
        {tool("Scheduler", CalendarClock, () => setDialog("scheduler"))}
        {tool("Start Qu…", PlayCircle, () => run(() => api.startQueue(runningQueue)), queueRunning)}
        {tool("Stop Qu…", SquareStop, () => run(() => api.stopQueue(runningQueue)), !queueRunning)}
      </div>

      <div className="flex-1 flex min-h-0">
        {/* Categories */}
        <nav className="w-[210px] shrink-0 bg-surface-2 border-r border-line p-2 overflow-auto space-y-0.5" aria-label="Categories">
          {navItem({ kind: "all" }, "All Downloads", Layers, downloads.size)}
          {["Compressed", "Documents", "Music", "Programs", "Video", "General"].map((c) =>
            navItem({ kind: "category", name: c }, c, CATEGORY_ICONS[c], counts[c], true),
          )}
          {navItem({ kind: "unfinished" }, "Unfinished", CircleDashed, [...downloads.values()].filter((d) => d.status !== "completed").length)}
          {navItem({ kind: "finished" }, "Finished", CheckCircle2, [...downloads.values()].filter((d) => d.status === "completed").length)}
          <div className="pt-2 pb-1 px-2 text-[11px] uppercase tracking-wide text-muted">Queues</div>
          {queues.map((q) =>
            navItem({ kind: "queue", id: q.id }, q.name + (q.running ? " (running)" : ""), ListOrdered, [...downloads.values()].filter((d) => d.queueId === q.id && d.status !== "completed").length),
          )}
        </nav>

        {/* Table */}
        <div className="flex-1 overflow-auto bg-surface">
          <table className="w-full border-collapse table-fixed">
            <thead className="sticky top-0 bg-surface z-10">
              <tr>
                {col("fileName", "File Name", "w-[32%]")}
                {col("size", "Size", "w-[9%]")}
                {col("status", "Status", "w-[13%]")}
                {col("eta", "Time left", "w-[10%]")}
                {col("speed", "Transfer rate", "w-[10%]")}
                {col("lastTry", "Last Try Date", "w-[11%]")}
                {col("description", "Description", "")}
              </tr>
            </thead>
            <tbody>
              {visible.map((d) => {
                const p = progress.get(d.id);
                const running = p && (p.status === "downloading" || p.status === "probing");
                const Icon = CATEGORY_ICONS[d.category] ?? Folder;
                const st = statusText(d, running ? p : undefined);
                const failed = d.status === "failed";
                return (
                  <tr
                    key={d.id}
                    onClick={(e) => onRowClick(e, d.id)}
                    onDoubleClick={() => onRowDouble(d)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (!selected.has(d.id)) setSelected(new Set([d.id]));
                      setMenu({ x: e.clientX, y: e.clientY });
                    }}
                    className={`h-7 cursor-default ${selected.has(d.id) ? "bg-selected" : "hover:bg-hover"}`}
                    title={d.error ?? d.url}
                  >
                    <td className="px-2 truncate">
                      <span className="inline-flex items-center gap-2 min-w-0 max-w-full">
                        <Icon size={15} className={`shrink-0 ${d.status === "completed" ? "text-ok" : "text-muted"}`} />
                        <span className="truncate">{d.fileName}</span>
                      </span>
                    </td>
                    <td className="px-2 truncate">{fmtBytes(p?.total ?? d.size)}</td>
                    <td className={`px-2 truncate ${failed ? "text-danger" : ""}`}>{st}</td>
                    <td className="px-2 truncate">{running ? fmtEta(p?.etaSecs) : ""}</td>
                    <td className="px-2 truncate">{running ? fmtSpeed(p?.speed ?? 0) : ""}</td>
                    <td className="px-2 truncate">{fmtDate(d.lastTryAt ?? d.addedAt)}</td>
                    <td className="px-2 truncate text-muted">{failed ? d.error : d.description}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && (
            <div className="text-center text-muted mt-16">
              No downloads here yet. Use <b>Add URL</b>, copy a link, or click a download in your browser.
            </div>
          )}
        </div>
      </div>

      {/* Status bar */}
      <div className="h-6 px-3 flex items-center gap-4 text-[12px] text-muted bg-surface-2 border-t border-line">
        <span>{downloads.size} downloads</span>
        <span>{active.length} active</span>
        {totalSpeed > 0 && <span>{fmtSpeed(totalSpeed)}</span>}
        {error && (
          <button className="ml-auto text-danger truncate cursor-pointer" onClick={() => setError(null)} title="Dismiss">
            {error}
          </button>
        )}
      </div>

      {menu && sel.length > 0 && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ["Open", () => run(() => api.openFile(sel[0].id)), sel[0].status === "completed"],
            ["Open folder", () => run(() => api.openFolder(sel[0].id)), true],
            null,
            ["Resume download", resumeSel, sel.some((d) => d.status !== "completed")],
            ["Stop download", stopSel, true],
            ["Refresh download address…", () => setDialog("refresh"), sel.length === 1 && sel[0].kind === "http" && sel[0].status !== "completed"],
            null,
            ...queues.map(
              (q) =>
                [`Move to "${q.name}"`, () => run(async () => { for (const d of sel) await api.setQueue(d.id, q.id); }), true] as MenuItem,
            ),
            ["Remove from queue", () => run(async () => { for (const d of sel) await api.setQueue(d.id, null); }), sel.some((d) => d.queueId != null)],
            null,
            ["Copy address", () => navigator.clipboard.writeText(sel.map((d) => d.url).join("\n")), true],
            ["Delete…", () => setDialog("delete"), true],
          ]}
        />
      )}

      {dialog === "add" && <AddUrlDialog onClose={() => setDialog(null)} />}
      {dialog === "options" && <OptionsDialog onClose={() => setDialog(null)} />}
      {dialog === "scheduler" && <SchedulerDialog queues={queues} onChanged={reloadQueues} onClose={() => setDialog(null)} />}
      {dialog === "delete" && <DeleteDialog items={sel} onClose={() => setDialog(null)} onError={setError} />}
      {dialog === "refresh" && sel[0] && <RefreshDialog item={sel[0]} onClose={() => setDialog(null)} onError={setError} />}
    </div>
  );
}

type MenuItem = [string, () => void, boolean] | null;

function ContextMenu({ x, y, items }: { x: number; y: number; items: MenuItem[] }) {
  const top = Math.min(y, window.innerHeight - items.length * 28 - 16);
  const left = Math.min(x, window.innerWidth - 260);
  return (
    <div
      role="menu"
      className="fixed z-50 w-[250px] bg-surface border border-line rounded-lg shadow-xl py-1"
      style={{ top, left }}
    >
      {items.map((it, i) =>
        it === null ? (
          <div key={i} className="h-px bg-line my-1" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={!it[2]}
            onClick={it[1]}
            className="w-full text-left h-7 px-3 hover:bg-hover disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
          >
            {it[0]}
          </button>
        ),
      )}
    </div>
  );
}

function AddUrlDialog({ onClose }: { onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    navigator.clipboard
      .readText()
      .then((t) => /^https?:\/\//i.test(t.trim()) && setUrl(t.trim()))
      .catch(() => {});
  }, []);
  const submit = async () => {
    try {
      new URL(url.trim());
    } catch {
      setErr("Enter a valid http(s) address.");
      return;
    }
    await api.captureUrl(url.trim());
    onClose();
  };
  return (
    <Modal
      title="Enter new address to download"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={submit}>OK</Button>
        </>
      }
    >
      <TextInput
        autoFocus
        className="w-full"
        placeholder="https://example.com/file.zip"
        aria-label="Address"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setErr(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && submit()}
      />
      {err && <div className="text-danger text-[12px] mt-1">{err}</div>}
    </Modal>
  );
}

function DeleteDialog({ items, onClose, onError }: { items: Download[]; onClose: () => void; onError: (e: string) => void }) {
  const [withFile, setWithFile] = useState(false);
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
      title="Delete downloads"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary onClick={go}>Delete</Button>
        </>
      }
    >
      <p className="mb-2">
        Remove {items.length === 1 ? <b>{items[0].fileName}</b> : `${items.length} downloads`} from the list?
      </p>
      <Check checked={withFile} onChange={setWithFile} label="Also delete the downloaded file(s) from disk" />
    </Modal>
  );
}

function RefreshDialog({ item, onClose, onError }: { item: Download; onClose: () => void; onError: (e: string) => void }) {
  const [url, setUrl] = useState("");
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
      title="Refresh download address"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button primary disabled={!/^https?:\/\//i.test(url.trim())} onClick={go}>Update and resume</Button>
        </>
      }
    >
      <p className="mb-2 text-muted">
        The link for <b className="text-fg">{item.fileName}</b> may have expired. Start the download again in your browser,
        copy its new address and paste it here. Already-downloaded data is kept.
      </p>
      <TextInput autoFocus className="w-full" aria-label="New address" value={url} onChange={(e) => setUrl(e.target.value)} />
    </Modal>
  );
}

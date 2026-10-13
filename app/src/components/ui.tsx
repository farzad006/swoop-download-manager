import { ReactNode, useEffect } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import type { Segment } from "../api";

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean };

export function Button({ primary, className = "", ...p }: BtnProps) {
  const base =
    "h-8 px-4 rounded-md text-[13px] border transition-colors duration-150 cursor-pointer disabled:opacity-50 disabled:cursor-default";
  const look = primary
    ? "bg-accent text-on-accent border-accent hover:bg-accent-hover"
    : "bg-surface text-fg border-line hover:bg-hover";
  return <button {...p} className={`${base} ${look} ${className}`} />;
}

export function TextInput(p: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`h-8 px-2 rounded-md border border-line bg-surface text-fg outline-none focus:border-accent ${p.className ?? ""}`}
    />
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="grid grid-cols-[120px_1fr] items-center gap-2">
      <span className="text-muted">{label}</span>
      <div className="min-w-0">
        {children}
        {hint && <div className="text-[12px] text-muted mt-0.5">{hint}</div>}
      </div>
    </label>
  );
}

export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer py-0.5">
      <input type="checkbox" className="accent-[var(--color-accent)] size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function FolderInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: value || undefined });
    if (typeof dir === "string") onChange(dir);
  };
  return (
    <div className="flex gap-1">
      <TextInput className="flex-1 min-w-0" value={value} onChange={(e) => onChange(e.target.value)} />
      <button
        type="button"
        onClick={browse}
        aria-label="Browse for folder"
        title="Browse"
        className="h-8 w-9 grid place-items-center rounded-md border border-line bg-surface hover:bg-hover cursor-pointer"
      >
        <FolderOpen size={16} />
      </button>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  width = 520,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="bg-surface border border-line rounded-lg shadow-2xl max-h-[90vh] flex flex-col"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="px-4 pt-3 pb-2 font-semibold text-[14px]">{title}</div>
        <div className="px-4 py-2 overflow-auto">{children}</div>
        {footer && <div className="px-4 py-3 flex justify-end gap-2 border-t border-line bg-surface-2 rounded-b-lg">{footer}</div>}
      </div>
    </div>
  );
}

export function ProgressBar({ value }: { value: number | null }) {
  return (
    <div className="h-4 rounded bg-seg-empty overflow-hidden" role="progressbar" aria-valuenow={value ?? undefined}>
      {value == null ? (
        <div className="h-full w-1/3 bg-seg-active animate-pulse" />
      ) : (
        <div className="h-full bg-seg-done transition-[width] duration-300" style={{ width: `${value}%` }} />
      )}
    </div>
  );
}

/** IDM's per-connection bar: each segment's downloaded part, with live
 *  connections drawn lighter at their write position. */
export function SegmentBar({ segments, total }: { segments: Segment[]; total: number | null }) {
  if (!total || segments.length === 0) return <ProgressBar value={null} />;
  return (
    <div className="relative h-5 shrink-0 rounded bg-seg-empty overflow-hidden" aria-label="Connection progress">
      {segments.map((s, i) => {
        const end = Math.min(s.end, total);
        const left = (s.start / total) * 100;
        const done = ((s.pos - s.start) / total) * 100;
        const active = s.pos < end;
        return (
          <div key={i}>
            <div className="absolute top-0 h-full bg-seg-done" style={{ left: `${left}%`, width: `${done}%` }} />
            {active && <div className="absolute top-0 h-full w-[2px] bg-seg-active" style={{ left: `${left + done}%` }} />}
            {i > 0 && <div className="absolute top-0 h-full w-px bg-surface/70" style={{ left: `${left}%` }} />}
          </div>
        );
      })}
    </div>
  );
}

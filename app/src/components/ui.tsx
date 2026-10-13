import { createContext, ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { CheckCircle2, FolderOpen, Info, LucideIcon, TriangleAlert, X } from "lucide-react";
import type { Segment } from "../api";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- buttons ----------
type Variant = "primary" | "secondary" | "ghost" | "danger";
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: "sm" | "md" | "lg";
  icon?: LucideIcon;
  /** @deprecated use variant="primary" */
  primary?: boolean;
};

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:bg-accent-hover shadow-sm",
  secondary: "bg-surface text-fg border-line-strong hover:bg-hover",
  ghost: "bg-transparent text-fg border-transparent hover:bg-hover",
  danger: "bg-danger text-white border-transparent hover:opacity-90",
};

export function Button({ variant, size = "md", icon: Icon, primary, className, children, ...p }: BtnProps) {
  const v = variant ?? (primary ? "primary" : "secondary");
  const sizes = { sm: "h-7 px-2.5 text-[12.5px] gap-1.5", md: "h-9 px-4 gap-2", lg: "h-11 px-5 text-[14.5px] gap-2" };
  return (
    <button
      {...p}
      className={cx(
        "inline-flex items-center justify-center rounded-lg border font-medium transition-colors duration-150 cursor-pointer whitespace-nowrap",
        "disabled:opacity-45 disabled:cursor-default disabled:hover:bg-[inherit]",
        sizes[size],
        VARIANTS[v],
        className,
      )}
    >
      {Icon && <Icon size={size === "sm" ? 14 : 16} strokeWidth={2} />}
      {children}
    </button>
  );
}

export function IconButton({
  icon: Icon,
  label,
  className,
  tone,
  ...p
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; label: string; tone?: "accent" | "danger" }) {
  return (
    <button
      {...p}
      aria-label={label}
      title={label}
      className={cx(
        "size-8 shrink-0 grid place-items-center rounded-lg transition-colors duration-150 cursor-pointer disabled:opacity-40 disabled:cursor-default",
        tone === "accent" ? "text-accent hover:bg-accent-soft" : tone === "danger" ? "text-danger hover:bg-danger-soft" : "text-muted hover:bg-hover hover:text-fg",
        className,
      )}
    >
      <Icon size={17} strokeWidth={2} />
    </button>
  );
}

// ---------- form controls ----------
export function TextInput({ className, ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={cx(
        "h-9 px-3 rounded-lg border border-line-strong bg-surface text-fg outline-none placeholder:text-faint",
        "focus:border-accent focus:ring-3 focus:ring-accent/15 transition-shadow",
        className,
      )}
    />
  );
}

export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...p}
      className={cx("h-9 px-2.5 rounded-lg border border-line-strong bg-surface text-fg outline-none focus:border-accent cursor-pointer", className)}
    >
      {children}
    </select>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 cursor-pointer",
        checked ? "bg-accent" : "bg-line-strong",
      )}
    >
      <span className={cx("absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform duration-200", checked && "translate-x-5")} />
    </button>
  );
}

/** Kept for older call sites: a labelled checkbox. */
export function Check({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2.5 cursor-pointer py-1">
      <input type="checkbox" className="accent-[var(--color-accent)] size-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A settings line: title and explanation on the left, control on the right. */
export function SettingRow({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-6 py-3.5">
      <div className="flex-1 min-w-0">
        <div className="font-medium">{title}</div>
        {description && <div className="text-muted text-[12.5px] mt-0.5">{description}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Stacked form field: label, control, optional hint. */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[12.5px] font-medium text-muted mb-1.5">{label}</span>
      {children}
      {hint && <span className="block text-[12px] text-faint mt-1">{hint}</span>}
    </label>
  );
}

export function FolderInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const browse = async () => {
    const dir = await open({ directory: true, defaultPath: value || undefined });
    if (typeof dir === "string") onChange(dir);
  };
  return (
    <div className="flex gap-2">
      <div className="flex-1 min-w-0 flex items-center gap-2 h-9 px-3 rounded-lg border border-line-strong bg-surface-2">
        <FolderOpen size={15} className="text-faint shrink-0" />
        <input className="flex-1 min-w-0 bg-transparent outline-none" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Folder" />
      </div>
      <Button type="button" onClick={browse}>Change…</Button>
    </div>
  );
}

// ---------- surfaces ----------
export function Modal({
  title,
  subtitle,
  icon: Icon,
  onClose,
  children,
  footer,
  width = 520,
  bodyClass,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  bodyClass?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/35 p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={title}
        className="anim-pop-in bg-surface border border-line rounded-2xl shadow-[var(--shadow-pop)] max-h-full flex flex-col overflow-hidden"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-4 pb-3">
          {Icon && (
            <span className="size-9 rounded-xl bg-accent-soft text-accent grid place-items-center shrink-0">
              <Icon size={18} />
            </span>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-[15.5px] font-[family-name:var(--font-display)]">{title}</div>
            {subtitle && <div className="text-muted text-[12.5px] mt-0.5">{subtitle}</div>}
          </div>
          <IconButton icon={X} label="Close" onClick={onClose} className="-mr-1.5 -mt-0.5" />
        </div>
        <div className={cx("px-5 pb-4 overflow-auto", bodyClass)}>{children}</div>
        {footer && <div className="px-5 py-3 flex justify-end gap-2 border-t border-line bg-surface-2">{footer}</div>}
      </div>
    </div>
  );
}

export function Badge({ tone = "muted", children, icon: Icon }: { tone?: "muted" | "accent" | "ok" | "warn" | "danger"; children: ReactNode; icon?: LucideIcon }) {
  const tones = {
    muted: "bg-sunken text-muted",
    accent: "bg-accent-soft text-accent",
    ok: "bg-ok-soft text-ok",
    warn: "bg-warn-soft text-warn",
    danger: "bg-danger-soft text-danger",
  };
  return (
    <span className={cx("inline-flex items-center gap-1 h-5 px-2 rounded-full text-[11.5px] font-medium whitespace-nowrap", tones[tone])}>
      {Icon && <Icon size={12} strokeWidth={2.4} />}
      {children}
    </span>
  );
}

export type Tone = "accent" | "ok" | "warn" | "danger" | "muted";

export function ProgressBar({ value, tone = "accent", animated, height = 6 }: { value: number | null; tone?: Tone; animated?: boolean; height?: number }) {
  const fill = { accent: "bg-accent", ok: "bg-ok", warn: "bg-amber-400", danger: "bg-danger", muted: "bg-faint" }[tone];
  return (
    <div className="rounded-full bg-seg-empty overflow-hidden" style={{ height }} role="progressbar" aria-valuenow={value ?? undefined} aria-valuemin={0} aria-valuemax={100}>
      {value == null ? (
        <div className={cx("h-full w-full opacity-70", fill, "bar-stripes")} />
      ) : (
        <div className={cx("h-full rounded-full transition-[width] duration-500 ease-out", fill, animated && "bar-stripes")} style={{ width: `${Math.max(value, 1.5)}%` }} />
      )}
    </div>
  );
}

/** Each connection's share of the file, filled as it downloads. */
export function SegmentBar({ segments, total }: { segments: Segment[]; total: number | null }) {
  if (!total || segments.length === 0) return <ProgressBar value={null} height={10} />;
  return (
    <div className="relative h-2.5 shrink-0 rounded-full bg-seg-empty overflow-hidden" aria-label="Progress of each connection">
      {segments.map((s, i) => {
        const end = Math.min(s.end, total);
        const left = (s.start / total) * 100;
        const done = ((s.pos - s.start) / total) * 100;
        return (
          <div key={i}>
            <div className="absolute top-0 h-full bg-seg-done" style={{ left: `${left}%`, width: `${done}%` }} />
            {s.pos < end && <div className="absolute top-0 h-full w-[2px] bg-seg-active" style={{ left: `${left + done}%` }} />}
            {i > 0 && <div className="absolute top-0 h-full w-px bg-surface" style={{ left: `${left}%` }} />}
          </div>
        );
      })}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-block min-w-5 px-1.5 h-5 leading-5 text-center rounded-md border border-line-strong bg-surface-2 text-[11px] font-medium text-muted">{children}</kbd>;
}

// ---------- dropdown menu ----------
export type MenuItem = { label: string; icon?: LucideIcon; onClick: () => void; disabled?: boolean; danger?: boolean } | "separator";

export function Menu({ items, onClose, anchor }: { items: MenuItem[]; onClose: () => void; anchor: { x: number; y: number } }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    setTimeout(() => window.addEventListener("mousedown", down));
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("mousedown", down);
      window.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const h = items.reduce((s, i) => s + (i === "separator" ? 9 : 34), 12);
  const top = Math.max(8, Math.min(anchor.y, window.innerHeight - h - 8));
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - 248));
  return (
    <div ref={ref} role="menu" className="anim-pop-in fixed z-50 w-[240px] p-1.5 bg-surface border border-line rounded-xl shadow-[var(--shadow-pop)]" style={{ top, left }}>
      {items.map((it, i) =>
        it === "separator" ? (
          <div key={i} className="h-px bg-line my-1" />
        ) : (
          <button
            key={i}
            role="menuitem"
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onClick();
            }}
            className={cx(
              "w-full flex items-center gap-2.5 h-[34px] px-2.5 rounded-lg text-left cursor-pointer disabled:opacity-40 disabled:cursor-default",
              it.danger ? "text-danger hover:bg-danger-soft" : "hover:bg-hover",
            )}
          >
            {it.icon && <it.icon size={16} className={it.danger ? "" : "text-muted"} />}
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}

// ---------- toasts ----------
type ToastT = { id: number; text: string; tone: "ok" | "info" | "error" };
const ToastCtx = createContext<(text: string, tone?: ToastT["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastT[]>([]);
  const push = useCallback((text: string, tone: ToastT["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tone === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none" role="status" aria-live="polite">
        {toasts.map((t) => {
          const Icon = t.tone === "ok" ? CheckCircle2 : t.tone === "error" ? TriangleAlert : Info;
          return (
            <div key={t.id} className="anim-fade-up pointer-events-auto flex items-center gap-2.5 max-w-[520px] px-4 py-2.5 rounded-xl bg-fg text-bg shadow-[var(--shadow-pop)]">
              <Icon size={16} className={t.tone === "ok" ? "text-ok" : t.tone === "error" ? "text-danger" : "text-accent"} />
              <span>{t.text}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

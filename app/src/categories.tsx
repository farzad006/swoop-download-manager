import { Archive, Clapperboard, File, FileText, LucideIcon, Music, Package } from "lucide-react";

/** Display info for the backend's categories (keys must match categories.rs). */
export const CATEGORIES: { key: string; label: string; icon: LucideIcon; tile: string }[] = [
  { key: "Video", label: "Videos", icon: Clapperboard, tile: "bg-rose-500/12 text-rose-600 dark:text-rose-400" },
  { key: "Music", label: "Music", icon: Music, tile: "bg-violet-500/12 text-violet-600 dark:text-violet-400" },
  { key: "Documents", label: "Documents", icon: FileText, tile: "bg-sky-500/12 text-sky-600 dark:text-sky-400" },
  { key: "Programs", label: "Programs", icon: Package, tile: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400" },
  { key: "Compressed", label: "Archives", icon: Archive, tile: "bg-amber-500/14 text-amber-700 dark:text-amber-400" },
  { key: "General", label: "Other", icon: File, tile: "bg-slate-500/12 text-slate-600 dark:text-slate-300" },
];

export function category(key: string) {
  return CATEGORIES.find((c) => c.key === key) ?? CATEGORIES[CATEGORIES.length - 1]!;
}

export function FileTile({ categoryKey, size = 40 }: { categoryKey: string; size?: number }) {
  const c = category(categoryKey);
  return (
    <span className={`shrink-0 grid place-items-center rounded-xl ${c.tile}`} style={{ width: size, height: size }} aria-hidden="true">
      <c.icon size={Math.round(size * 0.48)} strokeWidth={1.8} />
    </span>
  );
}

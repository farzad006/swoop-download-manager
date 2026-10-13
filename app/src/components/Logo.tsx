import { useId } from "react";

/** App logo (same artwork as branding/logo.svg). */
export function Logo({ size = 32, className }: { size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const small = size <= 32;
  return (
    <svg viewBox="0 0 1024 1024" width={size} height={size} className={className} aria-hidden="true">
      <defs>
        <linearGradient id={`${id}bg`} x1="0.1" y1="0" x2="0.9" y2="1">
          <stop offset="0" stopColor="#60A5FA" />
          <stop offset="0.5" stopColor="#4F46E5" />
          <stop offset="1" stopColor="#7C3AED" />
        </linearGradient>
        <radialGradient id={`${id}sheen`} cx="0.28" cy="0.12" r="0.9">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.38" />
          <stop offset="0.55" stopColor="#FFFFFF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${id}lane`} x1="0" y1="190" x2="0" y2="560" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.55" />
          <stop offset="1" stopColor="#FFFFFF" />
        </linearGradient>
        <linearGradient id={`${id}streak`} x1="0" y1="200" x2="0" y2="360" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.15" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0.85" />
        </linearGradient>
      </defs>
      <rect x={small ? 0 : 40} y={small ? 0 : 40} width={small ? 1024 : 944} height={small ? 1024 : 944} rx={small ? 220 : 232} fill={`url(#${id}bg)`} />
      {!small && <rect x="40" y="40" width="944" height="944" rx="232" fill={`url(#${id}sheen)`} />}
      <g fill="none" stroke="#FFFFFF" strokeLinecap="round" strokeLinejoin="round" strokeWidth={small ? 124 : 88}>
        {small ? (
          <>
            <path d="M512 170 V 640" />
            <path d="M300 470 L 512 682 L 724 470" />
            <path d="M290 850 H 734" />
          </>
        ) : (
          <>
            <path d="M512 200 V 640" stroke={`url(#${id}lane)`} />
            <path d="M336 476 L 512 652 L 688 476" />
            <path d="M340 214 V 352" stroke={`url(#${id}streak)`} strokeWidth="64" />
            <path d="M684 214 V 352" stroke={`url(#${id}streak)`} strokeWidth="64" />
            <path d="M330 812 H 694" />
          </>
        )}
      </g>
    </svg>
  );
}

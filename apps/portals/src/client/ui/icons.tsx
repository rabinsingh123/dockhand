// Inline SVG icons and fictional brand marks (no external assets).

import type { ReactNode } from "react";

function Svg({
  size = 16,
  children,
  stroke = true,
}: {
  size?: number;
  children: ReactNode;
  stroke?: boolean;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={stroke ? "none" : "currentColor"}
      stroke={stroke ? "currentColor" : "none"}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const IconCheck = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M20 6 9 17l-5-5" />
  </Svg>
);

export const IconAlert = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7.5v5" />
    <path d="M12 16.2h.01" />
  </Svg>
);

export const IconChevronDown = () => (
  <Svg size={16}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconPlus = () => (
  <Svg size={16}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const IconFile = ({ size = 20 }: { size?: number }) => (
  <Svg size={size}>
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <path d="M9 13h6M9 17h4" />
  </Svg>
);

export const IconInfo = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.8h.01" />
  </Svg>
);

export const IconShield = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const IconClock = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </Svg>
);

export const IconGrid = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="4" y="4" width="7" height="7" rx="1.5" />
    <rect x="13" y="4" width="7" height="7" rx="1.5" />
    <rect x="4" y="13" width="7" height="7" rx="1.5" />
    <rect x="13" y="13" width="7" height="7" rx="1.5" />
  </Svg>
);

export const IconBriefcase = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <rect x="3" y="7" width="18" height="13" rx="2" />
    <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    <path d="M3 13h18" />
  </Svg>
);

export const IconBook = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" />
    <path d="M4 19V5" />
  </Svg>
);

export const IconChart = ({ size }: { size?: number }) => (
  <Svg size={size}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);

/** Caravela: a lateen sail over a hull. Fictional mark. */
export function CaravelaMark({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#e9a23b" />
      <path d="M16 5.5 9 21h7z" fill="#0b3048" />
      <path d="M17.5 8.5 23.5 21h-6z" fill="#ffffff" opacity="0.92" />
      <path d="M7 23h18l-2.6 3.5H9.6z" fill="#0b3048" />
    </svg>
  );
}

export function AcmeMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="#2456d6" />
      <path d="M16 6.5 25 25h-4.4l-1.6-3.6h-6l-1.6 3.6H7z" fill="#fff" />
      <path d="m16 13.2-2.2 5h4.4z" fill="#2456d6" />
    </svg>
  );
}

export function GlobexMark({ size = 34 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" fill="#0f7b53" />
      <circle cx="16" cy="16" r="9.5" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M6.8 13h18.4M6.8 19h18.4" stroke="#fff" strokeWidth="2" />
      <path d="M16 6.5c-3 3-3 16 0 19M16 6.5c3 3 3 16 0 19" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

// Dockhand's design tokens: the one source for every surface Dockhand draws (phone cards, the HUD, the flight
// recorder, the film's charts and cards). CSS gets them as custom properties (cssVariables); TypeScript and the
// in-page scripts get the same values from TOKENS. docs/DESIGN.md explains how to use them.

/** Color. Paper, ink and one gray carry everything; the accent marks only what Dockhand did. */
export const COLOR = {
  /** Page and card background: warm off-white, like the portals and WhatsApp it sits beside. */
  paper: "#F6F5F1",
  /** Raised surfaces: tables, the HUD panel. */
  surface: "#FFFFFF",
  /** Text, rules that carry meaning, Dockhand's own data. */
  ink: "#111111",
  /** Secondary text, comparison data, labels. */
  gray: "#6B6B6B",
  /** Text that is present but not in play (a rung not needed). Passes 3:1 on paper. */
  faint: "#8F8C85",
  /** Hairlines: table rows, dividers, gridlines. */
  hair: "#E3E1DB",
  /** The stronger hairline: panel borders, the outline of an empty bar. */
  rule: "#CFCCC4",
  /** At most once per frame, only where Dockhand acted: the repaired element, the active step, the key number. */
  accent: "#FF4F00",
  /** Only for a real failure. */
  error: "#B42318",
} as const;

/**
 * Type. Two scales, one ratio: `ui` in CSS px for phone cards, the HUD and the recorder; `film` in px of a 1080p
 * frame, where everything the viewer must read is at least 40 px.
 */
export const TYPE = {
  family: {
    sans: '"Geist", system-ui, sans-serif',
    mono: '"Geist Mono", ui-monospace, monospace',
  },
  weight: { regular: 400, medium: 500, display: 600 },
  /** Display tracking (sentence case only; never letter-spaced capitals). */
  tracking: { display: "-0.02em", tight: "-0.035em", body: "0", mono: "-0.01em" },
  leading: { display: 1.05, title: 1.15, body: 1.45 },
  ui: {
    footnote: 12,
    label: 13,
    small: 14,
    body: 15,
    lead: 17,
    title: 24,
    heading: 32,
    display: 44,
    hero: 64,
  },
  film: {
    footnote: 32,
    label: 40,
    body: 44,
    lead: 52,
    title: 64,
    heading: 72,
    display: 96,
    hero: 132,
    mark: 232,
  },
} as const;

/** Spacing on a 4 px base. CSS: --dh-space-<index> is SPACE[index]; space(n) = 4n for anything in between. */
export const SPACE = [0, 4, 8, 12, 16, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128, 160] as const;
export const space = (n: number): number => n * 4;

/** Corners: square or nearly. Nothing rounder than 4 px. */
export const RADIUS = { none: 0, small: 2, max: 4 } as const;

/** Rules. A hairline separates; an ink rule states (a table's top, a chart's zero line). */
export const RULE = { hairline: 1, film: 2, emphasis: 2 } as const;

/** Layout grids. Strict left alignment; nothing centered. */
export const GRID = {
  /** A 1080p film frame: 12 columns inside 160 px margins. */
  film: { width: 1920, height: 1080, margin: 160, columns: 12, gutter: 32, top: 96, bottom: 56 },
  /** A phone card: 540 x 675 CSS px (1080 x 1350 at 2x), the 4:5 WhatsApp shows uncropped. */
  card: { width: 540, height: 675, margin: 28, top: 24, bottom: 22 },
} as const;

/** Motion: hard cuts, 150 ms fades, at most one push-in per shot. Nothing bounces, blurs or counts up. */
export const MOTION = {
  cut: 0,
  fadeMs: 150,
  pushMs: 600,
  pushMaxScale: 1.15,
  /** easeOutCubic */
  easeOut: "cubic-bezier(0.33, 1, 0.68, 1)",
  linear: "linear",
} as const;

export const TOKENS = {
  color: COLOR,
  type: TYPE,
  space: SPACE,
  radius: RADIUS,
  rule: RULE,
  grid: GRID,
  motion: MOTION,
};

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The tokens as CSS custom properties (`--dh-ink`, `--dh-type-title`, `--dh-space-4`, ...) for one scale. */
export function cssVariables(scale: "ui" | "film" = "ui"): string {
  const vars: string[] = [];
  for (const [k, v] of Object.entries(COLOR)) vars.push(`--dh-${kebab(k)}:${v}`);
  vars.push(`--dh-sans:${TYPE.family.sans}`, `--dh-mono:${TYPE.family.mono}`);
  for (const [k, v] of Object.entries(TYPE[scale])) vars.push(`--dh-type-${k}:${v}px`);
  for (const [k, v] of Object.entries(TYPE.tracking)) vars.push(`--dh-track-${k}:${v}`);
  for (const [k, v] of Object.entries(TYPE.leading)) vars.push(`--dh-lead-${k}:${v}`);
  for (const [i, v] of SPACE.entries()) vars.push(`--dh-space-${i}:${v}px`);
  for (const [k, v] of Object.entries(RADIUS)) vars.push(`--dh-radius-${k}:${v}px`);
  vars.push(`--dh-rule:${scale === "film" ? RULE.film : RULE.hairline}px`);
  vars.push(`--dh-fade:${MOTION.fadeMs}ms`, `--dh-ease-out:${MOTION.easeOut}`);
  return `:root{${vars.join(";")}}`;
}

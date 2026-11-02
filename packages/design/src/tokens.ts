// Dockhand's design tokens: the one source for every surface Dockhand draws (phone cards, the HUD, the flight
// recorder, the film's charts and cards). CSS gets them as custom properties (cssVariables); TypeScript and the
// in-page scripts get the same values from TOKENS. docs/DESIGN.md explains how to use them.

/**
 * Color. Black, white and one signal orange, the color of a port's high-visibility gear. Black is Dockhand speaking;
 * orange is Dockhand acting. A whole orange ground is reserved for one thing: work it finished by itself.
 */
export const COLOR = {
  /** The ground of everything Dockhand says: cards, panels, title bands, charts. */
  ground: "#0A0A0A",
  /** A raised panel on the ground. */
  surface: "#171717",
  /** Text, and the lines that carry meaning. */
  text: "#FFFFFF",
  /** Secondary text, comparison data, labels. 7:1 on the ground. */
  gray: "#A3A3A3",
  /** Present but not in play (a rung not needed). 3:1 on the ground. */
  faint: "#6F6F6F",
  /** Hairlines: table rows, dividers, gridlines. */
  hair: "#2A2A2A",
  /** The stronger hairline: panel borders, the outline of an empty bar. */
  rule: "#404040",
  /** Signal: where Dockhand acted (at most once per frame), or the whole ground of a finished job. */
  accent: "#FF4F00",
  /** Text on the signal ground. */
  onAccent: "#0A0A0A",
  /** Only for a real failure. */
  error: "#FF5C4D",
} as const;

/**
 * Type. Archivo for everything people read; Geist Mono only for real code. Three scales, one ratio: `ui` in CSS px
 * for the HUD and the recorder; `card` in CSS px of a 540 px phone card, where nothing goes below 20 (10 pt in the
 * chat bubble); `film` in px of a 1080p frame, where everything the viewer must read is at least 40 px.
 */
export const TYPE = {
  family: {
    sans: '"Archivo", system-ui, sans-serif',
    mono: '"Geist Mono", ui-monospace, monospace',
  },
  weight: { regular: 400, medium: 500, semibold: 600, display: 700 },
  /** Display tracking (sentence case only; never letter-spaced capitals). */
  tracking: { display: "-0.03em", tight: "-0.045em", body: "-0.01em", mono: "-0.01em" },
  leading: { display: 0.96, title: 1.1, body: 1.25 },
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
  card: {
    small: 20,
    proof: 21,
    sub: 24,
    statement: 60,
    display: 84,
    hero: 112,
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

/** Rules. A hairline separates; a bright rule states (a chart's zero line, the top of a panel). */
export const RULE = { hairline: 1, film: 2, emphasis: 2 } as const;

/** Layout grids. Strict left alignment; nothing centered. */
export const GRID = {
  /** A 1080p film frame: 12 columns inside 160 px margins. */
  film: { width: 1920, height: 1080, margin: 160, columns: 12, gutter: 32, top: 96, bottom: 56 },
  /** A phone card: 540 x 675 CSS px (1080 x 1350 at 2x), the 4:5 WhatsApp shows uncropped. Pictures run to the edge. */
  card: { width: 540, height: 675, margin: 30, top: 28, bottom: 30 },
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

/** The tokens as CSS custom properties (`--dh-text`, `--dh-type-title`, `--dh-space-4`, ...) for one scale. */
export function cssVariables(scale: "ui" | "film" = "ui"): string {
  const vars: string[] = [];
  for (const [k, v] of Object.entries(COLOR)) vars.push(`--dh-${kebab(k)}:${v}`);
  vars.push(`--dh-sans:${TYPE.family.sans}`, `--dh-mono:${TYPE.family.mono}`);
  for (const [k, v] of Object.entries(TYPE[scale])) vars.push(`--dh-type-${k}:${v}px`);
  if (scale === "ui") for (const [k, v] of Object.entries(TYPE.card)) vars.push(`--dh-card-${k}:${v}px`);
  for (const [k, v] of Object.entries(TYPE.tracking)) vars.push(`--dh-track-${k}:${v}`);
  for (const [k, v] of Object.entries(TYPE.leading)) vars.push(`--dh-lead-${k}:${v}`);
  for (const [i, v] of SPACE.entries()) vars.push(`--dh-space-${i}:${v}px`);
  for (const [k, v] of Object.entries(RADIUS)) vars.push(`--dh-radius-${k}:${v}px`);
  vars.push(`--dh-line:${scale === "film" ? RULE.film : RULE.hairline}px`);
  vars.push(`--dh-fade:${MOTION.fadeMs}ms`, `--dh-ease-out:${MOTION.easeOut}`);
  return `:root{${vars.join(";")}}`;
}

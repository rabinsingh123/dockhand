// Dockhand's design tokens: the one source for every surface Dockhand draws (phone cards, the HUD, the flight
// recorder, the film's charts and cards). CSS gets them as custom properties (cssVariables); TypeScript and the
// in-page scripts get the same values from TOKENS. docs/DESIGN.md explains how to use them.
//
// Every value is a Primer one: color from Primer Brand's dark scale, type from Primer Brand at the 1012 px step,
// sizes from Primer Primitives' base-size steps (an 8 px rhythm).

/**
 * Color. Black, white and one signal lemon, the other high-visibility color of a port's gear. Black is Dockhand
 * speaking; lemon is Dockhand acting. A whole lemon ground is reserved for one thing: work it finished by itself.
 */
export const COLOR = {
  /** The ground of everything Dockhand says: cards, panels, title bands, charts. Primer canvas.default. */
  ground: "#000000",
  /** A raised panel on the ground, and the stub at the foot of a card. Primer canvas.overlay, gray-6. */
  surface: "#262C28",
  /** Text, and the lines that carry meaning. */
  text: "#FFFFFF",
  /** Secondary text, comparison data, labels. Primer text.muted, gray-2: 9:1 on the ground. */
  gray: "#A4AEA6",
  /** Present but not in play (a rung not needed). About 5.7:1 on the ground. */
  faint: "#7C8980",
  /** Hairlines: table rows, dividers, gridlines. gray-6. */
  hair: "#262C28",
  /** The stronger hairline: panel borders, the outline of an empty bar. */
  rule: "#353D37",
  /** Signal: where Dockhand acted (at most once per frame), or the whole ground of a finished job. lemon-1. */
  accent: "#F9E76A",
  /** Text on the signal ground. */
  onAccent: "#000000",
  /** Secondary text on the signal ground. lemon-7: 6.4:1 on lemon-1. */
  onAccentMuted: "#654D02",
  /** The stub of a signal card. lemon-2. */
  accentStub: "#F4DA38",
  /** Only for a real failure. Primer danger.fg. */
  error: "#FA383D",
} as const;

/**
 * Type. Mona Sans for everything people read; Geist Mono only for real code. Two weights: semibold for the one
 * thing a surface says, regular for the rest. Three scales: `ui` in CSS px for the HUD and the recorder; `card` in
 * CSS px of a 540 px phone card, where what must be read is 28 or more and only labels are 22; `film` in px of a
 * 1080p frame, where everything the viewer must read is at least 40 px.
 */
export const TYPE = {
  family: {
    sans: '"Mona Sans", system-ui, sans-serif',
    mono: '"Geist Mono", ui-monospace, monospace',
  },
  weight: { regular: 400, semibold: 600 },
  /** Display tracking, on the display size only (sentence case; never letter-spaced capitals). */
  tracking: { display: "-0.035em", body: "0" },
  leading: { display: 1.08, id: 1.1, title: 1.18, value: 1.35, body: 1.4 },
  /** Mona Sans's width axis: expanded on the display line only. */
  stretch: { display: "125%", body: "100%" },
  ui: {
    footnote: 12,
    label: 14,
    small: 16,
    body: 16,
    lead: 20,
    title: 24,
    heading: 32,
    display: 40,
    hero: 64,
  },
  /** Primer Brand text 400 and 500, Heading 800, 900 and 1000 (display). */
  card: {
    small: 22,
    value: 28,
    title: 48,
    id: 56,
    display: 64,
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

/** Spacing on Primer's 8 px rhythm (base-size steps). CSS: --dh-space-<index> is SPACE[index]. */
export const SPACE = [0, 8, 16, 24, 32, 40, 48, 64, 80, 96, 128] as const;
/** A multiple of the 4 px half-step, for anything between the steps (a hairline offset, a mark's inset). */
export const space = (n: number): number => n * 4;

/** Corners: square. Nothing rounder than 4 px anywhere, and the cards use none. */
export const RADIUS = { none: 0, small: 2, max: 4 } as const;

/** Rules. A hairline separates; a bright rule states (a chart's zero line, the top of a panel). */
export const RULE = { hairline: 1, film: 2, emphasis: 2 } as const;

/** Layout grids. Strict left alignment; nothing centered. */
export const GRID = {
  /** A 1080p film frame: 12 columns inside 160 px margins. */
  film: { width: 1920, height: 1080, margin: 160, columns: 12, gutter: 32, top: 96, bottom: 56 },
  /**
   * A phone card: 540 x 675 CSS px (1080 x 1350 at 2x), the 4:5 WhatsApp shows uncropped. Primer Brand's grid at
   * the 768 step: 40 px margins, a 64 px header. Pictures run to the edge. Every card ends in the stub, a band with
   * the mark's dock slot cut into its top-left corner, from the edge to the text column.
   */
  card: {
    width: 540,
    height: 675,
    margin: 40,
    top: 64,
    stub: { padding: [24, 40, 32] as const, slot: { w: 40, h: 16 } },
  },
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
  for (const [k, v] of Object.entries(TYPE.weight)) vars.push(`--dh-weight-${k}:${v}`);
  for (const [k, v] of Object.entries(TYPE[scale])) vars.push(`--dh-type-${k}:${v}px`);
  if (scale === "ui") for (const [k, v] of Object.entries(TYPE.card)) vars.push(`--dh-card-${k}:${v}px`);
  for (const [k, v] of Object.entries(TYPE.tracking)) vars.push(`--dh-track-${k}:${v}`);
  for (const [k, v] of Object.entries(TYPE.leading)) vars.push(`--dh-lead-${k}:${v}`);
  for (const [k, v] of Object.entries(TYPE.stretch)) vars.push(`--dh-stretch-${k}:${v}`);
  for (const [i, v] of SPACE.entries()) vars.push(`--dh-space-${i}:${v}px`);
  for (const [k, v] of Object.entries(RADIUS)) vars.push(`--dh-radius-${k}:${v}px`);
  vars.push(`--dh-line:${scale === "film" ? RULE.film : RULE.hairline}px`);
  vars.push(`--dh-fade:${MOTION.fadeMs}ms`, `--dh-ease-out:${MOTION.easeOut}`);
  return `:root{${vars.join(";")}}`;
}

// Small HTML helpers shared by the document templates: escaping, a seeded RNG (deterministic
// "randomness" for handwriting jitter and signatures), the SAMPLE watermark and pt-BR money formatting.

export function esc(s: string | number): string {
  return String(s).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export type Rng = () => number;

/** mulberry32: tiny, fast and stable across Node versions. */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function between(rng: Rng, min: number, max: number): number {
  return min + rng() * (max - min);
}

function fixed(n: number, digits = 2): string {
  return n.toFixed(digits);
}

/**
 * Handwritten-looking text: every glyph gets a small, seeded baseline wobble and tilt, and the whole
 * value drifts a little off the printed line, the way pen strokes do.
 */
export function handwriting(text: string, rng: Rng, opts: { drift?: number; size?: number } = {}): string {
  const drift = opts.drift ?? 1;
  const glyphs = [...text]
    .map((ch) => {
      if (ch === " ") return `<span class="hw-sp"> </span>`;
      const dy = between(rng, -0.9, 0.9);
      const rot = between(rng, -3.2, 3.2);
      const dx = between(rng, -0.35, 0.35);
      return `<span class="hw-g" style="transform:translate(${fixed(dx)}px,${fixed(dy)}px) rotate(${fixed(rot, 1)}deg)">${esc(ch)}</span>`;
    })
    .join("");
  const tilt = between(rng, -1.4, 1.1) * drift;
  const lift = between(rng, -3, 1) * drift;
  const shift = between(rng, 0, 10) * drift;
  const size = opts.size ? `font-size:${opts.size}px;` : "";
  return `<span class="hw" style="${size}transform:translate(${fixed(shift)}px,${fixed(lift)}px) rotate(${fixed(tilt)}deg)">${glyphs}</span>`;
}

/** A hand-drawn tick or cross for a printed checkbox. */
export function handMark(kind: "x" | "tick", rng: Rng, ink: string): string {
  const p = (x: number, y: number) =>
    `${fixed(x + between(rng, -1.4, 1.4), 1)} ${fixed(y + between(rng, -1.4, 1.4), 1)}`;
  const d =
    kind === "x"
      ? `M${p(3, 4)} L${p(21, 21)} M${p(20, 3)} Q${p(12, 11)} ${p(4, 22)}`
      : `M${p(2, 13)} Q${p(7, 17)} ${p(9, 22)} Q${p(14, 9)} ${p(26, -2)}`;
  return `<svg class="hand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="${ink}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * A cursive-looking signature: a prolate cycloid (loops like joined letters) with two capital
 * swells and an underline flourish. Seeded, so the same seed draws the same signature.
 */
export function signatureSvg(rng: Rng, ink: string, width = 250, height = 78): string {
  const pts: string[] = [];
  const steps = 520;
  const loops = 8.5 + rng() * 1.5;
  const phase = rng() * Math.PI;
  const capitalAt = [0.04 + rng() * 0.03, 0.45 + rng() * 0.08];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const w = loops * 2 * Math.PI * t + phase;
    const swell = capitalAt.reduce((acc, c) => acc + 1.3 * Math.exp(-((t - c) ** 2) / 0.0016), 0);
    const r = height * 0.14 * (0.75 + 0.35 * Math.sin(t * 9.1 + phase) + swell) * (1 - 0.35 * t);
    const x = 14 + t * (width - 60) - r * 0.85 * Math.sin(w);
    const y = height * 0.58 - r * Math.cos(w) - t * height * 0.18;
    pts.push(`${fixed(x, 1)} ${fixed(y, 1)}`);
  }
  const main = `M${pts.join(" L")}`;
  const ux = width - 30;
  const underline = `M${fixed(ux - 8, 1)} ${fixed(height * 0.42, 1)} Q${fixed(width * 0.62, 1)} ${fixed(height * 0.98, 1)} ${fixed(width * 0.08, 1)} ${fixed(height * 0.86, 1)} Q${fixed(width * 0.36, 1)} ${fixed(height * 0.8, 1)} ${fixed(width * 0.7, 1)} ${fixed(height * 0.83, 1)}`;
  const crossbar = `M${fixed(width * 0.4, 1)} ${fixed(height * 0.3, 1)} Q${fixed(width * 0.5, 1)} ${fixed(height * 0.22, 1)} ${fixed(width * 0.62, 1)} ${fixed(height * 0.27, 1)}`;
  return `<svg class="signature" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
<path d="${main}" fill="none" stroke="${ink}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>
<path d="${underline}" fill="none" stroke="${ink}" stroke-width="1.7" stroke-linecap="round"/>
<path d="${crossbar}" fill="none" stroke="${ink}" stroke-width="1.8" stroke-linecap="round"/>
</svg>`;
}

/** Large diagonal watermark for synthetic documents (print-safe: plain text, no images). */
export const WATERMARK_TEXT = "SAMPLE – SYNTHETIC TEST DOCUMENT";

export function watermark(): string {
  return `<div class="watermark" aria-hidden="true"><span>${esc(WATERMARK_TEXT)}</span></div>`;
}

// Rotated along the page diagonal (US Letter: atan(11 / 8.5) = 52 degrees), the longest line that fits.
export const WATERMARK_CSS = `
.watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:50;overflow:hidden}
.watermark span{transform:rotate(-52deg);white-space:nowrap;font:800 44px/1 "Segoe UI",Arial,sans-serif;letter-spacing:2px;color:rgba(200,30,40,.2);border:5px solid rgba(200,30,40,.2);padding:12px 24px;border-radius:10px}
`;

/** 90000 -> "90.000,00" (pt-BR grouping, written out by hand so output never depends on ICU data). */
export function brl(amount: number): string {
  const [int, dec] = amount.toFixed(2).split(".") as [string, string];
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${dec}`;
}

/** "29/01/2027" -> "2027-01-29". */
export function dmyToIso(dmy: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dmy);
  if (!m) throw new Error(`not a DD/MM/YYYY date: ${dmy}`);
  return `${m[3]}-${m[2]}-${m[1]}`;
}

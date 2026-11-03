// Type for the video, rendered by a headless Chromium as 1920x1080 PNGs (transparent unless a slate) and laid over
// the footage by ffmpeg. HTML sets Mona Sans with real kerning and wraps captions; ffmpeg's drawtext does neither.
// Colors and type come from @dockhand/design: opaque black panels, square corners, left aligned, nothing readable
// under 40 px, lemon at most once per frame and only where Dockhand acted (black text on it), and no gradients,
// glows, pills or emoji. Two weights: 600 for statements and labels, 400 for sentences. Display tracking only on
// semibold lines of 64 px and up; figures are never tabular, so the clock sets each digit in a fixed cell.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { COLOR, fontFaceCss, GRID, TYPE } from "../../../packages/design/src/index.ts";

const GROUND = COLOR.ground;
const TEXT = COLOR.text;
const GRAY = COLOR.gray;
const HAIR = COLOR.hair;
/** The left edge of the film grid. A panel's padding hangs outside it, so its text sits on the grid. */
const LEFT = GRID.film.margin;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

const W = TYPE.weight;
const DISPLAY = TYPE.tracking.display;

const BASE = `*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px;background:transparent;
font-family:${TYPE.family.sans};font-weight:${W.regular};color:${TEXT};letter-spacing:${TYPE.tracking.body};
font-kerning:normal;font-variant-ligatures:no-common-ligatures;-webkit-font-smoothing:antialiased}`;

/** The space nearest the middle of a line. */
function midSpace(s: string): number {
  const mid = s.length / 2;
  let best = -1;
  for (let i = s.indexOf(" "); i >= 0; i = s.indexOf(" ", i + 1))
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  return best;
}

/**
 * A caption: at most two lines of a sentence-case voiceover line on a black panel, on the grid's left edge at the
 * bottom; "top" puts it top left (under the label, clear of the HUD on the right) when the shot's subject is low on
 * the screen. A chunk too long for one line breaks at its middle, so no word is left alone on the second line;
 * captionChunks keeps a chunk to two lines, so nothing here cuts text.
 */
export function captionHtml(text: string, pos: CaptionPos = "bottom"): string {
  const place = {
    top: { css: "left:48px;top:116px;max-width:920px", line: 40 },
    // flush with the foot of the phone, so no sliver of it shows under the panel
    bottom: { css: `left:${LEFT - 24}px;bottom:40px;max-width:1648px`, line: 88 },
    // under the race's two panes, clear of the speed label at the right
    band: { css: "left:24px;bottom:40px;max-width:1500px", line: 76 },
  }[pos];
  const at = text.length > place.line ? midSpace(text) : -1;
  const html = at < 0 ? esc(text) : `${esc(text.slice(0, at))}<br>${esc(text.slice(at + 1))}`;
  return `<style>${BASE}.c{position:absolute;${place.css};width:max-content;background:${GROUND};padding:16px 24px 18px;
font-size:${TYPE.film.label}px;line-height:1.2;font-weight:${W.regular}}</style><div class="c">${html}</div>`;
}

export type CaptionPos = "bottom" | "top" | "band";
/** Where a label sits: tl, tr (never on a browser shot: the HUD's status panel is there), br (the race's band). */
export type LabelSlot = "tl" | "tr" | "br";

/** A small label: "8× speed", "Replay 0.25×", "Simulated chat (rehearsal)". `accent` spends the frame's lemon. */
export function labelHtml(text: string, o: { accent?: boolean; slot?: LabelSlot } = {}): string {
  const at = { tl: "top:40px;left:48px", tr: "top:40px;right:48px", br: "bottom:48px;right:48px" }[
    o.slot ?? "tl"
  ];
  return `<style>${BASE}.l{position:absolute;${at};background:${o.accent ? COLOR.accent : GROUND};
color:${o.accent ? COLOR.onAccent : TEXT};padding:8px 24px 10px;font-size:${TYPE.film.label}px;font-weight:${W.semibold}}
</style><div class="l">${esc(text)}</div>`;
}

/** A sourced stat as a lower third (bottom left, beside the phone and above the caption). */
export function lowerThirdHtml(stat: string, source: string): string {
  return `<style>${BASE}.t{position:absolute;left:${LEFT - 24}px;bottom:220px;width:760px;background:${GROUND};
padding:24px 24px 24px}.s{font-size:${TYPE.film.lead}px;line-height:1.1;font-weight:${W.semibold};text-wrap:balance}
.r{margin-top:16px;font-size:${TYPE.film.label}px;color:${GRAY};line-height:1.2}</style>
<div class="t"><div class="s">${esc(stat)}</div><div class="r">${esc(source)}</div></div>`;
}

/** A source note under a chart, in the 32 px footnote size, above the line where the caption lands. */
export function footnoteHtml(text: string): string {
  return `<style>${BASE}.f{position:absolute;left:${LEFT}px;right:${LEFT}px;top:884px;font-size:${TYPE.film.footnote}px;
line-height:1.2;color:${GRAY}}</style><div class="f">${esc(text)}</div>`;
}

/**
 * The hand-timed run's clock: what it is, then the running time. Top left, where a label sits. Each digit sits in a
 * cell as wide as the widest one, so the time holds still as it runs without tabular figures.
 */
export function timerHtml(label: string, time: string): string {
  const cells = [...time].map((c) => (/\d/.test(c) ? `<i>${c}</i>` : esc(c))).join("");
  return `<style>${BASE}.t{position:absolute;top:40px;left:48px;background:${GROUND};padding:8px 24px 16px}
.l{font-size:${TYPE.film.label}px;font-weight:${W.semibold}}.v{font-size:${TYPE.film.hero}px;line-height:1.08;
font-weight:${W.semibold};letter-spacing:${DISPLAY}}.v i{font-style:normal;display:inline-block;width:0.6em;text-align:center}</style>
<div class="t"><div class="l">${esc(label)}</div><div class="v">${cells}</div></div>`;
}

/** A real person's words on black: the quote as they gave it, then who said it. */
export function quoteHtml(o: { quote: string; name: string; title: string; country: string }): string {
  const size = o.quote.length > 110 ? TYPE.film.lead : TYPE.film.title;
  return `<style>${BASE}html,body{background:${GROUND}}.w{position:absolute;left:${LEFT}px;right:${LEFT}px;top:${GRID.film.top}px;
bottom:200px;display:flex;flex-direction:column;justify-content:center;gap:32px}.q{font-size:${size}px;line-height:1.18;
font-weight:${W.regular}}.a{font-size:${TYPE.film.body}px;line-height:1.25;color:${GRAY}}.a b{font-weight:${W.semibold};color:${TEXT}}</style>
<div class="w"><div class="q">“${esc(o.quote)}”</div>
<div class="a"><b>${esc(o.name)}</b>, ${esc(o.title)}, ${esc(o.country)}</div></div>`;
}

/** A full-frame black card: a title and an optional line under it (placeholders, the time skip, a stat). */
export function slateHtml(title: string, sub = "", o: { note?: string } = {}): string {
  return `<style>${BASE}html,body{background:${GROUND}}.w{position:absolute;left:${LEFT}px;right:${LEFT}px;top:0;bottom:0;
display:flex;flex-direction:column;justify-content:center;gap:32px}.h{font-size:${TYPE.film.display}px;line-height:1.04;
font-weight:${W.semibold};letter-spacing:${DISPLAY}}.s{font-size:${TYPE.film.body}px;line-height:1.25;color:${GRAY}}
.n{position:absolute;left:${LEFT}px;right:${LEFT}px;bottom:220px;font-size:${TYPE.film.label}px;color:${GRAY}}</style>
<div class="w"><div class="h">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>
${o.note ? `<div class="n">${esc(o.note)}</div>` : ""}`;
}

/**
 * The race's left pane: a terminal with the recorded Playwright script's real output (40 px Geist Mono, the one place
 * the film sets mono), a status line on top and a footnote at the bottom. Its failure is set in the error red: the
 * frame's lemon belongs to Dockhand on the right.
 */
export function terminalHtml(o: {
  title: string;
  status: string;
  lines: { text: string; error?: boolean }[];
  foot?: string;
}): string {
  return `<style>${BASE}html,body{background:${GROUND}}.p{position:absolute;left:24px;top:24px;width:528px;height:816px;
background:${COLOR.surface};overflow:hidden;display:flex;flex-direction:column}.b{padding:22px 26px 18px;
border-bottom:1px solid ${HAIR};font:${W.semibold} 40px/1.15 ${TYPE.family.sans}}.st{padding:16px 26px 0;color:${GRAY};
font:400 40px/1.2 ${TYPE.family.mono}}.x{padding:16px 26px;font:400 40px/1.25 ${TYPE.family.mono};white-space:pre-wrap;
word-break:break-word;flex:1;overflow:hidden}.e{color:${COLOR.error}}.f{padding:16px 26px 22px;border-top:1px solid ${HAIR};
color:${GRAY};font:${W.regular} 40px/1.2 ${TYPE.family.sans}}</style>
<div class="p"><div class="b">${esc(o.title)}</div><div class="st">${esc(o.status)}</div><div class="x">${o.lines
    .map((l) => `<div${l.error ? ' class="e"' : ""}>${esc(l.text)}</div>`)
    .join("")}</div>${o.foot ? `<div class="f">${esc(o.foot)}</div>` : ""}</div>`;
}

export interface Overlay {
  /** Output file name (PNG) in the render folder. */
  name: string;
  html: string;
  /** Opaque (slates, the race's left pane) or transparent (labels, captions). */
  opaque?: boolean;
}

/** Renders overlays to `<dir>/<name>`; a file already rendered from the same HTML is kept. */
export async function renderOverlays(dir: string, overlays: Overlay[]): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const css = fontFaceCss();
  let browser: Browser | null = null;
  try {
    for (const o of overlays) {
      const out = join(dir, o.name);
      const stamp = `${out}.html`;
      const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${o.html}</body></html>`;
      if (existsSync(out) && existsSync(stamp) && readFileSync(stamp, "utf8") === doc) continue;
      browser ??= await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      await page.setContent(doc, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: out, omitBackground: !o.opaque });
      await page.close();
      writeFileSync(stamp, doc);
    }
  } finally {
    await browser?.close();
  }
}

/**
 * A voiceover line as caption chunks of at most two lines (about `perLine` characters each), split at sentence
 * and clause boundaries first, then at the middle of a clause too long for two lines. Each chunk gets a share of the beat proportional to its words.
 */
export function captionChunks(line: string, perLine = 46): string[] {
  const max = perLine * 2;
  const sentences = line
    .match(/[^.!?]+[.!?]+["”’)]*\s*|[^.!?]+$/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [line];
  const chunks: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) {
      chunks.push(s);
      continue;
    }
    // split long sentences at commas, colons or semicolons, then at spaces
    let cur = "";
    for (const part of s.split(/(?<=[,;:])\s+/)) {
      if (`${cur} ${part}`.trim().length <= max) cur = `${cur} ${part}`.trim();
      else {
        if (cur) chunks.push(cur);
        if (part.length <= max) cur = part;
        else {
          let rest = part;
          while (rest.length > max) {
            // Not on a stray little word: "... reads a" / "text list ..."
            const mid = midSpace(rest);
            const before = rest.lastIndexOf(" ", mid - 1);
            const at = before > 0 && mid - before <= 3 ? before : mid;
            chunks.push(rest.slice(0, at));
            rest = rest.slice(at + 1);
          }
          cur = rest;
        }
      }
    }
    if (cur) chunks.push(cur);
  }
  return chunks;
}

// Type for the video, rendered by a headless Chromium as 1920x1080 PNGs (transparent unless a slate) and laid over
// the footage by ffmpeg. HTML sets Geist with real kerning and wraps captions; ffmpeg's drawtext does neither.
// The one module to swap for the design system (packages/design) once it lands. Style: paper #F6F5F1, ink #111, gray #6B6B6B, hairline #E3E1DB, one accent #FF4F00 at most once per frame,
// Geist, no gradients, glows or emoji, anything readable at least 40 px.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { workspaceRoot } from "../../../packages/core/src/index.ts";

export const PAPER = "#F6F5F1";
export const INK = "#111111";
export const GRAY = "#6B6B6B";
export const HAIRLINE = "#E3E1DB";
export const ACCENT = "#FF4F00";

// Geist (SIL Open Font License) from its npm package, pinned; cached under var/fonts (git-ignored).
const GEIST = "https://cdn.jsdelivr.net/npm/geist@1.3.1/dist/fonts";
const FACES: { file: string; family: string; weight: number; url: string }[] = [
  {
    file: "Geist-Regular.woff2",
    family: "Geist",
    weight: 400,
    url: `${GEIST}/geist-sans/Geist-Regular.woff2`,
  },
  { file: "Geist-Medium.woff2", family: "Geist", weight: 500, url: `${GEIST}/geist-sans/Geist-Medium.woff2` },
  {
    file: "Geist-SemiBold.woff2",
    family: "Geist",
    weight: 600,
    url: `${GEIST}/geist-sans/Geist-SemiBold.woff2`,
  },
  {
    file: "GeistMono-Regular.woff2",
    family: "Geist Mono",
    weight: 400,
    url: `${GEIST}/geist-mono/GeistMono-Regular.woff2`,
  },
];

async function fontCss(): Promise<string> {
  const dir = join(workspaceRoot(), "var", "fonts");
  mkdirSync(dir, { recursive: true });
  const rules: string[] = [];
  for (const f of FACES) {
    const path = join(dir, f.file);
    if (!existsSync(path)) {
      const res = await fetch(f.url);
      if (!res.ok) throw new Error(`could not fetch ${f.url}: HTTP ${res.status}`);
      writeFileSync(path, Buffer.from(await res.arrayBuffer()));
    }
    const b64 = readFileSync(path).toString("base64");
    rules.push(
      `@font-face{font-family:"${f.family}";font-weight:${f.weight};src:url(data:font/woff2;base64,${b64}) format("woff2")}`,
    );
  }
  return rules.join("\n");
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

const BASE = `*{box-sizing:border-box;margin:0}html,body{width:1920px;height:1080px;background:transparent;
font-family:"Geist",sans-serif;color:${INK};-webkit-font-smoothing:antialiased;font-feature-settings:"ss01"}`;

/**
 * A caption: at most two lines of a sentence-case voiceover line on a paper box, bottom center; "top" puts it top
 * left (under the label, clear of the HUD on the right) when the shot's subject is low on the screen.
 */
export function captionHtml(text: string, pos: "bottom" | "top" = "bottom"): string {
  const place =
    pos === "top"
      ? "left:48px;top:128px;width:max-content;max-width:1300px;text-align:left"
      : "left:50%;bottom:48px;transform:translateX(-50%);width:max-content;max-width:1560px;text-align:center";
  return `<style>${BASE}.c{position:absolute;${place};
background:${PAPER};border:1px solid ${HAIRLINE};border-radius:4px;padding:16px 28px 18px;font-size:42px;
line-height:1.22;font-weight:500;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;
overflow:hidden}</style><div class="c">${esc(text)}</div>`;
}

/** A small label top left: "8× speed", "Replay 0.25×", "Simulated chat (rehearsal)". Accent marks one per frame. */
export function labelHtml(text: string, o: { accent?: boolean; right?: boolean } = {}): string {
  return `<style>${BASE}.l{position:absolute;top:${o.right ? 132 : 40}px;${o.right ? "right" : "left"}:48px;background:${o.accent ? ACCENT : PAPER};
color:${o.accent ? "#fff" : INK};border:1px solid ${o.accent ? ACCENT : HAIRLINE};border-radius:4px;padding:8px 20px 10px;
font-size:40px;font-weight:600;letter-spacing:-0.01em}</style><div class="l">${esc(text)}</div>`;
}

/** A sourced stat as a lower third (bottom left, above the caption band). */
export function lowerThirdHtml(stat: string, source: string): string {
  return `<style>${BASE}.t{position:absolute;left:64px;bottom:220px;max-width:600px;background:${PAPER};
border:1px solid ${HAIRLINE};border-radius:4px;padding:22px 30px 24px}.s{font-size:48px;line-height:1.15;font-weight:600;
letter-spacing:-0.02em}.r{margin-top:10px;font-size:40px;color:${GRAY};line-height:1.2}</style>
<div class="t"><div class="s">${esc(stat)}</div><div class="r">${esc(source)}</div></div>`;
}

/** A full-frame paper card: a title and an optional line under it (placeholders, the time skip, a stat). */
export function slateHtml(title: string, sub = "", o: { note?: string } = {}): string {
  return `<style>${BASE}html,body{background:${PAPER}}.w{position:absolute;inset:0;display:flex;flex-direction:column;
justify-content:center;align-items:center;gap:24px;padding:0 160px;text-align:center}.h{font-size:72px;line-height:1.08;
font-weight:600;letter-spacing:-0.03em}.s{font-size:44px;line-height:1.25;color:${GRAY};max-width:1400px}
.n{position:absolute;left:160px;right:160px;bottom:220px;text-align:center;font-size:40px;color:${GRAY}}</style>
<div class="w"><div class="h">${esc(title)}</div>${sub ? `<div class="s">${esc(sub)}</div>` : ""}</div>
${o.note ? `<div class="n">${esc(o.note)}</div>` : ""}`;
}

/**
 * The race's left pane: a terminal with the recorded Playwright script's real output (40 px Geist Mono), a status
 * line on top and a footnote at the bottom. The error lines carry the frame's one accent.
 */
export function terminalHtml(o: {
  title: string;
  status: string;
  lines: { text: string; error?: boolean }[];
  foot?: string;
}): string {
  return `<style>${BASE}html,body{background:${PAPER}}.p{position:absolute;left:32px;top:32px;width:520px;height:860px;
background:${INK};border-radius:6px;overflow:hidden;display:flex;flex-direction:column}.b{padding:22px 26px 18px;
border-bottom:1px solid #2a2a2a;color:#D9D9D9;font:600 40px/1.15 "Geist"}.st{padding:16px 26px 0;color:#BDBDBD;
font:400 40px/1.2 "Geist Mono"}.x{padding:16px 26px;font:400 40px/1.25 "Geist Mono";color:${PAPER};white-space:pre-wrap;
word-break:break-word;flex:1;overflow:hidden}.e{color:${ACCENT}}.f{padding:16px 26px 22px;border-top:1px solid #2a2a2a;
color:#BDBDBD;font:400 40px/1.2 "Geist"}</style>
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
  const css = await fontCss();
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
 * and clause boundaries first. Each chunk gets a share of the beat proportional to its words.
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
          let w = "";
          for (const word of part.split(" ")) {
            if (`${w} ${word}`.trim().length <= max) w = `${w} ${word}`.trim();
            else {
              chunks.push(w);
              w = word;
            }
          }
          cur = w;
        }
      }
    }
    if (cur) chunks.push(cur);
  }
  return chunks;
}

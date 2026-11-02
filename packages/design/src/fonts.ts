// Archivo and Geist Mono (SIL OFL 1.1, ../fonts/OFL.txt), variable. Bundled, never fetched: every surface either
// inlines them (phone cards, the HUD) or points at this folder (the film's pages, the recorder).

import { readFileSync } from "node:fs";

export const FONT_FILES = { sans: "Archivo-Variable.woff2", mono: "GeistMono-Variable.woff2" } as const;

/** The font file's bytes. */
export function fontBytes(which: keyof typeof FONT_FILES): Buffer {
  return readFileSync(new URL(`../fonts/${FONT_FILES[which]}`, import.meta.url));
}

let inline: string | undefined;

/**
 * @font-face rules for "Archivo" and "Geist Mono". With `baseUrl` they point at the files there; without, the files
 * are inlined as data URIs (for HTML rendered with setContent, which cannot load file:// URLs).
 */
export function fontFaceCss(o: { baseUrl?: string; family?: { sans: string; mono: string } } = {}): string {
  const fam = o.family ?? { sans: "Archivo", mono: "Geist Mono" };
  const src = (w: keyof typeof FONT_FILES) =>
    o.baseUrl
      ? `url("${o.baseUrl}/${FONT_FILES[w]}") format("woff2")`
      : `url(data:font/woff2;base64,${fontBytes(w).toString("base64")}) format("woff2")`;
  const css =
    `@font-face{font-family:"${fam.sans}";src:${src("sans")};font-weight:100 900;font-stretch:62% 125%;font-display:block}` +
    `@font-face{font-family:"${fam.mono}";src:${src("mono")};font-weight:100 900;font-display:block}`;
  if (!o.baseUrl && !o.family) inline ??= css;
  return o.baseUrl || o.family ? css : (inline as string);
}

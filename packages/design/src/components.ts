// Components, specified and implemented once (docs/DESIGN.md has the rules). Each is a CSS rule set plus a small
// HTML builder; the phone cards, the flight recorder and the reference sheet all draw with these.
//
// The grammar is a printed one: a masthead, a title, one summary sentence, then hairline tables. Hierarchy comes
// from type size and weight, never from boxes, badges, icons or color. Status is a word. Numbers are tabular.

import { COLOR as C, GRID, RADIUS } from "./tokens.ts";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Component CSS at the `ui` scale (CSS px). Pair with cssVariables("ui") and fontFaceCss(). */
export const COMPONENT_CSS = `
.dh{font:400 var(--dh-type-body)/var(--dh-lead-body) var(--dh-sans);color:var(--dh-ink);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.dh *{box-sizing:border-box;margin:0;padding:0}
.dh-card{width:${GRID.card.width}px;height:${GRID.card.height}px;padding:${GRID.card.top}px ${GRID.card.margin}px ${GRID.card.bottom}px;background:var(--dh-paper);display:flex;flex-direction:column;overflow:hidden}
.dh-card>*{flex-shrink:0}
.dh-mast{display:flex;align-items:baseline;justify-content:space-between;gap:var(--dh-space-4);padding-bottom:var(--dh-space-3);border-bottom:1px solid var(--dh-ink)}
.dh-wordmark{font-weight:600;font-size:18px;letter-spacing:-.045em;line-height:1;white-space:nowrap}
.dh-meta{font-size:var(--dh-type-label);font-weight:500;color:var(--dh-gray);white-space:nowrap}
.dh-title{margin-top:var(--dh-space-4);font-weight:600;font-size:var(--dh-type-title);line-height:var(--dh-lead-title);letter-spacing:var(--dh-track-display)}
.dh-display{margin-top:var(--dh-space-2);font-weight:600;font-size:var(--dh-type-hero);line-height:var(--dh-lead-display);letter-spacing:var(--dh-track-tight)}
.dh-display.m{font-family:var(--dh-mono);font-size:var(--dh-type-display);letter-spacing:-.03em}
.dh-display.s{font-size:var(--dh-type-display)}
.dh-summary{margin-top:var(--dh-space-3);font-size:var(--dh-type-body);line-height:var(--dh-lead-body);color:var(--dh-ink)}
.dh-section{margin-top:var(--dh-space-5);margin-bottom:var(--dh-space-2);font-size:var(--dh-type-label);font-weight:500;color:var(--dh-gray)}
.dh-table{width:100%;border-collapse:collapse;border-top:1px solid var(--dh-ink);font-size:var(--dh-type-small);line-height:1.35}
.dh-table th{padding:6px 10px 5px 0;text-align:left;font-weight:500;font-size:var(--dh-type-footnote);color:var(--dh-gray);border-bottom:1px solid var(--dh-hair)}
.dh-table td{padding:6px 10px 6px 0;vertical-align:top;border-bottom:1px solid var(--dh-hair);overflow-wrap:anywhere}
.dh-table td:last-child,.dh-table th:last-child{padding-right:0}
.dh-table .k{color:var(--dh-gray);width:40%}
.dh-table .was{color:var(--dh-gray)}
.dh-table .by{color:var(--dh-gray);white-space:nowrap}
.dh-table .r{text-align:right}
.dh-num{font-family:var(--dh-mono);letter-spacing:var(--dh-track-mono);font-variant-numeric:tabular-nums}
.dh-status{font-weight:500}
.dh-status.fail{color:var(--dh-error)}
.dh-accent{color:var(--dh-accent)}
.dh-shot{margin-top:var(--dh-space-4);border:1px solid var(--dh-rule);border-radius:${RADIUS.small}px;overflow:hidden;background:var(--dh-surface);line-height:0;position:relative}
.dh-shot img{display:block}
.dh-shot .hl{position:absolute;border:2px solid var(--dh-accent);border-radius:${RADIUS.small}px}
.dh-frames{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:var(--dh-space-2);margin-top:var(--dh-space-4)}
.dh-frames img{width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top;border:1px solid var(--dh-rule);border-radius:${RADIUS.small}px;display:block}
.dh-frames span{display:block;margin-top:4px;font:500 var(--dh-type-footnote)/1.2 var(--dh-mono);color:var(--dh-gray)}
.dh-foot{margin-top:auto;padding-top:var(--dh-space-3);border-top:1px solid var(--dh-hair);font-size:var(--dh-type-footnote);line-height:1.4;color:var(--dh-gray)}
.dh-foot .dh-num{color:var(--dh-ink)}
`;

/** Masthead: the wordmark, then what this is and when (sentence case, words). */
export const masthead = (meta: string): string =>
  `<header class="dh-mast"><span class="dh-wordmark">Dockhand</span><span class="dh-meta">${esc(meta)}</span></header>`;

/** Title and one-sentence summary. */
export const title = (t: string): string => `<h1 class="dh-title">${esc(t)}</h1>`;
export const summary = (s: string): string => `<p class="dh-summary">${s}</p>`;

/** The one line a viewer reads from across the room. `kind`: a number or phrase, a smaller phrase, or an ID. */
export function display(text: string, o: { kind?: "hero" | "small" | "id"; accent?: boolean } = {}): string {
  const cls = o.kind === "id" ? " m" : o.kind === "small" ? " s" : "";
  return `<div class="dh-display${cls}${o.accent ? " dh-accent" : ""}">${esc(text)}</div>`;
}

export const section = (label: string): string => `<h2 class="dh-section">${esc(label)}</h2>`;

/** Numbers and IDs: Geist Mono, tabular. */
export const num = (v: string | number): string => `<span class="dh-num">${esc(v)}</span>`;

/** Status is a word ("Fixed", "Verified", "Stopped"), never a symbol. */
export const status = (word: string, fail = false): string =>
  `<span class="dh-status${fail ? " fail" : ""}">${esc(word)}</span>`;

/** Label/value rows (a receipt). Values are trusted markup when `html` is set, otherwise escaped. */
export function facts(rows: [string, string][], o: { html?: boolean; max?: number } = {}): string {
  const max = o.max ?? rows.length;
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const more = rows.length - shown.length;
  return `<table class="dh-table"><tbody>${shown
    .map(([k, v]) => `<tr><td class="k">${esc(k)}</td><td>${o.html ? v : esc(v)}</td></tr>`)
    .join(
      "",
    )}${more > 0 ? `<tr class="more" data-n="${more}"><td class="k" colspan="2">${more} more</td></tr>` : ""}</tbody></table>`;
}

/** A change row: what it was, what it is now, and who fixed it (in words, with time and cost when a model did). */
export interface Change {
  was: string;
  now: string;
  by: string;
  /** The accent: the one change on screen a model repaired. */
  accent?: boolean;
}

export function changes(rows: Change[], o: { max?: number; more?: string } = {}): string {
  const max = o.max ?? rows.length;
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const extra = rows.length - shown.length;
  return `<table class="dh-table"><thead><tr><th>Before</th><th>Now</th><th>Fixed by</th></tr></thead><tbody>${shown
    .map(
      (r) =>
        `<tr><td class="was">${esc(r.was)}</td><td${r.accent ? ' class="dh-accent"' : ""}>${esc(r.now)}</td><td class="by">${esc(r.by)}</td></tr>`,
    )
    .join(
      "",
    )}${extra > 0 ? `<tr class="more" data-n="${extra}"><td class="was" colspan="3">${extra} more</td></tr>` : ""}${o.more ? `<tr class="note"><td class="was" colspan="3">${esc(o.more)}</td></tr>` : ""}</tbody></table>`;
}

export const footnote = (html: string): string => `<footer class="dh-foot">${html}</footer>`;

/**
 * Keeps a fixed-size card within its frame without cutting text: while the card overflows, the longest table
 * gives up its last row to an "N more" line. Runs when the card is parsed and again once its fonts load
 * (a screenshot waits for the fonts, so it sees the fitted card).
 */
export const FIT_SCRIPT = `<script>(()=>{const fit=()=>{const c=document.querySelector(".dh-card");if(!c)return;
const over=()=>c.scrollHeight>c.clientHeight+0.5;
for(let i=0;i<80&&over();i++){
const ts=[...c.querySelectorAll("table.dh-table")].map(t=>({t,rows:[...t.tBodies[0].rows].filter(r=>!r.classList.contains("more")&&!r.classList.contains("note"))})).filter(x=>x.rows.length>0);
if(!ts.length)break;ts.sort((a,b)=>b.rows.length-a.rows.length);const{t,rows}=ts[0];rows[rows.length-1].remove();
let m=t.tBodies[0].querySelector("tr.more");if(!m){m=document.createElement("tr");m.className="more";m.dataset.n="0";
const td=document.createElement("td");td.className="k";td.colSpan=t.rows[0].cells.length||2;m.appendChild(td);
const note=t.tBodies[0].querySelector("tr.note");t.tBodies[0].insertBefore(m,note);}
m.dataset.n=String(Number(m.dataset.n)+1);m.cells[0].textContent=m.dataset.n+" more";}};
fit();document.fonts.ready.then(fit);})();</script>`;

/** Patterns the system forbids in any rendered surface (docs/DESIGN.md, "Don't"). */
export const TELLS: [RegExp, string][] = [
  [/gradient\(/i, "gradient"],
  [/border-radius:\s*(50%|999|[5-9]px|\d{2,}px)/i, "rounded more than 4 px, or a circle"],
  [/box-shadow:\s*(?!inset)[^;}"]*\d+px\s+\d+px/i, "drop shadow"],
  [/text-overflow:\s*ellipsis/i, "ellipsis truncation"],
  [/-webkit-line-clamp/i, "line clamp"],
  [/filter:\s*(blur|drop-shadow)/i, "blur or glow"],
  [/text-transform:\s*uppercase/i, "letter-spaced capitals"],
  [/[✓✔✗✕⊗◌●○◉★→←↑↓•…]/u, "symbol or decorative glyph"],
  [/\p{Extended_Pictographic}/u, "emoji"],
];

/** The tells found in a piece of HTML or CSS (empty when clean). */
export function tells(source: string): string[] {
  return TELLS.flatMap(([re, what]) => (re.test(source) ? [what] : []));
}

export const PALETTE = C;

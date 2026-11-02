// Components, specified and implemented once (docs/DESIGN.md has the rules). Each is a CSS rule set plus a small
// HTML builder; the phone cards and the reference sheet draw with these.
//
// A card is a poster, not a report: it is seen about 290 px wide in a chat bubble, so it says one thing, big, and
// shows one real picture. Everything else belongs in the WhatsApp message under it, where text is always sharp.

import { COLOR as C, GRID } from "./tokens.ts";

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The mark: a D with a slot cut into it, a dock for whatever comes in. Its path is drawn on a 100 x 100 grid. */
export const MARK = {
  viewBox: "16 12 72 76",
  path: "M16 12h34c24 0 38 16 38 38S74 88 50 88H16V57h22V43H16Z",
} as const;

export const mark = (): string =>
  `<svg class="dh-mark" viewBox="${MARK.viewBox}" aria-hidden="true"><path d="${MARK.path}"/></svg>`;

/** The mark and the name, as they sit at the top of every card. */
export const lockup = (): string => `<span class="dh-lockup">${mark()}Dockhand</span>`;

/** Component CSS at the `ui` scale (CSS px). Pair with cssVariables("ui") and fontFaceCss(). */
export const COMPONENT_CSS = `
.dh{font:500 var(--dh-card-sub)/var(--dh-lead-body) var(--dh-sans);color:var(--dh-text);letter-spacing:var(--dh-track-body);-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.dh *{box-sizing:border-box;margin:0;padding:0}
.dh-card{width:${GRID.card.width}px;height:${GRID.card.height}px;background:var(--dh-ground);display:flex;flex-direction:column;overflow:hidden}
.dh-card>*{flex-shrink:0}
.dh-card.signal{background:var(--dh-accent);color:var(--dh-on-accent)}
.dh-top{display:flex;align-items:center;justify-content:space-between;gap:var(--dh-space-4);height:${GRID.card.top * 2 + 22}px;padding:0 ${GRID.card.margin}px}
.dh-lockup{display:flex;align-items:center;gap:9px;font-weight:700;font-size:24px;line-height:1;letter-spacing:-.035em;white-space:nowrap}
.dh-mark{height:20px;width:auto;fill:currentColor;display:block}
.dh-context{font-size:var(--dh-card-small);font-weight:500;line-height:1;color:var(--dh-gray);white-space:nowrap}
.signal .dh-context{color:inherit}
.dh-stage{flex:1 1 0;min-height:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${GRID.card.margin}px;overflow:hidden}
.dh-state{font-weight:700;font-size:var(--dh-card-statement);line-height:var(--dh-lead-display);letter-spacing:var(--dh-track-tight);overflow-wrap:break-word}
.dh-accent{color:var(--dh-accent)}
.dh-kicker{font-size:var(--dh-card-sub);line-height:1.2;color:var(--dh-gray);margin-bottom:10px}
.dh-sub{margin-top:14px;font-size:var(--dh-card-sub);line-height:1.2;letter-spacing:-.015em}
.dh-foot{padding:0 ${GRID.card.margin}px ${GRID.card.bottom}px}
.dh-foot .dh-sub{margin-top:0}
.dh-proof{margin-top:8px;font-size:var(--dh-card-proof);line-height:1.25;color:var(--dh-gray)}
.dh-foot .dh-proof:first-child{margin-top:0}
.signal .dh-proof{color:inherit;font-weight:600}
.dh-bleed{position:relative;overflow:hidden;background:#fff;line-height:0}
.dh-bleed img{position:absolute;display:block;max-width:none}
.dh-bleed .hl{position:absolute;border:3px solid var(--dh-accent);border-radius:var(--dh-radius-small)}
.dh-table{width:100%;margin-top:20px;border-collapse:collapse;font-size:var(--dh-card-small);line-height:1.2}
.dh-table td{padding:7px 12px 7px 0;vertical-align:top;border-top:1px solid var(--dh-hair);overflow-wrap:anywhere}
.dh-table td:last-child{padding-right:0}
.dh-table .k{color:var(--dh-gray);width:42%}
.dh-table .was{color:var(--dh-gray)}
.dh-table .by{color:var(--dh-gray);text-align:right;white-space:nowrap}
`;

/** The top of every card: the lockup, then in a word or two what this is. */
export const top = (context: string): string =>
  `<header class="dh-top">${lockup()}<span class="dh-context">${esc(context)}</span></header>`;

/** The one thing the card says. `size` in CSS px; FIT_SCRIPT brings it down when long data needs room. */
export function state(html: string, o: { size?: number; accent?: boolean } = {}): string {
  return `<h1 class="dh-state${o.accent ? " dh-accent" : ""}"${o.size ? ` style="font-size:${o.size}px"` : ""}>${html}</h1>`;
}

/** A short line above a statement, leading into it. */
export const kicker = (s: string): string => `<p class="dh-kicker">${s}</p>`;
/** The sentence that says what the statement means. */
export const sub = (s: string): string => `<p class="dh-sub">${s}</p>`;
/** Who, how long, how much. */
export const proof = (s: string): string => `<p class="dh-proof">${s}</p>`;

/** The middle of a card, which takes the free height; the foot sits on the bottom margin. */
export const stage = (html: string): string => `<section class="dh-stage">${html}</section>`;
export const foot = (html: string): string => `<footer class="dh-foot">${html}</footer>`;

/** Label and value rows (a receipt). Values are trusted markup when `html` is set, otherwise escaped. */
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

/** A change: what it was, what it is now, and who fixed it (in words, with time when a model did). */
export interface Change {
  was: string;
  now: string;
  by: string;
  /** The accent: the one change on screen a model repaired. */
  accent?: boolean;
}

/** Changes after the lead one: the new name and who fixed it, on one line each. */
export function changes(rows: Change[], o: { max?: number; more?: string } = {}): string {
  const max = o.max ?? rows.length;
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const extra = rows.length - shown.length;
  return `<table class="dh-table"><tbody>${shown
    .map((r) => `<tr><td>${esc(r.now)}</td><td class="by">${esc(r.by)}</td></tr>`)
    .join(
      "",
    )}${extra > 0 ? `<tr class="more" data-n="${extra}"><td class="was" colspan="2">${extra} more</td></tr>` : ""}${o.more ? `<tr class="note"><td class="was" colspan="2">${esc(o.more)}</td></tr>` : ""}</tbody></table>`;
}

/**
 * Keeps a fixed-size card within its frame without cutting text: while the stage overflows, the statement steps down
 * to its floor, then the longest table gives up rows to an "N more" line, then the statement steps down further.
 * Runs when the card is parsed and again once its fonts load (a screenshot waits for the fonts, so it sees the
 * fitted card).
 */
export const FIT_SCRIPT = `<script>(()=>{const fit=()=>{const c=document.querySelector(".dh-card");if(!c)return;
const box=c.querySelector(".dh-stage")||c;const s=c.querySelector(".dh-state");
const over=()=>box.scrollHeight>box.clientHeight+.5||(s&&s.scrollWidth>s.clientWidth+.5)||c.scrollHeight>c.clientHeight+.5;
const step=(floor)=>{if(!s)return;let z=parseFloat(getComputedStyle(s).fontSize);while(over()&&z>floor){z-=2;s.style.fontSize=z+"px";}};
step(44);
for(let i=0;i<80&&over();i++){
const ts=[...c.querySelectorAll("table.dh-table")].map(t=>({t,rows:[...t.tBodies[0].rows].filter(r=>!r.classList.contains("more")&&!r.classList.contains("note"))})).filter(x=>x.rows.length>0);
if(!ts.length)break;ts.sort((a,b)=>b.rows.length-a.rows.length);const{t,rows}=ts[0];rows[rows.length-1].remove();
let m=t.tBodies[0].querySelector("tr.more");if(!m){m=document.createElement("tr");m.className="more";m.dataset.n="0";
const td=document.createElement("td");td.className="k";td.colSpan=2;m.appendChild(td);
const note=t.tBodies[0].querySelector("tr.note");t.tBodies[0].insertBefore(m,note);}
m.dataset.n=String(Number(m.dataset.n)+1);m.cells[0].textContent=m.dataset.n+" more";}
step(24);};
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

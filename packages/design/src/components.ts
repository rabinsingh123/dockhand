// Components, specified and implemented once (docs/DESIGN.md has the rules). Each is a CSS rule set plus a small
// HTML builder; the phone cards and the reference sheet draw with these.
//
// A card is a poster, not a report: it is seen about 290 px wide in a chat bubble, so it says one thing, big, and
// shows one real picture. Its proof sits in the stub at the foot, three short fields at most. Everything else
// belongs in the WhatsApp message under it, where text is always sharp.
//
// Type on a card: three sizes at most (22 for labels and incidental lines, 28 for everything that must be read, and
// one hero size: 48, 56 or the 64 display) and two weights (600 for the hero, the status line and the lockup; 400
// for the rest).

import { COLOR as C, GRID, TYPE } from "./tokens.ts";

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
export const lockup = (): string => `<span class="dh-lockup">${mark()}<span>Dockhand</span></span>`;

const K = TYPE.card;
const L = TYPE.leading;
const G = GRID.card;
const [stubTop, stubSide, stubBottom] = G.stub.padding;

/** Component CSS at the `ui` scale (CSS px). Pair with cssVariables("ui") and fontFaceCss(). */
export const COMPONENT_CSS = `
.dh{font:400 ${K.small}px/${L.body} var(--dh-sans);color:var(--dh-text);letter-spacing:0;font-kerning:normal;font-variant-ligatures:no-common-ligatures;-webkit-font-smoothing:antialiased;text-rendering:geometricPrecision}
.dh *{box-sizing:border-box;margin:0;padding:0}
.dh-card{--dh-c-bg:var(--dh-ground);--dh-c-muted:var(--dh-gray);--dh-c-stub:var(--dh-surface);width:${G.width}px;height:${G.height}px;background:var(--dh-c-bg);display:flex;flex-direction:column;overflow:hidden}
.dh-card>*{flex-shrink:0}
.dh-card.signal{--dh-c-bg:var(--dh-accent);--dh-c-muted:var(--dh-on-accent-muted);--dh-c-stub:var(--dh-accent-stub);color:var(--dh-on-accent)}
.dh-top{display:flex;align-items:center;justify-content:space-between;gap:16px;height:${G.top}px;padding:0 ${G.margin}px}
.dh-lockup{display:flex;align-items:center;gap:8px;font-weight:600;font-size:${K.small}px;line-height:1;white-space:nowrap}
.dh-mark{height:24px;width:auto;fill:currentColor;display:block}
.dh-context{font-size:${K.small}px;line-height:1;color:var(--dh-c-muted);white-space:nowrap}
.dh-stage{flex:1 1 0;min-height:0;display:flex;flex-direction:column;justify-content:center;padding:0 ${G.margin}px;overflow:hidden}
.dh-state{font-weight:600;font-size:${K.title}px;line-height:${L.title};text-wrap:balance;overflow-wrap:break-word}
.dh-state.dh-id{font-size:${K.id}px;line-height:${L.id}}
.dh-state.dh-nowrap{white-space:nowrap}
.dh-state.dh-display{font-size:${K.display}px;line-height:${L.display};letter-spacing:${TYPE.tracking.display};font-stretch:${TYPE.stretch.display}}
.dh-accent{color:var(--dh-accent)}
.signal .dh-accent{color:inherit}
.dh-kicker{font-size:${K.value}px;line-height:${L.value};font-weight:600;color:var(--dh-accent)}
.signal .dh-kicker{color:inherit}
.dh-sub{margin-top:16px;font-size:${K.value}px;line-height:${L.value};text-wrap:pretty}
.dh-note{margin-top:16px;font-size:${K.small}px;line-height:${L.body};color:var(--dh-c-muted);text-wrap:pretty}
.dh-note+.dh-note{margin-top:0}
.dh-note b{font-weight:400;color:var(--dh-text)}
.signal .dh-note b{color:inherit}
.dh-rows{display:flex;flex-direction:column;gap:16px;margin-top:40px}
.dh-row{display:flex;justify-content:space-between;align-items:baseline;gap:32px}
.dh-row .k{flex:0 0 auto;max-width:55%;font-size:${K.small}px;line-height:${L.body};color:var(--dh-c-muted);overflow-wrap:anywhere}
.dh-row .v{flex:0 1 auto;min-width:0;font-size:${K.value}px;line-height:${L.value};text-align:right;overflow-wrap:anywhere}
.dh-row.more .k{font-size:${K.small}px}
.dh-rows .was{color:var(--dh-c-muted)}
.dh-stub{position:relative;background:var(--dh-c-stub);padding:${stubTop}px ${stubSide}px ${stubBottom}px;display:flex;gap:32px}
.dh-stub::before{content:"";position:absolute;left:0;top:0;width:${G.stub.slot.w}px;height:${G.stub.slot.h}px;background:var(--dh-c-bg)}
.dh-stub .f{display:flex;flex-direction:column;flex:0 1 auto;min-width:0}
.dh-stub .k{font-size:${K.small}px;line-height:${L.body};color:var(--dh-c-muted);white-space:nowrap}
.dh-stub .v{font-size:${K.value}px;line-height:${L.value};white-space:nowrap}
.dh-stub .f.wrap .v{white-space:normal;overflow-wrap:anywhere}
.dh-bleed{position:relative;overflow:hidden;background:#fff;line-height:0}
.dh-bleed img{position:absolute;display:block;max-width:none}
.dh-bleed .hl{position:absolute;border:2px solid ${C.onAccent};outline:4px solid var(--dh-accent)}
.dh-table{width:100%;margin-top:24px;border-collapse:collapse;font-size:${K.small}px;line-height:${L.body}}
.dh-table td{padding:8px 16px 8px 0;vertical-align:top;border-top:1px solid var(--dh-hair);overflow-wrap:anywhere}
.dh-table td:last-child{padding-right:0}
.dh-table .k{color:var(--dh-gray);width:42%}
.dh-table .was{color:var(--dh-gray)}
`;

/** The top of every card: the lockup, then in a word or two what this is. */
export const top = (context: string): string =>
  `<header class="dh-top">${lockup()}<span class="dh-context">${esc(context)}</span></header>`;

/** The hero sizes: a statement (48), a record ID or number (56), or the display line (64, expanded). */
export type StateSize = "title" | "id" | "display";

/**
 * The one thing the card says. FIT_SCRIPT steps it down a token size at a time when long data needs room.
 * `nowrap` keeps a record ID on one line ("SG-GLOBEX-000311" never breaks at a hyphen): it steps down instead.
 */
export function state(
  html: string,
  o: { size?: StateSize; accent?: boolean; nowrap?: boolean } = {},
): string {
  const cls = [
    "dh-state",
    o.size && o.size !== "title" ? `dh-${o.size}` : "",
    o.accent ? "dh-accent" : "",
    o.nowrap ? "dh-nowrap" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return `<h1 class="${cls}">${html}</h1>`;
}

/** The status line over the hero ("Deal registered"), 28 semibold in the accent. */
export const kicker = (s: string): string => `<p class="dh-kicker">${s}</p>`;
/** The sentence that says what the hero means, 28 regular. */
export const sub = (s: string): string => `<p class="dh-sub">${s}</p>`;
/** An incidental line, 22 muted: where it ran, a credit. Nothing that must be read. */
export const note = (s: string): string => `<p class="dh-note">${s}</p>`;

/** The middle of a card, which takes the free height; the stub sits on the bottom edge. */
export const stage = (html: string): string => `<section class="dh-stage">${html}</section>`;

/**
 * Label and value rows: the label 22 muted on the left, the value 28 on the right the way a receipt sets amounts,
 * 16 px apart, no rules. Values are trusted markup when `html` is set, otherwise escaped. Past `max`, the last row
 * shown becomes "N more"; FIT_SCRIPT gives up further rows the same way when the stage overflows.
 */
export function rows(list: [string, string][], o: { html?: boolean; max?: number } = {}): string {
  const max = o.max ?? list.length;
  const shown = list.length > max ? list.slice(0, max - 1) : list;
  const more = list.length - shown.length;
  return `<div class="dh-rows">${shown
    .map(
      ([k, v]) =>
        `<div class="dh-row"><span class="k">${o.html ? k : esc(k)}</span><span class="v">${o.html ? v : esc(v)}</span></div>`,
    )
    .join(
      "",
    )}${more > 0 ? `<div class="dh-row more" data-n="${more}"><span class="k">${more} more</span></div>` : ""}</div>`;
}

/** One stub field: a label over its value. An empty label shows the value alone. `wrap` lets a long value wrap. */
export type StubField =
  | [label: string, value: string]
  | [label: string, value: string, o: { wrap?: boolean }];

/**
 * The stub: the band every card ends in, with the mark's dock slot cut into its top-left corner (from the edge to
 * the text column, 16 px deep). It holds the proof as up to three label-over-value fields. Values are escaped.
 */
export function stub(fields: StubField[]): string {
  return `<footer class="dh-stub">${fields
    .map(
      ([k, v, o]) =>
        `<div class="f${o?.wrap ? " wrap" : ""}">${k ? `<span class="k">${esc(k)}</span>` : ""}<span class="v">${esc(v)}</span></div>`,
    )
    .join("")}</footer>`;
}

/** A change: what it was, what it is now, and who fixed it (in words, with time when a model did). */
export interface Change {
  was: string;
  now: string;
  by: string;
  /** The accent: the one change on screen a model repaired. */
  accent?: boolean;
}

/** Changes after the lead one, as rows: the new name, and who fixed it. `more` is a closing note line. */
export function changes(list: Change[], o: { max?: number; more?: string } = {}): string {
  return (
    (list.length ? rows(list.map((r): [string, string] => [r.now, r.by], o)) : "") +
    (o.more ? note(esc(o.more)) : "")
  );
}

/**
 * Keeps a fixed-size card within its frame without cutting text: while the stage overflows, the hero steps down a
 * token size at a time (64, 56, 48) to 48, then the longest row list gives up rows to an "N more" line, then the
 * hero steps down to 40. Runs when the card is parsed and again once its fonts load (a screenshot waits for the
 * fonts, so it sees the fitted card).
 */
export const FIT_SCRIPT = `<script>(()=>{const fit=()=>{const c=document.querySelector(".dh-card");if(!c)return;
const box=c.querySelector(".dh-stage")||c;const s=c.querySelector(".dh-state");
const over=()=>box.scrollHeight>box.clientHeight+.5||(s&&s.scrollWidth>s.clientWidth+.5)||c.scrollHeight>c.clientHeight+.5||[...c.querySelectorAll(".dh-stub,.dh-top")].some(e=>e.scrollWidth>e.clientWidth+.5);
const SIZES=[64,56,48,40];
const step=(floor)=>{if(!s)return;let z=parseFloat(getComputedStyle(s).fontSize);for(const t of SIZES){if(!over())break;if(t>=z||t<floor)continue;z=t;s.style.fontSize=t+"px";if(t<64){s.style.letterSpacing="0";s.style.fontStretch="100%";}}};
step(48);
for(let i=0;i<80&&over();i++){
const ls=[...c.querySelectorAll(".dh-rows")].map(t=>({t,rows:[...t.children].filter(r=>!r.classList.contains("more"))})).filter(x=>x.rows.length>0);
if(!ls.length)break;ls.sort((a,b)=>b.rows.length-a.rows.length);const{t,rows}=ls[0];rows[rows.length-1].remove();
let m=t.querySelector(".dh-row.more");if(!m){m=document.createElement("div");m.className="dh-row more";m.dataset.n="0";
const k=document.createElement("span");k.className="k";m.appendChild(k);t.appendChild(m);}
m.dataset.n=String(Number(m.dataset.n)+1);m.firstChild.textContent=m.dataset.n+" more";}
step(40);};
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
  [/tabular-nums|"tnum"/, "tabular figures (Mona Sans draws them with a slashed zero that reads as code)"],
  [/[✓✔✗✕⊗◌●○◉★→←↑↓•…]/u, "symbol or decorative glyph"],
  [/\p{Extended_Pictographic}/u, "emoji"],
];

/** The tells found in a piece of HTML or CSS (empty when clean). */
export function tells(source: string): string[] {
  return TELLS.flatMap(([re, what]) => (re.test(source) ? [what] : []));
}

export const PALETTE = C;

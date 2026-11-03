// The rendered reference sheet (var/design/system.png): the mark, tokens, type and the rules, drawn with the system
// itself. assets/video/design.ts renders it with the real phone cards and chart stills.

import { COMPONENT_CSS, esc, lockup, mark } from "./components.ts";
import { fontFaceCss } from "./fonts.ts";
import { COLOR, cssVariables, GRID, MOTION, SPACE, TYPE } from "./tokens.ts";

const ROLE: Record<keyof typeof COLOR, string> = {
  ground: "Everything Dockhand says",
  surface: "A raised panel",
  text: "Text, lines that carry meaning",
  gray: "Secondary text, comparison data",
  faint: "Present but not in play",
  hair: "Hairlines, gridlines",
  rule: "Panel borders",
  accent: "Where Dockhand acted, or a whole finished job",
  onAccent: "Text on the signal ground",
  onAccentMuted: "Secondary text on the signal ground",
  accentStub: "The stub of a signal card",
  error: "Only a real failure",
};

export const DOS = [
  "Design for the size it is seen at. A card is 290 px wide in a chat, so what must be read is 28 CSS px or more, and only labels are 22.",
  "One hero, one real picture from the run, and the proof in the stub. Detail goes in the WhatsApp message under it.",
  "Black is Dockhand speaking. A whole lemon ground means one thing: it finished the work by itself.",
  "Pictures are real: a screenshot of the page, a frame of the video, edge to edge, cropped so they can be read.",
  "Say status in words, with who, time and cost: Fixed by Muse Spark Open in 2.7 s for $0.0029.",
  "Label every series where it ends. Lemon is Dockhand, gray the comparison, dashed gray a projection.",
  "Align everything to the left edge. Square corners. Hard cuts, 150 ms fades, one push-in per shot.",
];

export const DONTS = [
  "Report layouts: a masthead over tables, a row of stat tiles, three numbers with tiny captions.",
  "Monospace or tabular figures for numbers or labels. Mono is for real code and terminals only.",
  "Warm off-white with an orange accent, the default of generated design. Glass, glow, gradient, blur, rounded cards.",
  "Endpoint dots, circle icons, status dots, pill badges, boxes with the same soft shadow.",
  "Centered hero headlines, letter-spaced capital eyebrows, decorative arrows and checkmarks, emoji.",
  "Ellipsis truncation in anything the reader needs. Counting-up numbers, bouncy easing.",
];

export interface ReferenceImages {
  cards?: { name: string; src: string }[];
  frames?: { name: string; src: string }[];
}

/** The reference sheet as a self-contained page, 2400 px wide. */
export function referenceSheetHtml(img: ReferenceImages = {}): string {
  const swatches = (Object.keys(COLOR) as (keyof typeof COLOR)[])
    .map(
      (k) =>
        `<div class="sw"><i style="background:${COLOR[k]};outline:1px solid ${COLOR.rule};outline-offset:-1px"></i><b>${k}</b><span>${COLOR[k]}</span><em>${ROLE[k]}</em></div>`,
    )
    .join("");
  const typeRow = (scale: "card" | "film") =>
    Object.entries(TYPE[scale])
      .filter(([k]) => k !== "mark")
      .map(
        ([k, v]) =>
          `<tr><td class="k">${k}, ${v} px</td><td style="white-space:nowrap"><span style="font-size:${Math.min(v, 72)}px;font-weight:${v >= 40 ? 600 : 400};line-height:1.1">Nothing to do.</span></td></tr>`,
      )
      .join("");
  const spaces = SPACE.slice(1, 13)
    .map((v) => `<div class="sp"><i style="width:${v}px"></i><span>${v}</span></div>`)
    .join("");
  const gallery = (items: { name: string; src: string }[] | undefined, w: number) =>
    (items ?? [])
      .map(
        (i) =>
          `<figure style="width:${w}px"><img src="${esc(i.src)}"><figcaption>${esc(i.name)}</figcaption></figure>`,
      )
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss()}${cssVariables("ui")}${COMPONENT_CSS}
body{margin:0;background:var(--dh-ground)}
.sheet{width:2400px;padding:96px 120px 120px}
.sheet h1{font-size:96px;font-weight:600;letter-spacing:-.035em;line-height:1;font-stretch:125%}
.sheet .lede{margin-top:20px;font-size:28px;line-height:1.3;max-width:1300px}
.sheet h2{margin:80px 0 24px;padding-top:16px;border-top:2px solid var(--dh-text);font-size:40px;font-weight:600}
.sheet h3{margin:0 0 16px;font-size:22px;font-weight:400;color:var(--dh-gray)}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:48px}
.marks{display:flex;gap:32px;align-items:stretch}
.tile{width:360px;height:360px;display:grid;place-items:center}.tile .dh-mark{height:190px}
.tile.o{background:var(--dh-accent);color:var(--dh-on-accent)}.tile.k{background:var(--dh-surface)}
.lock{display:flex;align-items:center;padding:0 72px;background:var(--dh-accent);color:var(--dh-on-accent)}
.lock .dh-lockup{font-size:96px;gap:24px}.lock .dh-mark{height:78px}
.sw{display:grid;grid-template-columns:120px 1fr;grid-template-rows:auto auto auto;column-gap:20px;margin-bottom:20px;font-size:18px}
.sw i{grid-row:1/4;width:120px;height:84px;display:block}
.sw b{font-weight:600}.sw span,.sw em{font-style:normal;color:var(--dh-gray)}
.sp{display:flex;align-items:center;gap:16px;height:28px;font-size:16px;color:var(--dh-gray)}.sp i{display:block;height:12px;background:var(--dh-text)}
.note{font-size:20px;line-height:1.35;margin-bottom:18px}
.gal{display:flex;flex-wrap:wrap;gap:32px}.gal img{width:100%;display:block;outline:1px solid var(--dh-hair)}
.gal figcaption{margin-top:8px;font-size:18px;color:var(--dh-gray)}
.do{list-style:none}.do li{padding:12px 0;border-top:1px solid var(--dh-hair);font-size:22px;line-height:1.3}
</style></head><body class="dh"><div class="sheet">
<h1>Dockhand design system</h1>
<p class="lede">One source for every surface Dockhand draws: the WhatsApp cards, the HUD, the flight recorder and the film. Black, white and one signal lemon, the other high-visibility color of a port's gear. Mona Sans in two weights, on Primer's sizes. Real pictures from the run, and every card ends in the stub, with the mark's dock slot cut into it.</p>
<h2>Mark: a D with a slot cut into it, a dock for whatever comes in</h2>
<div class="marks"><div class="tile o">${mark()}</div><div class="tile k">${mark()}</div><div class="lock">${lockup()}</div></div>
<h2>Color</h2><div class="cols">${swatches}</div>
<h2>Type: Mona Sans 600 for the hero, 400 for the rest, Geist Mono for real code only</h2>
<div class="cols" style="grid-template-columns:1fr 1fr"><div><h3>Card scale, CSS px of a 540 px card</h3><table class="dh-table">${typeRow("card")}</table></div>
<div><h3>Film scale, px of a 1080p frame</h3><table class="dh-table">${typeRow("film")}</table></div></div>
<h2>Space, grid, motion</h2>
<div class="cols"><div><h3>Spacing, an 8 px rhythm</h3>${spaces}</div>
<div><h3>Grid</h3><p class="note">Card: ${GRID.card.width} x ${GRID.card.height} CSS px at 2x (4:5), ${GRID.card.margin} px margins, pictures to the edge.</p><p class="note">Film: ${GRID.film.columns} columns, ${GRID.film.margin} px margins, ${GRID.film.gutter} px gutters, everything left-aligned.</p></div>
<div><h3>Motion</h3><p class="note">Hard cuts. Overlays fade in over ${MOTION.fadeMs} ms. At most one push-in per shot, ${MOTION.pushMs} ms ease-out, up to ${MOTION.pushMaxScale}x.</p></div></div>
<h2>Phone cards</h2><div class="gal">${gallery(img.cards, 400)}</div>
<h2>Film: charts, caption band, end card, HUD</h2><div class="gal">${gallery(img.frames, 1060)}</div>
<h2>Do and don't</h2><div class="cols" style="grid-template-columns:1fr 1fr"><div><h3>Do</h3><ul class="do">${DOS.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>
<div><h3>Don't</h3><ul class="do">${DONTS.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></div>
</div></body></html>`;
}

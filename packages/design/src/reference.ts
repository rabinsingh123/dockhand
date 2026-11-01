// The rendered reference sheet (var/design/system.png): tokens, type, spacing, components, and the rules, drawn
// with the system itself. assets/video/design.ts renders it with the real phone cards and chart stills.

import { COMPONENT_CSS, changes, esc, facts, num, status } from "./components.ts";
import { fontFaceCss } from "./fonts.ts";
import { COLOR, cssVariables, GRID, MOTION, RADIUS, SPACE, TYPE } from "./tokens.ts";

const ROLE: Record<keyof typeof COLOR, string> = {
  paper: "Page and card background",
  surface: "Tables, the HUD panel",
  ink: "Text, meaning-carrying rules, Dockhand's data",
  gray: "Secondary text, comparison data",
  faint: "Present but not in play",
  hair: "Hairlines, gridlines",
  rule: "Panel borders, screenshot frames",
  accent: "Once per frame, only what Dockhand did",
  error: "Only a real failure",
};

export const DOS = [
  "State the finding in the title; put the unit in the subtitle and the source in a footnote.",
  "One line per surface is big enough to read when it is a third of the frame. Everything else is for the reader up close.",
  "Hierarchy from size and weight: a masthead, a title, one summary sentence, then hairline tables.",
  "Say status in words: Fixed, Verified, Stopped, Waiting for you. Add who, time and cost: Fixed · Muse Spark Open · 2.7 s · $0.0029.",
  "Numbers and IDs in Geist Mono, tabular. Money at the ledger's precision; a true zero is $0.00.",
  "Label every series where it ends. Ink is Dockhand, gray the comparison, dashed gray a projection.",
  "Align everything to the left edge of the grid. Corners 0 to 4 px. Hard cuts, 150 ms fades, one push-in per shot.",
];

export const DONTS = [
  "Endpoint dots, markers or circles on lines; circle icons, circle avatars, status dots.",
  "Waffle or unit-square grids; a row of stat tiles with a big number over a tiny caption.",
  "Pill badges; boxes that are all rounded with the same soft shadow; glass, glow, gradient, blur.",
  "Centered hero headlines; letter-spaced capital eyebrows; decorative arrows, checkmarks and glyphs; emoji.",
  "Ellipsis truncation in anything the reader needs: shorten the copy or let it wrap.",
  "Counting-up numbers, bouncy easing, blur-in. A number on screen is always a measured one.",
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
        `<div class="sw"><i style="background:${COLOR[k]}${k === "paper" || k === "surface" ? ";outline:1px solid #CFCCC4;outline-offset:-1px" : ""}"></i><b>${k}</b><span class="dh-num">${COLOR[k]}</span><em>${ROLE[k]}</em></div>`,
    )
    .join("");
  const typeRow = (scale: "ui" | "film") =>
    Object.entries(TYPE[scale])
      .filter(([k]) => scale === "ui" || k !== "mark")
      .map(
        ([k, v]) =>
          `<tr><td class="k">${k}</td><td class="r dh-num">${v} px</td><td style="white-space:nowrap"><span style="font-size:${Math.min(v, 72)}px;font-weight:${v >= (scale === "ui" ? 24 : 64) ? 600 : 400};letter-spacing:${v >= 24 ? "-0.02em" : "0"};line-height:1.1">Nothing to do.</span></td></tr>`,
      )
      .join("");
  const spaces = SPACE.slice(1, 13)
    .map((v) => `<div class="sp"><i style="width:${v}px"></i><span class="dh-num">${v}</span></div>`)
    .join("");
  const demoChanges = changes([
    { was: "Product", now: "Solution", by: "Muse Spark Open, 2.7 s", accent: true },
    { was: "Submit registration", now: "Register opportunity", by: "Muse Spark Open, 2.4 s" },
    { was: "Solution", now: "Offering", by: "Stored selector" },
  ]);
  const demoFacts = facts(
    [
      ["Status", `${status("Fixed")} · Muse Spark Open · ${num("2.7 s")} · ${num("$0.0029")}`],
      ["Fields verified", num("13 of 13")],
      ["Undo", num("/rollback register_partner_deal 1")],
    ],
    { html: true },
  );
  const gallery = (items: { name: string; src: string }[] | undefined, w: number) =>
    (items ?? [])
      .map(
        (i) =>
          `<figure style="width:${w}px"><img src="${esc(i.src)}"><figcaption>${esc(i.name)}</figcaption></figure>`,
      )
      .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fontFaceCss()}${cssVariables("ui")}${COMPONENT_CSS}
body{margin:0;background:var(--dh-paper)}
.sheet{width:2400px;padding:96px 120px 120px}
.sheet h1{font-size:72px;font-weight:600;letter-spacing:-.03em;line-height:1}
.sheet .lede{margin-top:20px;font-size:24px;line-height:1.4;max-width:1200px}
.sheet h2{margin:80px 0 20px;padding-top:16px;border-top:2px solid var(--dh-ink);font-size:32px;font-weight:600;letter-spacing:-.02em}
.sheet h3{margin:0 0 12px;font-size:17px;font-weight:600}
.cols{display:grid;grid-template-columns:repeat(3,1fr);gap:48px}
.sw{display:grid;grid-template-columns:120px 1fr;grid-template-rows:auto auto auto;column-gap:20px;margin-bottom:20px}
.sw i{grid-row:1/4;width:120px;height:80px;display:block}
.sw b{font-weight:600;font-size:17px}.sw em{font-style:normal;color:var(--dh-gray);font-size:15px}
.sp{display:flex;align-items:center;gap:16px;height:26px}.sp i{display:block;height:12px;background:var(--dh-ink)}
.sp span{font-size:13px;color:var(--dh-gray)}
.rules div{margin-bottom:28px;font-size:15px}.rules hr{border:0;margin:10px 0 0}
.gal{display:flex;flex-wrap:wrap;gap:32px}.gal img{width:100%;display:block;border:1px solid var(--dh-rule)}
.gal figcaption{margin-top:8px;font-size:15px;color:var(--dh-gray)}
.do{list-style:none}.do li{padding:10px 0;border-top:1px solid var(--dh-hair);font-size:17px;line-height:1.45}
.demo{max-width:540px}
</style></head><body class="dh"><div class="sheet">
<h1>Dockhand design system</h1>
<p class="lede">One source for every surface Dockhand draws: the WhatsApp cards, the HUD, the flight recorder and the film. Paper, ink and one gray carry everything; the accent marks only what Dockhand did. It reads like a receipt or a changelog, not a dashboard.</p>
<h2>Color</h2><div class="cols">${swatches}</div>
<h2>Type: Geist and Geist Mono, 600 for display at -2%, sentence case, tabular figures</h2>
<div class="cols" style="grid-template-columns:1fr 1fr"><div><h3>ui scale (CSS px): cards, HUD, recorder</h3><table class="dh-table">${typeRow("ui")}</table></div>
<div><h3>film scale (px of a 1080p frame): must-read text is 40 px or more</h3><table class="dh-table">${typeRow("film")}</table></div></div>
<h2>Space, corners, rules, grid, motion</h2>
<div class="cols"><div><h3>Spacing, 4 px base</h3>${spaces}</div>
<div class="rules"><h3>Corners and rules</h3>
<div>Corners: ${Object.entries(RADIUS)
    .map(([k, v]) => `${k} ${num(`${v} px`)}`)
    .join(", ")}. Nothing rounder.</div>
<div>Hairline, ${num("1 px")} ${COLOR.hair}: rows, gridlines<hr style="border-top:1px solid ${COLOR.hair}"></div>
<div>Rule, ${num("1 px")} ${COLOR.rule}: panel and screenshot edges<hr style="border-top:1px solid ${COLOR.rule}"></div>
<div>Ink rule, ${num("1 px")} card / ${num("2 px")} film: a table's top, a chart's zero line<hr style="border-top:2px solid ${COLOR.ink}"></div></div>
<div class="rules"><h3>Grid and motion</h3>
<div>Film: ${num(`${GRID.film.columns} columns`)}, ${num(`${GRID.film.margin} px`)} margins, ${num(`${GRID.film.gutter} px`)} gutters, everything left-aligned.</div>
<div>Card: ${num(`${GRID.card.width} x ${GRID.card.height}`)} CSS px at 2x (4:5), ${num(`${GRID.card.margin} px`)} margins.</div>
<div>Motion: hard cuts; overlays fade in over ${num(`${MOTION.fadeMs} ms`)}; at most one push-in per shot, ${num(`${MOTION.pushMs} ms`)} ease-out, up to ${num(`${MOTION.pushMaxScale}x`)}.</div></div></div>
<h2>Components</h2>
<div class="cols"><div class="demo"><h3>Title and one-sentence summary</h3><div class="dh-title" style="margin:0">Caravela Partner Hub changed overnight.</div><div class="dh-display">Nothing to do.</div><p class="dh-summary">Two controls changed; models found the new ones. 5 of 5 dry runs passed before version 4 went live.</p></div>
<div class="demo"><h3>Change rows: before, now, who fixed it</h3>${demoChanges}</div>
<div class="demo"><h3>Data table, status in words, numbers in tabular mono</h3>${demoFacts}</div></div>
<h2>Phone cards</h2><div class="gal">${gallery(img.cards, 400)}</div>
<h2>Film: charts, caption band, end card, HUD</h2><div class="gal">${gallery(img.frames, 1060)}</div>
<h2>Do and don't</h2><div class="cols" style="grid-template-columns:1fr 1fr"><div><h3>Do</h3><ul class="do">${DOS.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div>
<div><h3>Don't</h3><ul class="do">${DONTS.map((d) => `<li>${esc(d)}</li>`).join("")}</ul></div></div>
</div></body></html>`;
}

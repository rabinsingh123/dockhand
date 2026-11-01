// Phone cards: every image Dockhand sends in WhatsApp (teach, plan, submit, question, receipt, new skill, repair,
// drift watch). One design system, one renderer: a 4:5 card, 540 x 675 CSS px at 2x, so the PNG is 1080 x 1350,
// exactly what WhatsApp shows uncropped in the chat bubble.
//
// Light and editorial, like every real surface in the film: paper, ink, one gray, hairlines, Geist and Geist Mono
// (bundled in packages/orchestrator/assets/fonts, SIL OFL, inlined so a render never touches the network). In the
// demo video a card is seen at phone scale inside a 1080p frame, about a third of its size, so each card has one
// big figure the viewer can read there; the rest is for the rep on the phone. The accent appears at most once
// per card and only where Dockhand acted. No gradients, glows, shadows, icons or emoji.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import type {
  ArtifactRef,
  ArtifactStore,
  BBox,
  Db,
  HealRung,
  Id,
  Ledger,
  Skill,
  SkillDraft,
  StepResult,
} from "@dockhand/core";
import { displayName, stepTarget } from "@dockhand/skills";

const run = promisify(execFile);

export const PHONE_CARD_WIDTH = 540;
export const PHONE_CARD_HEIGHT = 675;
export const PHONE_CARD_SCALE = 2;

/** renderHtml from the browser pool (scale honored); a renderer without `scale` gives a 1x image. */
export type PhoneRender = (
  html: string,
  size: { w: number; h: number },
  opts?: { fullPage?: boolean; scale?: number },
) => Promise<Uint8Array>;

export interface PhoneCards {
  /** Renders a phone card (one of the templates below) to a stored PNG. */
  render(jobId: Id, html: string): Promise<ArtifactRef>;
}

export function createPhoneCards(deps: { artifacts: ArtifactStore; render: PhoneRender }): PhoneCards {
  return {
    async render(jobId, html) {
      const png = await deps.render(
        html,
        { w: PHONE_CARD_WIDTH, h: PHONE_CARD_HEIGHT },
        { fullPage: false, scale: PHONE_CARD_SCALE },
      );
      return deps.artifacts.put(png, "image/png", { kind: "receipt", jobId });
    },
  };
}

// ---------- shared formatting ----------

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Money as the ledger recorded it, with enough precision that a paid call never reads as free: $0.0029,
 * $0.096, $0.30. Only a true zero is "$0.00".
 */
export function money(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "$0.00";
  if (v < 0.0001) return "<$0.0001";
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 0.1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** "3.1 s" under a minute, "2 min 5 s" above. */
export function seconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0.0 s";
  if (s < 59.95) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** A param name as a label: "end_customer_company" -> "End customer company". */
export const label = (name: string) => cap(name.replace(/_/g, " "));

// ---------- counts: one source for every number about a draft or a skill ----------

/**
 * What a teach draft holds, as the teach card and the teach message both say it: `steps` are the plain-language
 * steps written from the video, `values` every value the person typed or picked in it.
 */
export function draftCounts(d: Pick<SkillDraft, "steps" | "params">): {
  steps: number;
  values: number;
  required: number;
} {
  return {
    steps: d.steps.length,
    values: d.params.length,
    required: d.params.filter((p) => p.required).length,
  };
}

const FIELD_OPS = new Set(["fill", "select", "check", "upload"]);

/**
 * What a compiled skill holds, as the skill card, its message and the code view say it: `steps` are program steps
 * (navigation, fields, submit), `values` the inputs a request supplies, `fields` the steps that write a form field,
 * which is what a replay reads back before submitting ("13/13 fields verified").
 */
export function skillCounts(s: Pick<Skill, "steps" | "params">): {
  steps: number;
  values: number;
  fields: number;
} {
  return {
    steps: s.steps.length,
    values: s.params.length,
    fields: s.steps.filter((st) => FIELD_OPS.has(st.op)).length,
  };
}

// ---------- fonts and styles ----------

function font(file: string): string {
  try {
    const bytes = readFileSync(new URL(`../../assets/fonts/${file}`, import.meta.url));
    return `url(data:font/woff2;base64,${bytes.toString("base64")}) format("woff2")`;
  } catch {
    return "local(Arial)"; // the font files ship with the repo; this only keeps a broken checkout rendering
  }
}

let fontCss: string | undefined;
function fonts(): string {
  fontCss ??=
    `@font-face{font-family:"Geist";src:${font("Geist-Variable.woff2")};font-weight:100 900;font-display:block}` +
    `@font-face{font-family:"Geist Mono";src:${font("GeistMono-Variable.woff2")};font-weight:100 900;font-display:block}`;
  return fontCss;
}

/** The palette. ACCENT: at most once per card, only where Dockhand acted. ERROR: only for a real failure. */
export const INK = "#111111";
export const GRAY = "#6B6B6B";
export const PAPER = "#F6F5F1";
export const HAIR = "#E3E1DB";
export const ACCENT = "#FF4F00";
export const ERROR = "#B42318";

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:${PAPER}}
body{width:${PHONE_CARD_WIDTH}px;height:${PHONE_CARD_HEIGHT}px;overflow:hidden;font:400 16px/1.4 "Geist",system-ui,sans-serif;color:${INK};-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.card{height:${PHONE_CARD_HEIGHT}px;padding:26px 30px 22px;display:flex;flex-direction:column}
.card>*{flex-shrink:0}
.top{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding-bottom:13px;border-bottom:1px solid ${HAIR};white-space:nowrap}
.wm{font-weight:600;font-size:19px;letter-spacing:-.045em}
.ctx{font-size:15px;font-weight:500;color:${GRAY};overflow:hidden;text-overflow:ellipsis}
h1{margin-top:18px;font-weight:600;font-size:28px;line-height:1.12;letter-spacing:-.02em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.sub{margin-top:6px;font-size:16px;color:${GRAY};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mono{font-family:"Geist Mono",ui-monospace,monospace;letter-spacing:-.01em}
.fig{margin-top:18px}
.fig b{display:block;font-weight:600;font-size:92px;line-height:.9;letter-spacing:-.045em;white-space:nowrap}
.fig b.m{font-family:"Geist Mono",ui-monospace,monospace;font-size:62px;line-height:1;letter-spacing:-.045em}
.fig b.t{font-size:68px;line-height:.98;letter-spacing:-.04em}
.fig span{display:block;margin-top:8px;font-size:17px;color:${GRAY}}
.a{color:${ACCENT}}
.facts{display:flex;margin-top:18px;border-top:1px solid ${HAIR};border-bottom:1px solid ${HAIR}}
.facts div{flex:1;padding:10px 0 9px;min-width:0}
.facts div+div{padding-left:14px;border-left:1px solid ${HAIR}}
.facts b{display:block;font:600 20px/1.15 "Geist Mono",ui-monospace,monospace;letter-spacing:-.02em;white-space:nowrap}
.facts span{display:block;margin-top:2px;font-size:13.5px;color:${GRAY};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.h{margin-top:18px;margin-bottom:7px;font-size:14px;font-weight:500;color:${GRAY}}
.list{background:#fff;border:1px solid ${HAIR};border-radius:8px;overflow:hidden}
.row{display:grid;grid-template-columns:44% minmax(0,1fr);gap:10px;padding:6px 12px;font-size:14.5px;line-height:1.35}
.row+.row{border-top:1px solid ${HAIR}}
.row .k{color:${GRAY};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row .v{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row.more .k{grid-column:1/-1}
.cols{display:grid;grid-template-columns:1fr 1fr;column-gap:16px}
.cols div{padding:5px 0;font-size:14.5px;border-top:1px solid ${HAIR};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cols div i{font-style:normal;color:${GRAY}}
.frames{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:16px}
.frames figure{line-height:0}
.frames img{width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top;border:1px solid ${HAIR};border-radius:6px;background:#fff}
.frames figcaption{margin-top:5px;font:500 12.5px/1.2 "Geist Mono",ui-monospace,monospace;color:${GRAY}}
.shot{position:relative;margin-top:16px;border:1px solid ${HAIR};border-radius:8px;overflow:hidden;background:#fff;line-height:0}
.shot img{width:100%;display:block;object-fit:cover;object-position:top}
.shot .hl{position:absolute;border:2.5px solid ${ACCENT};border-radius:4px}
.chg{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:12px;padding:8px 12px;font-size:15.5px}
.chg+.chg{border-top:1px solid ${HAIR}}
.chg.on{box-shadow:inset 3px 0 0 ${ACCENT}}
.chg .w{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chg .old{color:${GRAY};text-decoration:line-through;text-decoration-thickness:1px}
.chg .to{color:${GRAY};margin:0 6px}
.chg .new{font-weight:600}
.chg .r{font-size:13.5px;color:${GRAY};white-space:nowrap}
.opts{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.opts span{padding:6px 12px;border:1px solid ${HAIR};border-radius:999px;background:#fff;font-size:15px;font-weight:500}
.note{margin-top:14px;font-size:15px;color:${GRAY};line-height:1.4}
.note b{color:${INK};font-weight:500}
.err{color:${ERROR}}
.foot{margin-top:auto;padding-top:11px;border-top:1px solid ${HAIR};display:flex;justify-content:space-between;align-items:baseline;gap:14px;font-size:13.5px;color:${GRAY};white-space:nowrap}
.foot span{overflow:hidden;text-overflow:ellipsis}
.foot .mono{color:${INK}}
`;

// ---------- the skeleton ----------

export interface PhoneCardSpec {
  /** Right of the wordmark, sentence case: "Learned from your video", "Drift watch". */
  context: string;
  title: string;
  sub?: string;
  /** The one figure a viewer can read at phone scale in the film. `accent` only where Dockhand acted. */
  figure?: { value: string; label?: string; style?: "number" | "mono" | "text"; accent?: boolean };
  /** Trusted markup built with the helpers below (escape any data in it). */
  body?: string;
  /** Left and right of the bottom line. Trusted markup. */
  foot?: [string, (string | undefined)?];
}

/** The reusable 4:5 card. Returns a full HTML document. */
export function phoneCardHtml(c: PhoneCardSpec): string {
  const f = c.figure;
  const fig = f
    ? `<div class="fig"><b class="${f.style === "mono" ? "m" : f.style === "text" ? "t" : ""}${f.accent ? " a" : ""}">${esc(f.value)}</b>${f.label ? `<span>${esc(f.label)}</span>` : ""}</div>`
    : "";
  const foot = c.foot
    ? `<div class="foot"><span>${c.foot[0]}</span>${c.foot[1] ? `<span>${c.foot[1]}</span>` : ""}</div>`
    : "";
  return `<!doctype html><html><head><meta charset="utf-8"><style>${fonts()}${CSS}</style></head><body><div class="card">
<div class="top"><span class="wm">Dockhand</span><span class="ctx">${esc(c.context)}</span></div>
<h1>${esc(c.title)}</h1>${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ""}
${fig}${c.body ?? ""}
${foot}
</div></body></html>`;
}

/** A label/value table; past `max` rows, a "+N more" row. */
export function rowsHtml(rows: [string, string][], max: number): string {
  const shown = rows.length > max ? rows.slice(0, max - 1) : rows;
  const more = rows.length - shown.length;
  return `<div class="list">${shown
    .map(
      ([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`,
    )
    .join("")}${more > 0 ? `<div class="row more"><span class="k">+${more} more</span></div>` : ""}</div>`;
}

/** Facts in a row between hairlines: [value, label]. Values are set in Geist Mono. */
export function factsHtml(facts: [string, string][]): string {
  return `<div class="facts">${facts.map(([v, l]) => `<div><b>${esc(v)}</b><span>${esc(l)}</span></div>`).join("")}</div>`;
}

const png = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;
const jpeg = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;

/** Width and height from a PNG header, or undefined for anything else. */
export function pngSize(b: Uint8Array): { w: number; h: number } | undefined {
  if (b.length < 24 || b[0] !== 0x89 || b[1] !== 0x50) return undefined;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

/**
 * A real screenshot of the page, cropped to `height` CSS px from `focusY` (0..1 of the image). `highlight`
 * outlines the control Dockhand will act on, in the accent.
 */
export function shotHtml(
  bytes: Uint8Array,
  o: { height: number; focusY?: number; highlight?: BBox; width?: number },
): string {
  const size = pngSize(bytes);
  const w = o.width ?? PHONE_CARD_WIDTH - 60 - 2;
  const scale = size ? w / size.w : 1;
  const fullH = size ? size.h * scale : o.height;
  const top = Math.max(0, Math.min(fullH - o.height, (o.focusY ?? 0) * fullH - o.height / 2));
  const hl =
    o.highlight && size
      ? `<span class="hl" style="left:${(o.highlight.x * scale - 4).toFixed(1)}px;top:${(o.highlight.y * scale - top - 4).toFixed(1)}px;width:${(o.highlight.w * scale + 8).toFixed(1)}px;height:${(o.highlight.h * scale + 8).toFixed(1)}px"></span>`
      : "";
  return `<div class="shot" style="height:${o.height}px"><img src="${png(bytes)}" style="width:${w}px;height:${fullH.toFixed(1)}px;margin-top:${(-top).toFixed(1)}px">${hl}</div>`;
}

// ---------- frames from a video ----------

/** Length of a video in seconds (from ffmpeg's banner), or undefined. */
export async function videoDuration(ffmpeg: string, src: string): Promise<number | undefined> {
  const probe = await run(ffmpeg, ["-hide_banner", "-i", src], { timeout: 10_000, windowsHide: true }).catch(
    (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(probe.stderr));
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : undefined;
}

/** The teach recording's frames and length for the card; nothing when the file or ffmpeg is unavailable. */
export async function teachFrames(
  deps: { artifacts: ArtifactStore; ffmpegPath: string },
  video: ArtifactRef,
  n = 3,
): Promise<{ frames: Uint8Array[]; durationS?: number }> {
  try {
    const src = deps.artifacts.absPath(video);
    const durationS = await videoDuration(deps.ffmpegPath, src);
    return { frames: await videoFrames(deps.ffmpegPath, src, n), ...(durationS ? { durationS } : {}) };
  } catch {
    return { frames: [] };
  }
}

/** `n` frames sampled evenly across a video, as JPEG bytes; [] when ffmpeg or the file is unavailable. */
export async function videoFrames(ffmpeg: string, src: string, n = 4): Promise<Uint8Array[]> {
  try {
    const dur = await videoDuration(ffmpeg, src);
    if (!dur) return [];
    const out: Uint8Array[] = [];
    for (let i = 0; i < n; i++) {
      const t = ((i + 0.5) / n) * dur;
      const r = await run(
        ffmpeg,
        [
          "-v",
          "error",
          "-ss",
          t.toFixed(2),
          "-i",
          src,
          "-frames:v",
          "1",
          "-vf",
          "scale=520:-2",
          "-q:v",
          "3",
        ].concat(["-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]),
        { encoding: "buffer", timeout: 15_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      if (r.stdout.length > 0) out.push(new Uint8Array(r.stdout));
    }
    return out;
  } catch {
    return [];
  }
}

function clock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** "{{company_name}}" in a step becomes the value's label; the rest is escaped. */
export function withParams(text: string): string {
  return text
    .split(/(\{\{[a-z][a-z0-9_]*(?:\|[^}]*)?\}\})/g)
    .map((p) =>
      /^\{\{.*\}\}$/.test(p) ? `<b>${esc(label(p.slice(2, -2).split("|")[0] ?? ""))}</b>` : esc(p),
    )
    .join("");
}

// ---------- teach: what Muse saw ----------

export interface TeachCardOptions {
  portalName: string;
  /** Frames sampled evenly from the recording (videoFrames). */
  frames?: Uint8Array[];
  /** Recording length in seconds, for the frame timestamps and the subtitle. */
  durationS?: number;
}

/** Values listed on the card, required ones first. */
const TEACH_VALUES = 8;

export function teachPhoneCardHtml(d: SkillDraft, o: TeachCardOptions): string {
  const n = draftCounts(d);
  const frames = (o.frames ?? []).slice(0, 3);
  const ordered = [...d.params.filter((p) => p.required), ...d.params.filter((p) => !p.required)];
  const shown = ordered.length > TEACH_VALUES ? ordered.slice(0, TEACH_VALUES - 1) : ordered;
  const more = ordered.length - shown.length;
  const strip = frames.length
    ? `<div class="frames">${frames
        .map(
          (f, i) =>
            `<figure><img src="${jpeg(f)}"><figcaption>${o.durationS ? clock(((i + 0.5) / frames.length) * o.durationS) : `${i + 1}/${frames.length}`}</figcaption></figure>`,
        )
        .join("")}</div>`
    : "";
  const values = `<div class="h">Values it will ask for, required first</div><div class="cols">${shown
    .map((p) => `<div>${esc(label(p.name))}${p.required ? "" : " <i>optional</i>"}</div>`)
    .join("")}${more > 0 ? `<div><i>+${more} more</i></div>` : ""}</div>`;
  const from = o.durationS ? `your ${Math.round(o.durationS)} s video` : "your video";
  return phoneCardHtml({
    context: "Learned from your video",
    title: d.title,
    sub: `on ${o.portalName}`,
    figure: {
      value: String(n.values),
      label: `values seen in ${from} · ${n.required} required · ${n.steps} steps`,
      accent: true,
    },
    body: strip + values,
    foot: [`Submits with “${esc(d.commitStep)}” only after your tap`],
  });
}

// ---------- plan: what will be written where ----------

export interface PlanCardView {
  title: string;
  /** "Caravela Partner Hub", "HubSpot". */
  where: string;
  /** "Replay of register_partner_deal v1, no model calls". */
  how: string;
  figure: { value: string; label: string };
  rows: [string, string][];
  /** Bottom line: the safety fact ("Nothing is submitted until you approve the filled form"). */
  foot: string;
}

export function planPhoneCardHtml(v: PlanCardView): string {
  return phoneCardHtml({
    context: "Plan · needs your OK",
    title: v.title,
    sub: `${v.where} · ${v.how}`,
    figure: { value: v.figure.value, label: v.figure.label },
    body: `<div class="h">What I will write</div>${rowsHtml(v.rows, 8)}`,
    foot: [esc(v.foot)],
  });
}

// ---------- submit: the filled form, before the tap ----------

export interface SubmitCardView {
  portalName: string;
  /** The filled form, as the approval screenshot shows it. */
  screenshot?: Uint8Array;
  /** The submit control Dockhand will click (outlined in the accent). */
  highlight?: BBox;
  /** Values read back from the page right now. */
  readback: { label: string; value: string }[];
}

export function submitPhoneCardHtml(v: SubmitCardView): string {
  const lines = v.readback.filter((f) => f.value.trim() !== "" && f.value !== "false");
  const shot = v.screenshot
    ? shotHtml(v.screenshot, {
        height: lines.length ? 150 : 330,
        focusY:
          v.highlight && pngSize(v.screenshot)
            ? (v.highlight.y + v.highlight.h / 2) / (pngSize(v.screenshot)?.h ?? 1)
            : 0.5,
        ...(v.highlight ? { highlight: v.highlight } : {}),
      })
    : "";
  return phoneCardHtml({
    context: "Ready to submit",
    title: `Filled on ${v.portalName}`,
    figure: lines.length
      ? { value: String(lines.length), label: "fields read back from the page, listed below" }
      : { value: "Review page", label: "a wizard's last page has nothing to read back", style: "text" },
    body:
      shot +
      (lines.length
        ? `<div class="h">On the page now</div>${rowsHtml(
            lines.map((f) => [f.label, f.value]),
            v.screenshot ? 5 : 10,
          )}`
        : ""),
    foot: ["Nothing is sent until you tap Approve"],
  });
}

// ---------- question: the app needs something new ----------

export interface AskCardView {
  portalName: string;
  /** The new field's label ("Partner tier"). */
  label: string;
  options: string[];
  screenshot?: Uint8Array;
}

export function askPhoneCardHtml(v: AskCardView): string {
  const opts = v.options.filter((o) => o.trim() !== "");
  return phoneCardHtml({
    context: "Needs your answer",
    title: `${v.portalName} added a required field`,
    figure: { value: v.label, label: "Which one should I use?", style: "text" },
    body:
      (opts.length
        ? `<div class="opts">${opts
            .slice(0, 6)
            .map((o) => `<span>${esc(o)}</span>`)
            .join("")}${opts.length > 6 ? `<span>+${opts.length - 6} more</span>` : ""}</div>`
        : "") + (v.screenshot ? shotHtml(v.screenshot, { height: 250, focusY: 0.55 }) : ""),
    foot: ["You answer once. It becomes the default.", "Nothing submitted yet"],
  });
}

// ---------- receipt ----------

export type ReceiptTier = "api" | "replay" | "agentic" | "repair";

export interface ReceiptCardView {
  title: string;
  tier: ReceiptTier;
  /** The record ID ("NW-REG-48221"), set big in Geist Mono. */
  headline?: string;
  /** One short line under the figure. */
  line?: string;
  seconds: number;
  execCostUsd: number;
  intakeCostUsd: number;
  skill?: { name: string; version: number };
  verified?: { matched: number; checked: number };
  usedOpenWeights?: boolean;
  /** The portal's own confirmation page. */
  screenshot?: Uint8Array;
}

export const TIER_LABEL: Record<ReceiptTier, string> = {
  api: "API",
  replay: "Replay · compiled skill",
  agentic: "First run · computer use",
  repair: "Replay · repaired",
};

export function receiptPhoneCardHtml(r: ReceiptCardView): string {
  const looksLikeId =
    r.headline !== undefined && /^[A-Z0-9][A-Z0-9-]{4,}$/.test(r.headline) && /\d/.test(r.headline);
  const facts: [string, string][] = [
    ...(r.verified
      ? [[`${r.verified.matched}/${r.verified.checked}`, "fields verified"] as [string, string]]
      : []),
    [seconds(r.seconds), "machine time"],
    [money(r.execCostUsd), "to run"],
    [money(r.intakeCostUsd), "intake"],
  ];
  return phoneCardHtml({
    context: TIER_LABEL[r.tier],
    title: r.title,
    ...(r.line ? { sub: r.line } : {}),
    ...(r.headline
      ? {
          figure: {
            value: r.headline,
            style: looksLikeId ? "mono" : "text",
            accent: true,
            label: "Submitted after your approval",
          },
        }
      : {}),
    body:
      factsHtml(facts.slice(0, 4)) +
      (r.screenshot ? shotHtml(r.screenshot, { height: r.headline ? 250 : 340, focusY: 0.3 }) : ""),
    foot: [
      r.skill ? `<span class="mono">${esc(r.skill.name)} v${r.skill.version}</span>` : "Synthetic demo data",
      r.usedOpenWeights ? "Built with Muse Spark Open" : undefined,
    ],
  });
}

// ---------- new skill: the program it wrote ----------

export interface SkillCardView {
  skill: Pick<Skill, "name" | "version" | "title" | "params" | "steps">;
  portalName: string;
  verified: { passed: number; total: number };
  /** The teach draft it was compiled from, so the card can say how the video's counts became the program's. */
  draft?: Pick<SkillDraft, "steps" | "params">;
}

export function skillPhoneCardHtml(v: SkillCardView): string {
  const n = skillCounts(v.skill);
  const from = v.draft ? draftCounts(v.draft) : undefined;
  const unused = v.draft ? v.draft.params.filter((p) => !v.skill.params.some((q) => q.name === p.name)) : [];
  const ordered = [...v.skill.params.filter((p) => p.required), ...v.skill.params.filter((p) => !p.required)];
  return phoneCardHtml({
    context: "New skill",
    title: v.skill.title,
    sub: `on ${v.portalName}`,
    figure: { value: "0", label: "model calls when it replays", accent: true },
    body:
      factsHtml([
        [String(n.steps), "program steps"],
        [String(n.values), "values per request"],
        [`${v.verified.passed}/${v.verified.total}`, "dry runs passed"],
      ]) +
      (from
        ? `<div class="note">Compiled from the first run: your video's <b>${from.steps} steps</b> became <b>${n.steps} program steps</b>, and its <b>${from.values} values</b> became <b>${n.values}</b>${unused.length ? ` (${esc(unused.map((p) => label(p.name)).join(", "))} not needed)` : ""}.</div>`
        : "") +
      `<div class="h">Values per request</div><div class="cols">${ordered
        .slice(0, ordered.length > 6 ? 5 : 6)
        .map((p) => `<div>${esc(label(p.name))}${p.required ? "" : " <i>optional</i>"}</div>`)
        .join("")}${ordered.length > 6 ? `<div><i>+${ordered.length - 5} more</i></div>` : ""}</div>`,
    foot: [`<span class="mono">${esc(v.skill.name)} v${v.skill.version}</span>`],
  });
}

// ---------- repair and drift watch: v1 -> v2 ----------

const RUNG_TEXT: Record<HealRung, string> = {
  fallback: "stored selector, free",
  similarity: "similarity, free",
  open_weights: "Muse Spark Open",
  computer_use: "Muse computer use",
  ask_rep: "your answer",
};
const PAID: HealRung[] = ["open_weights", "computer_use"];

export interface DiffCardInput {
  portalName: string;
  parent: Pick<Skill, "name" | "version" | "steps" | "params">;
  saved: Pick<Skill, "name" | "version" | "title" | "steps" | "params">;
  /** The run's step results (rung per step id). */
  steps: StepResult[];
  canary: { passed: number; total: number };
  /** The repairing run's cost from the ledger (diffCardLedger). */
  costUsd: number;
  usedOpenWeights?: boolean;
  /** The drift watch's card: found and fixed on a schedule, before anyone noticed. */
  watch?: { when?: string };
}

/**
 * The repair cost as the card may state it: the ledger's value at full precision. A run that used a paid rung
 * but recorded no cost (the fake stand-in in tests) shows no figure at all, never "$0".
 */
export function repairCost(v: Pick<DiffCardInput, "steps" | "costUsd">): string | undefined {
  const paid = v.steps.some((s) => s.rung && PAID.includes(s.rung));
  if (v.costUsd > 0) return money(v.costUsd);
  return paid ? undefined : "$0.00";
}

/** "Built with Muse Spark Open" only when Baseten really served a heal for this job or run. */
export function basetenHeal(db: Db, jobId: Id, runId: Id): boolean {
  return (
    db.raw
      .prepare(
        "SELECT 1 FROM model_calls WHERE purpose = 'heal_match' AND provider = 'baseten' AND (job_id = ? OR run_id = ?) LIMIT 1",
      )
      .get(jobId, runId) !== undefined
  );
}

/** What a repair card may say about money and models: only what the ledger recorded for this run. */
export function diffCardLedger(
  env: { db: Db; ledger: Ledger },
  jobId: Id,
  runId: Id,
): { costUsd: number; usedOpenWeights: boolean } {
  return {
    costUsd: env.ledger.totals({ runId }).costUsd,
    usedOpenWeights: basetenHeal(env.db, jobId, runId),
  };
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Change rows on the card; past this, a "+N more" row. */
const MAX_CHANGES = 4;

export function diffPhoneCardHtml(v: DiffCardInput): string {
  const rungOf = new Map(v.steps.flatMap((s) => (s.rung ? [[s.stepId, s.rung] as const] : [])));
  const before = new Map(v.parent.steps.map((s) => [s.id, s]));
  const named: { html: string; paid: boolean }[] = [];
  let free = 0;
  for (const s of v.saved.steps) {
    const rung = rungOf.get(s.id);
    if (!rung) continue;
    const old = before.get(s.id);
    const a = old ? displayName(stepTarget(old)?.fingerprint) : "";
    const b = displayName(stepTarget(s)?.fingerprint);
    if ((rung === "fallback" || rung === "similarity") && (!a || a === b)) {
      free++;
      continue;
    }
    const what =
      rung === "ask_rep" || !old
        ? `<span class="new">New: ${esc(clip(b || s.intent, 30))}</span>`
        : a && a !== b
          ? `<span class="old">${esc(clip(a, 20))}</span><span class="to">→</span><span class="new">${esc(clip(b, 22))}</span>`
          : `<span class="new">${esc(clip(b || s.intent, 26))}</span> <span class="old" style="text-decoration:none">moved</span>`;
    named.push({
      html: `<span class="w">${what}</span><span class="r">${esc(RUNG_TEXT[rung])}</span>`,
      paid: PAID.includes(rung),
    });
  }
  // The accent marks the one change a model repaired (the first, when several).
  const firstPaid = named.findIndex((x) => x.paid);
  const rows = named.map((x, i) => `<div class="chg${i === firstPaid ? " on" : ""}">${x.html}</div>`);
  const shown =
    rows.length > MAX_CHANGES
      ? [
          ...rows.slice(0, MAX_CHANGES - 1),
          `<div class="chg"><span class="w">+${rows.length - MAX_CHANGES + 1} more changes</span></div>`,
        ]
      : rows;
  if (free > 0)
    shown.push(
      `<div class="chg"><span class="w">${free} other step${free === 1 ? "" : "s"} found again</span><span class="r">stored selectors, free</span></div>`,
    );
  const fixed = rungOf.size;
  const added = v.saved.params.filter((p) => !v.parent.params.some((q) => q.name === p.name));
  const cost = repairCost(v);
  const facts: [string, string][] = [
    [String(fixed), `step${fixed === 1 ? "" : "s"} repaired`],
    [`${v.canary.passed}/${v.canary.total}`, "dry runs passed"],
    ...(cost ? [[cost, "to repair"] as [string, string]] : []),
  ];
  const versions = `v${v.parent.version} → v${v.saved.version}`;
  const watch = v.watch;
  return phoneCardHtml({
    context: watch ? `Drift watch${watch.when ? ` · ${watch.when}` : ""}` : "Skill repaired",
    title: `${v.portalName} changed${watch?.when === "overnight" ? " overnight" : ""}`,
    sub: `${v.saved.name}${watch ? ` ${versions}` : ""}${added.length ? ` · new value: ${added.map((p) => label(p.name)).join(", ")}` : ""}`,
    figure: watch
      ? {
          value: "Nothing to do",
          label: `Repaired and checked with ${v.canary.total} dry runs before anyone noticed`,
          style: "text",
        }
      : { value: versions, label: "repaired, checked, now active", style: "text" },
    body:
      factsHtml(facts) +
      `<div class="h">What changed</div><div class="list">${shown.join("") || '<div class="chg"><span class="w">Selectors refreshed</span></div>'}</div>`,
    foot: [
      `v${v.parent.version} kept: <span class="mono">/rollback ${esc(v.saved.name)} ${v.parent.version}</span>`,
      v.usedOpenWeights ? "Built with Muse Spark Open" : undefined,
    ],
  });
}

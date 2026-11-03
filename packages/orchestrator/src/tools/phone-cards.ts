// Phone cards: every image Dockhand sends in WhatsApp (teach, plan, submit, question, receipt, new skill, repair,
// drift watch). Drawn with @dockhand/design (docs/DESIGN.md): a 4:5 card, 540 x 675 CSS px at 2x, so the PNG is
// 1080 x 1350, exactly what WhatsApp shows uncropped in the chat bubble.
//
// A card is seen about 290 px wide, so it is a poster: one hero, one real picture from the run, and the proof in the
// stub at its foot. What must be read is 28 CSS px or more; only labels and incidental lines are 22. Full detail goes
// in the WhatsApp message under it, where text is always sharp. Black is Dockhand speaking; a whole lemon card is
// reserved for work it finished by itself.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
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
import {
  type Change,
  COLOR,
  changes,
  esc,
  FIT_SCRIPT,
  kicker,
  note,
  rows,
  type StubField,
  stage,
  state,
  stub,
  sub,
  top,
  uiCss,
} from "@dockhand/design";
import { displayName, stepTarget } from "@dockhand/skills";

const run = promisify(execFile);

export { esc };

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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

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

// ---------- the card ----------

/**
 * A whole card document: the top line, then the body, which ends in the stub. `signal` is the lemon ground of a job
 * finished alone.
 */
export function cardHtml(context: string, body: string, o: { signal?: boolean } = {}): string {
  const ground = o.signal ? COLOR.accent : COLOR.ground;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${uiCss()}html,body{margin:0;background:${ground}}</style></head><body class="dh"><main class="dh-card${o.signal ? " signal" : ""}">${top(context)}${body}</main>${FIT_SCRIPT}</body></html>`;
}

/** The generic card (tests and one-off notices): a statement, an optional line, and the summary in the stub. */
export interface PhoneCardSpec {
  context: string;
  title: string;
  line?: string;
  summary?: string;
}

export function phoneCardHtml(c: PhoneCardSpec): string {
  return cardHtml(
    c.context,
    stage(state(esc(c.title)) + (c.line ? sub(esc(c.line)) : "")) +
      stub(c.summary ? [["", c.summary, { wrap: true }]] : []),
  );
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
 * One pixel of an 8-bit RGB or RGBA PNG (what Playwright's screenshots are), or undefined for anything else. Lets a
 * card tell a portal's page layouts apart without a decoder dependency.
 */
export function pngPixel(b: Uint8Array, x: number, y: number): [number, number, number] | undefined {
  const size = pngSize(b);
  if (!size || x < 0 || y < 0 || x >= size.w || y >= size.h) return undefined;
  const depth = b[24];
  const type = b[25];
  if (depth !== 8 || (type !== 2 && type !== 6) || b[28] !== 0) return undefined;
  const bpp = type === 6 ? 4 : 3;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 12 <= b.length; ) {
    const len = v.getUint32(p);
    const kind = String.fromCharCode(b[p + 4] ?? 0, b[p + 5] ?? 0, b[p + 6] ?? 0, b[p + 7] ?? 0);
    if (kind === "IDAT") idat.push(b.subarray(p + 8, p + 8 + len));
    if (kind === "IEND") break;
    p += 12 + len;
  }
  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    return undefined;
  }
  const stride = size.w * bpp;
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  for (let row = 0; row <= y; row++) {
    const off = row * (stride + 1);
    const filter = raw[off];
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const c = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      let pred = 0;
      if (filter === 1) pred = a;
      else if (filter === 2) pred = up;
      else if (filter === 3) pred = (a + up) >> 1;
      else if (filter === 4) {
        const q = a + up - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - up);
        const pc = Math.abs(q - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = ((raw[off + 1 + i] ?? 0) + pred) & 255;
    }
    [prev, cur] = [cur, prev];
  }
  const i = x * bpp;
  return [prev[i] ?? 0, prev[i + 1] ?? 0, prev[i + 2] ?? 0];
}

/** Portal pages keep navigation down the left; a card shows the working area, at a size that can be read. */
const SHOT_SOURCE_WIDTH = 1120;
/** Every run's browser is 1280 CSS px wide (packages/browser), so a crop box is set in those px. */
const PAGE_WIDTH = 1280;

/**
 * A part of the page to show on a card, in CSS px of the 1280 px page: its top-left corner, the scale it is drawn
 * at, and the height it takes on the card. The receipt crops the portal's own confirmation panel this way.
 */
export interface ShotCrop {
  x: number;
  y: number;
  scale: number;
  height: number;
}

/**
 * A real screenshot of the page, edge to edge and cropped to `height` CSS px around `focusY` (0..1 of the image),
 * or to `crop`. `highlight` marks the control Dockhand will act on: a black line inside a lemon band, which reads on
 * a white page where a lemon line alone would not.
 */
export function shotHtml(
  bytes: Uint8Array,
  o: { height: number; focusY?: number; highlight?: BBox; crop?: Omit<ShotCrop, "height"> },
): string {
  const size = pngSize(bytes);
  if (!size) return `<div class="dh-bleed" style="height:${o.height}px"><img src="${png(bytes)}"></div>`;
  let scale: number;
  let left: number;
  let y: number;
  if (o.crop) {
    // The shot may be taken at a device scale above 1: crop boxes are in page px.
    scale = (o.crop.scale * PAGE_WIDTH) / size.w;
    left = o.crop.x * o.crop.scale;
    y = o.crop.y * o.crop.scale;
  } else {
    const shown = Math.min(SHOT_SOURCE_WIDTH, size.w);
    scale = PHONE_CARD_WIDTH / shown;
    const fullH = size.h * scale;
    left = (size.w - shown) * scale;
    y = Math.max(0, Math.min(fullH - o.height, (o.focusY ?? 0) * fullH - o.height / 2));
  }
  const hl = o.highlight
    ? `<span class="hl" style="left:${(o.highlight.x * scale - left - 6).toFixed(1)}px;top:${(o.highlight.y * scale - y - 6).toFixed(1)}px;width:${(o.highlight.w * scale + 12).toFixed(1)}px;height:${(o.highlight.h * scale + 12).toFixed(1)}px"></span>`
    : "";
  return `<div class="dh-bleed" style="height:${o.height}px"><img src="${png(bytes)}" style="width:${(size.w * scale).toFixed(1)}px;left:${(-left).toFixed(1)}px;top:${(-y).toFixed(1)}px">${hl}</div>`;
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

/** "{{company_name}}" in a step becomes the value's label in bold; the rest is escaped. */
export function withParams(text: string): string {
  return text
    .split(/(\{\{[a-z][a-z0-9_]*(?:\|[^}]*)?\}\})/g)
    .map((p) =>
      /^\{\{.*\}\}$/.test(p) ? `<b>${esc(label(p.slice(2, -2).split("|")[0] ?? ""))}</b>` : esc(p),
    )
    .join("");
}

/** The value names on one line, required ones first; past `max`, "N more". */
function valueNames(params: { name: string; required: boolean }[], max: number): string {
  const ordered = [...params.filter((p) => p.required), ...params.filter((p) => !p.required)];
  const shown = ordered.length > max ? ordered.slice(0, max - 1) : ordered;
  const names = shown.map(
    (p) => `${esc(label(p.name))}${p.required ? "" : ' <span class="was">(optional)</span>'}`,
  );
  if (ordered.length > shown.length) names.push(`${ordered.length - shown.length} more`);
  return names.join(", ");
}

/** True when a title already names the portal ("Register a partner deal on Caravela Partner Hub"). */
const namesPortal = (title: string, portalName: string) =>
  title.toLowerCase().includes(portalName.toLowerCase());

// ---------- teach: what Muse saw ----------

export interface TeachCardOptions {
  portalName: string;
  /** Frames sampled evenly from the recording (videoFrames). */
  frames?: Uint8Array[];
  /** Recording length in seconds, for the summary. */
  durationS?: number;
}

export function teachPhoneCardHtml(d: SkillDraft, o: TeachCardOptions): string {
  const n = draftCounts(d);
  const frames = o.frames ?? [];
  const frame = frames[Math.floor(frames.length / 2)];
  const picture = frame
    ? `<div class="dh-bleed" style="height:200px"><img src="${jpeg(frame)}" style="width:100%;left:0;top:0"></div>`
    : "";
  const video = o.durationS ? `your ${Math.round(o.durationS)} s recording` : "your recording";
  return cardHtml(
    "Learned",
    picture +
      stage(
        state(esc(d.title)) +
          (namesPortal(d.title, o.portalName) ? "" : sub(`On ${esc(o.portalName)}`)) +
          note(valueNames(d.params, 6)) +
          note(`Seen in ${esc(video)}.`),
      ) +
      stub([
        ["Values", String(n.values)],
        ["Steps", String(n.steps)],
        ["Submits with", d.commitStep, { wrap: true }],
      ]),
  );
}

// ---------- plan: what will be written where ----------

export interface PlanCardView {
  /** "Register Vila Nova Logística Ltda." */
  title: string;
  /** "Caravela Partner Hub", "HubSpot". */
  where: string;
  /** Every value, labelled, the ones a wrong approval would break first: the card shows the first three. */
  rows: [string, string][];
  /** The proof, in the stub: how many values, how it runs, where it stops ("Stops at", "Final submit"). */
  stub: StubField[];
}

export function planPhoneCardHtml(v: PlanCardView): string {
  return cardHtml("Plan", stage(state(esc(v.title)) + rows(v.rows.slice(0, 3))) + stub(v.stub));
}

// ---------- submit: the filled form, before the tap ----------

export interface SubmitCardView {
  portalName: string;
  /** The filled form, as the approval screenshot shows it. */
  screenshot?: Uint8Array;
  /** The submit control Dockhand will click (marked in the accent). */
  highlight?: BBox;
  /** Values read back from the page right now. */
  readback: { label: string; value: string }[];
}

export function submitPhoneCardHtml(v: SubmitCardView): string {
  const lines = v.readback.filter((f) => f.value.trim() !== "" && f.value !== "false");
  const size = v.screenshot ? pngSize(v.screenshot) : undefined;
  const shot = v.screenshot
    ? shotHtml(v.screenshot, {
        height: 304,
        focusY: v.highlight && size ? (v.highlight.y + v.highlight.h / 2) / size.h : 0.5,
        ...(v.highlight ? { highlight: v.highlight } : {}),
      })
    : "";
  const tap: StubField = ["Nothing is sent until", "You tap Approve"];
  return cardHtml(
    "Your approval",
    shot +
      stage(
        state("Ready to submit") +
          (lines.length
            ? sub(`${plural(lines.length, "field")} filled on ${esc(v.portalName)}`)
            : sub(`Review page on ${esc(v.portalName)}`) +
              note("A wizard’s last page has nothing to read back: check it here.")),
      ) +
      stub(lines.length ? [["Read back", "Just now"], tap] : [tap]),
  );
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
  const list =
    opts.length > 1 ? `${opts.slice(0, -1).join(", ")} or ${opts.at(-1)}` : (opts[0] ?? "any value you type");
  return cardHtml(
    "Question",
    stage(
      state(esc(v.label), { size: "id" }) +
        sub(`Which should I use: ${esc(list)}?`) +
        note(`${esc(v.portalName)} now requires a new field.`),
    ) +
      (v.screenshot ? shotHtml(v.screenshot, { height: 200, focusY: 0.55 }) : "") +
      stub([
        ["Your answer", "Kept from now on"],
        ["Submitted", "Nothing yet"],
      ]),
  );
}

// ---------- receipt ----------

export type ReceiptTier = "api" | "replay" | "agentic" | "repair";

export interface ReceiptCardView {
  title: string;
  tier: ReceiptTier;
  /** The record ID ("NW-REG-48221"), set big. */
  headline?: string;
  /** The status over it ("Deal registered"); "Done" when the flow names none. */
  done?: string;
  /** One short line under the ID. */
  line?: string;
  seconds: number;
  execCostUsd: number;
  intakeCostUsd: number;
  skill?: { name: string; version: number };
  verified?: { matched: number; checked: number };
  usedOpenWeights?: boolean;
  /** The portal's own confirmation page. */
  screenshot?: Uint8Array;
  /** The confirmation panel on that page; without it the card shows the top of the page. */
  crop?: ShotCrop;
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
  const shot = r.screenshot
    ? r.crop
      ? shotHtml(r.screenshot, { height: r.crop.height, crop: r.crop })
      : shotHtml(r.screenshot, { height: 200, focusY: 0.2 })
    : "";
  const big = r.headline ?? r.title;
  const proof: StubField[] = [
    ...(r.verified ? [["Read back", `${r.verified.matched} of ${r.verified.checked}`] as StubField] : []),
    ["Time", seconds(r.seconds)],
    ["Cost", money(r.execCostUsd)],
  ];
  return cardHtml(
    TIER_LABEL[r.tier],
    shot +
      stage(
        kicker(esc(r.done ?? "Done")) +
          state(esc(big), looksLikeId ? { size: "id", nowrap: true } : {}) +
          (r.line ? note(esc(r.line)) : "") +
          (r.usedOpenWeights ? note("Built with Muse Spark Open") : ""),
      ) +
      stub(proof),
  );
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
  return cardHtml(
    "New skill",
    stage(
      state("0 model calls", { size: "id", accent: true }) +
        sub(`each time ${esc(v.skill.title)} replays on ${esc(v.portalName)}.`),
    ) +
      stub([
        ["Program", plural(n.steps, "step")],
        ["Values", String(n.values)],
        ["Dry runs", `${v.verified.passed} of ${v.verified.total}`],
      ]),
  );
}

// ---------- repair and drift watch: a new version ----------

const RUNG_WORDS: Record<HealRung, string> = {
  fallback: "Stored selector",
  similarity: "Similarity match",
  open_weights: "Muse Spark Open",
  computer_use: "Muse computer use",
  ask_rep: "Your answer",
};
const PAID: HealRung[] = ["open_weights", "computer_use"];

export interface DiffCardInput {
  portalName: string;
  parent: Pick<Skill, "name" | "version" | "steps" | "params">;
  saved: Pick<Skill, "name" | "version" | "title" | "steps" | "params">;
  /** The run's step results (rung and time per step id). */
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

/** The change rows of a repair: renamed or moved controls, new values, and how many steps were found again free. */
export function repairChanges(v: Pick<DiffCardInput, "parent" | "saved" | "steps">): {
  rows: Change[];
  free: number;
  byModel: number;
} {
  const result = new Map(v.steps.flatMap((s) => (s.rung ? [[s.stepId, s] as const] : [])));
  const before = new Map(v.parent.steps.map((s) => [s.id, s]));
  const rows: Change[] = [];
  let free = 0;
  let byModel = 0;
  for (const s of v.saved.steps) {
    const r = result.get(s.id);
    if (!r?.rung) continue;
    const old = before.get(s.id);
    const a = old ? displayName(stepTarget(old)?.fingerprint) : "";
    const b = displayName(stepTarget(s)?.fingerprint);
    if ((r.rung === "fallback" || r.rung === "similarity") && (!a || a === b)) {
      free++;
      continue;
    }
    const paid = PAID.includes(r.rung);
    if (paid) byModel++;
    rows.push({
      was: r.rung === "ask_rep" || !old ? "(new field)" : a && a !== b ? a : `${b}, moved`,
      now: b || s.intent,
      by: paid ? `${RUNG_WORDS[r.rung]}, ${seconds(r.ms / 1000)}` : RUNG_WORDS[r.rung],
    });
  }
  // The accent marks the one change a model repaired (the first, when several).
  const first = rows.findIndex((x) => /Muse/.test(x.by));
  const marked = rows.map((x, i) => (i === first ? { ...x, accent: true } : x));
  return { rows: marked, free, byModel };
}

export function diffPhoneCardHtml(v: DiffCardInput): string {
  const { rows: changed, free } = repairChanges(v);
  const added = v.saved.params.filter((p) => !v.parent.params.some((q) => q.name === p.name));
  const cost = repairCost(v);
  const credit = v.usedOpenWeights ? note("Built with Muse Spark Open") : "";
  const value = added.length ? ` New value: ${esc(added.map((p) => label(p.name)).join(", "))}.` : "";
  // The proof, in the stub: steps repaired, dry runs, and the ledger's cost (no figure when none was recorded).
  const proof: StubField[] = [
    ["Repaired", plural(changed.length + free, "step")],
    ["Dry runs", `${v.canary.passed} of ${v.canary.total}`],
    ...(cost ? [["Cost", cost] as StubField] : []),
  ];
  if (v.watch)
    return cardHtml(
      cap(v.watch.when ?? "Drift watch"),
      stage(
        state("Nothing<br>to do.", { size: "display" }) +
          sub(`${esc(v.portalName)} changed${v.watch.when === "overnight" ? " overnight" : ""}.${value}`) +
          credit,
      ) + stub(proof),
      { signal: true },
    );
  const leadAt = Math.max(
    changed.findIndex((r) => r.accent),
    0,
  );
  const lead = changed[leadAt];
  const rest = changed.filter((_, i) => i !== leadAt);
  const was = lead
    ? lead.was === "(new field)"
      ? "New field"
      : lead.was.endsWith(", moved")
        ? "Moved"
        : `${esc(lead.was)} is now`
    : "";
  const more = free > 0 ? `${plural(free, "other step")} found again by stored selectors, free` : undefined;
  return cardHtml(
    "Repaired",
    stage(
      (lead
        ? kicker(was) +
          state(esc(lead.now)) +
          (rest.length || more ? changes(rest, { max: 3, ...(more ? { more } : {}) }) : "")
        : state("Repaired") + sub("The page changed; stored selectors found every step again.")) +
        note(`Version ${v.saved.version} is live. Version ${v.parent.version} is kept.${value}`) +
        credit,
    ) + stub(proof),
  );
}

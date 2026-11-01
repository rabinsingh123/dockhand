// Phone cards: every image Dockhand sends in WhatsApp (teach, plan, submit, question, receipt, new skill, repair,
// drift watch). Drawn with @dockhand/design (docs/DESIGN.md): a 4:5 card, 540 x 675 CSS px at 2x, so the PNG is
// 1080 x 1350, exactly what WhatsApp shows uncropped in the chat bubble.
//
// Each card reads like a product update or a receipt, not a dashboard: a masthead, a title, one line big enough
// to read when the phone fills a 1080p frame, one summary sentence, then hairline tables. Status is a word,
// numbers are tabular, and the accent marks at most one thing per card, only what Dockhand did.

import { execFile } from "node:child_process";
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
import {
  type Change,
  changes,
  display,
  esc,
  FIT_SCRIPT,
  facts,
  footnote,
  masthead,
  num,
  section,
  summary,
  title,
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
const WORDS = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** Small counts in words, as a sentence would have them ("two controls"); larger ones as numerals. */
const spelled = (n: number) => WORDS[n] ?? String(n);

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

/** A whole card document: masthead, then the body. */
export function cardHtml(meta: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${uiCss()}html,body{margin:0;background:#F6F5F1}</style></head><body class="dh"><main class="dh-card">${masthead(meta)}${body}</main>${FIT_SCRIPT}</body></html>`;
}

/** The generic card (tests and one-off notices): a title, an optional line and summary. */
export interface PhoneCardSpec {
  context: string;
  title: string;
  line?: string;
  summary?: string;
}

export function phoneCardHtml(c: PhoneCardSpec): string {
  return cardHtml(
    c.context,
    title(c.title) +
      (c.line ? display(c.line, { kind: "small" }) : "") +
      (c.summary ? summary(esc(c.summary)) : ""),
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
 * A real screenshot of the page, cropped to `height` CSS px around `focusY` (0..1 of the image). `highlight`
 * outlines the control Dockhand will act on, in the accent.
 */
export function shotHtml(
  bytes: Uint8Array,
  o: { height: number; focusY?: number; highlight?: BBox },
): string {
  const size = pngSize(bytes);
  const w = PHONE_CARD_WIDTH - 56 - 2;
  const scale = size ? w / size.w : 1;
  const fullH = size ? size.h * scale : o.height;
  const top = Math.max(0, Math.min(fullH - o.height, (o.focusY ?? 0) * fullH - o.height / 2));
  const hl =
    o.highlight && size
      ? `<span class="hl" style="left:${(o.highlight.x * scale - 4).toFixed(1)}px;top:${(o.highlight.y * scale - top - 4).toFixed(1)}px;width:${(o.highlight.w * scale + 8).toFixed(1)}px;height:${(o.highlight.h * scale + 8).toFixed(1)}px"></span>`
      : "";
  return `<div class="dh-shot" style="height:${o.height}px"><img src="${png(bytes)}" style="width:${w}px;height:${fullH.toFixed(1)}px;margin-top:${(-top).toFixed(1)}px">${hl}</div>`;
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

/** "{{company_name}}" in a step becomes the value's label in bold; the rest is escaped. */
export function withParams(text: string): string {
  return text
    .split(/(\{\{[a-z][a-z0-9_]*(?:\|[^}]*)?\}\})/g)
    .map((p) =>
      /^\{\{.*\}\}$/.test(p) ? `<b>${esc(label(p.slice(2, -2).split("|")[0] ?? ""))}</b>` : esc(p),
    )
    .join("");
}

/** Two columns of value names, required ones first, in a hairline table. */
function valueNames(params: { name: string; required: boolean }[], max: number): string {
  const ordered = [...params.filter((p) => p.required), ...params.filter((p) => !p.required)];
  const shown = ordered.length > max ? ordered.slice(0, max - 1) : ordered;
  const cells = shown.map(
    (p) => `${esc(label(p.name))}${p.required ? "" : ' <span class="was">(optional)</span>'}`,
  );
  if (ordered.length > shown.length)
    cells.push(`<span class="was">${ordered.length - shown.length} more</span>`);
  const rows: string[] = [];
  for (let i = 0; i < cells.length; i += 2)
    rows.push(`<tr><td>${cells[i]}</td><td>${cells[i + 1] ?? ""}</td></tr>`);
  return `<table class="dh-table"><tbody>${rows.join("")}</tbody></table>`;
}

// ---------- teach: what Muse saw ----------

export interface TeachCardOptions {
  portalName: string;
  /** Frames sampled evenly from the recording (videoFrames). */
  frames?: Uint8Array[];
  /** Recording length in seconds, for the frame timestamps and the summary. */
  durationS?: number;
}

export function teachPhoneCardHtml(d: SkillDraft, o: TeachCardOptions): string {
  const n = draftCounts(d);
  const frames = (o.frames ?? []).slice(0, 3);
  const strip = frames.length
    ? `<div class="dh-frames">${frames
        .map(
          (f, i) =>
            `<figure><img src="${jpeg(f)}"><span>${o.durationS ? clock(((i + 0.5) / frames.length) * o.durationS) : `${i + 1} of ${frames.length}`}</span></figure>`,
        )
        .join("")}</div>`
    : "";
  const video = o.durationS ? `your ${Math.round(o.durationS)} s recording` : "your recording";
  return cardHtml(
    "Learned from your video",
    title(`${d.title} on ${o.portalName}`) +
      display(plural(n.values, "value"), { accent: true }) +
      summary(
        `Seen in ${esc(video)}: ${n.required} required, done in ${plural(n.steps, "step")}. It submits with “${esc(d.commitStep)}”, only after your tap.`,
      ) +
      strip +
      section("Values it will ask for") +
      valueNames(d.params, 8) +
      footnote(
        "Values typed in the video are never reused. The first real request runs once with computer use.",
      ),
  );
}

// ---------- plan: what will be written where ----------

export interface PlanCardView {
  /** "Register Vila Nova Logística Ltda." */
  title: string;
  /** "Caravela Partner Hub", "HubSpot". */
  where: string;
  /** "register_partner_deal v1, no model calls". */
  how: string;
  figure: { value: string; label: string };
  rows: [string, string][];
  /** The safety fact ("Nothing is submitted until you approve the filled form"). */
  foot: string;
}

export function planPhoneCardHtml(v: PlanCardView): string {
  return cardHtml(
    "Plan, waiting for your approval",
    title(`${v.title}`) +
      display(v.figure.value, { kind: "small" }) +
      summary(`${esc(cap(v.figure.label))}. Written on ${esc(v.where)} with ${esc(v.how)}. ${esc(v.foot)}.`) +
      section(`What I will write on ${v.where}`) +
      facts(v.rows, { max: 9 }),
  );
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
  const size = v.screenshot ? pngSize(v.screenshot) : undefined;
  const shot = v.screenshot
    ? shotHtml(v.screenshot, {
        height: lines.length ? 140 : 330,
        focusY: v.highlight && size ? (v.highlight.y + v.highlight.h / 2) / size.h : 0.5,
        ...(v.highlight ? { highlight: v.highlight } : {}),
      })
    : "";
  return cardHtml(
    "Ready to submit",
    title(`Filled on ${v.portalName}`) +
      display(lines.length ? plural(lines.length, "field") : "Review page", { kind: "small" }) +
      summary(
        lines.length
          ? "Read back from the page just now. Nothing is sent until you tap Approve."
          : "A wizard’s last page has nothing to read back: check it here. Nothing is sent until you tap Approve.",
      ) +
      shot +
      (lines.length
        ? section("On the page now") +
          facts(
            lines.map((f) => [f.label, f.value]),
            { max: 6 },
          )
        : ""),
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
    "Waiting for your answer",
    title(`${v.portalName} now requires a new field`) +
      display(v.label) +
      summary(`Which should I use: ${esc(list)}? I’ll remember your answer and use it from now on.`) +
      (v.screenshot ? shotHtml(v.screenshot, { height: 250, focusY: 0.55 }) : "") +
      footnote("Nothing has been submitted. Reply “skip” to stop here."),
  );
}

// ---------- receipt ----------

export type ReceiptTier = "api" | "replay" | "agentic" | "repair";

export interface ReceiptCardView {
  title: string;
  tier: ReceiptTier;
  /** The record ID ("NW-REG-48221"), set big in Geist Mono. */
  headline?: string;
  /** One short line under the title. */
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

const TIER_WORDS: Record<ReceiptTier, string> = {
  api: "Done through the API",
  replay: "Replayed the compiled skill, no model calls",
  agentic: "First run with computer use",
  repair: "Replayed, and repaired on the way",
};

export function receiptPhoneCardHtml(r: ReceiptCardView): string {
  const looksLikeId =
    r.headline !== undefined && /^[A-Z0-9][A-Z0-9-]{4,}$/.test(r.headline) && /\d/.test(r.headline);
  const rows: [string, string][] = [
    ["How", esc(TIER_WORDS[r.tier])],
    ...(r.verified
      ? [["Fields verified", `${num(`${r.verified.matched} of ${r.verified.checked}`)}`] as [string, string]]
      : []),
    ["Machine time", num(seconds(r.seconds))],
    ["Cost to run", num(money(r.execCostUsd))],
    ["Cost to read the request", num(money(r.intakeCostUsd))],
    ...(r.skill ? [["Skill", num(`${r.skill.name} v${r.skill.version}`)] as [string, string]] : []),
  ];
  return cardHtml(
    "Receipt",
    title(r.title) +
      (r.headline ? display(r.headline, { kind: looksLikeId ? "id" : "small", accent: true }) : "") +
      (r.line ? summary(esc(r.line)) : "") +
      section("Details") +
      facts(rows, { html: true }) +
      (r.screenshot ? shotHtml(r.screenshot, { height: r.headline ? 150 : 240, focusY: 0.3 }) : "") +
      (r.usedOpenWeights ? footnote("Built with Muse Spark Open") : ""),
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
  const from = v.draft ? draftCounts(v.draft) : undefined;
  const unused = v.draft ? v.draft.params.filter((p) => !v.skill.params.some((q) => q.name === p.name)) : [];
  return cardHtml(
    "New skill",
    title(`${v.skill.title} on ${v.portalName}`) +
      display("0 model calls", { kind: "small", accent: true }) +
      summary(
        from
          ? `when it replays. Compiled from the first run: your video’s ${from.steps} steps became <b>${n.steps} program steps</b>, and its ${from.values} values became <b>${n.values}</b>${unused.length ? ` (${esc(unused.map((p) => label(p.name)).join(", "))} not needed)` : ""}.`
          : `when it replays. ${n.steps} program steps, ${n.values} values per request.`,
      ) +
      section("Program") +
      facts(
        [
          ["Steps", num(n.steps)],
          ["Values per request", num(n.values)],
          ["Fields it writes and reads back", num(n.fields)],
          ["Checked before saving", `${num(`${v.verified.passed} of ${v.verified.total}`)} dry runs passed`],
          ["Name", num(`${v.skill.name} v${v.skill.version}`)],
        ],
        { html: true },
      ),
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
  const { rows, free, byModel } = repairChanges(v);
  const added = v.saved.params.filter((p) => !v.parent.params.some((q) => q.name === p.name));
  const cost = repairCost(v);
  const changed = rows.length;
  const controls = `${cap(spelled(changed))} ${changed === 1 ? "control" : "controls"} changed`;
  const what =
    changed === 0
      ? "The page changed; stored selectors found every step again."
      : byModel === 0
        ? `${controls}; stored selectors found ${changed === 1 ? "it" : "them"} again.`
        : byModel === changed
          ? `${controls}; a model found ${changed === 1 ? "the new one" : "each new one"}.`
          : `${controls}. A model found ${spelled(byModel)}; stored selectors found the rest.`;
  const checks = `Checked with ${v.canary.passed} of ${v.canary.total} dry runs before version ${v.saved.version} went live; version ${v.parent.version} is kept.`;
  const facts_: [string, string][] = [
    ["Skill", num(`${v.saved.name} v${v.saved.version}`)],
    ...(cost ? [["Cost of the repair", num(cost)] as [string, string]] : []),
    ["Undo", num(`/rollback ${v.saved.name} ${v.parent.version}`)],
  ];
  const more = free > 0 ? `${plural(free, "other step")} found again by stored selectors, free` : undefined;
  const body = v.watch
    ? title(`${v.portalName} changed${v.watch.when === "overnight" ? " overnight" : ""}.`) +
      display("Nothing to do.") +
      summary(`${esc(what)} ${esc(checks)}`)
    : title(`${v.portalName} changed. Repaired.`) +
      display(`Version ${v.saved.version} is live`, { kind: "small" }) +
      summary(`${esc(what)} ${esc(checks)}`);
  return cardHtml(
    v.watch ? `Drift watch${v.watch.when ? `, ${v.watch.when}` : ""}` : "Skill repaired",
    body +
      section(
        added.length
          ? `What changed, and the new value: ${added.map((p) => label(p.name)).join(", ")}`
          : "What changed",
      ) +
      changes(rows, { max: 4, ...(more ? { more } : {}) }) +
      facts(facts_, { html: true }) +
      (v.usedOpenWeights ? footnote("Built with Muse Spark Open") : ""),
  );
}

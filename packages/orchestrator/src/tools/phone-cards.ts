// Phone cards: Dockhand's WhatsApp images (teach "what Muse saw", skill diff, drift watch...). One builder,
// one renderer: 540 CSS px wide at 2x, so the PNG is 1080 px wide, one phone screen, crisp when opened full
// screen and still legible in the chat bubble. Dockhand's dark visual language (same as the HUD and recorder).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ArtifactRef, ArtifactStore, HealRung, Id, Skill, SkillDraft, StepResult } from "@dockhand/core";
import { displayName, stepTarget } from "@dockhand/skills";

const run = promisify(execFile);

export const PHONE_CARD_WIDTH = 540;
export const PHONE_CARD_SCALE = 2;

/** renderHtml from the browser pool (scale honored); a renderer without `scale` gives a 1x image. */
export type PhoneRender = (
  html: string,
  size: { w: number; h: number },
  opts?: { fullPage?: boolean; scale?: number },
) => Promise<Uint8Array>;

export interface PhoneCards {
  /** Renders a phone card (from phoneCardHtml or one of the templates below) to a stored PNG. */
  render(jobId: Id, html: string): Promise<ArtifactRef>;
}

export function createPhoneCards(deps: { artifacts: ArtifactStore; render: PhoneRender }): PhoneCards {
  return {
    async render(jobId, html) {
      const png = await deps.render(
        html,
        { w: PHONE_CARD_WIDTH, h: 600 },
        { fullPage: true, scale: PHONE_CARD_SCALE },
      );
      return deps.artifacts.put(png, "image/png", { kind: "receipt", jobId });
    },
  };
}

// ---------- the builder ----------

export const esc = (s: unknown): string =>
  String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export type Tone = "cu" | "replay" | "heal" | "ok" | "bad" | "wait" | "muted";
const TONE: Record<Tone, string> = {
  cu: "#a78bfa",
  replay: "#22d3ee",
  heal: "#fbbf24",
  ok: "#4ade80",
  bad: "#fb7185",
  wait: "#f472b6",
  muted: "#94a3b8",
};

export interface PhoneCardSpec {
  /** Small caps over the title ("What Muse saw", "Skill repaired", "Drift watch"). */
  eyebrow: string;
  title: string;
  sub?: string;
  tone?: Tone;
  chips?: { text: string; tone?: Tone }[];
  /** Big numbers in a row, at most 3 read well. */
  stats?: { value: string; label: string; tone?: Tone }[];
  /** Sections in order. `html` is trusted markup built with the helpers below (escape any data in it). */
  sections: { heading: string; html: string }[];
  foot?: string;
  credit?: string;
}

const LOGO =
  '<svg width="30" height="30" viewBox="0 0 18 18"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="18" height="18" rx="5" fill="url(#g)"/><path d="M5.2 4.6h3.6a4.4 4.4 0 0 1 0 8.8H5.2z" fill="none" stroke="#0b0d12" stroke-width="1.9" stroke-linejoin="round"/><circle cx="9.1" cy="9" r="1.35" fill="#0b0d12"/></svg>';

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#0a0c10}
body{width:${PHONE_CARD_WIDTH}px;font:17px/1.4 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Arial,sans-serif;color:#e9edf3;-webkit-font-smoothing:antialiased}
.card{padding:26px 26px 22px;background:radial-gradient(120% 60% at 0% 0%,color-mix(in srgb,var(--c) 16%,transparent) 0,transparent 60%),#0d1016}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.brand b{font-size:19px;font-weight:800;letter-spacing:.1px}
.eyebrow{margin-left:auto;font-size:13px;font-weight:800;letter-spacing:1.2px;text-transform:uppercase;color:var(--c)}
h1{font-size:30px;line-height:1.15;font-weight:800;letter-spacing:-.3px;color:#fff}
.sub{margin-top:6px;font-size:17px;color:#aeb7c4}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.chip{display:inline-flex;align-items:center;height:30px;padding:0 12px;border-radius:999px;font-size:15px;font-weight:750;border:1.5px solid color-mix(in srgb,var(--t) 50%,transparent);color:var(--t);background:color-mix(in srgb,var(--t) 13%,transparent)}
.stats{display:grid;grid-template-columns:repeat(var(--n),minmax(0,1fr));gap:10px;margin-top:18px}
.stat{padding:12px 14px 11px;border-radius:14px;background:#151922;border:1px solid rgba(255,255,255,.08)}
.stat b{display:block;font-size:28px;line-height:1.1;font-weight:800;color:var(--t);white-space:nowrap}
.stat span{display:block;margin-top:3px;font-size:14px;color:#9aa4b2;line-height:1.25}
h2{margin:22px 0 10px;font-size:13.5px;font-weight:800;letter-spacing:1.1px;text-transform:uppercase;color:#8a94a4}
.frames{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}
.frames figure{position:relative;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,.14);line-height:0}
.frames img{width:100%;display:block}
.frames figcaption{position:absolute;left:6px;top:6px;padding:1px 6px;border-radius:6px;background:rgba(10,12,16,.86);font:700 13px/1.3 Consolas,"Cascadia Mono",monospace;color:#fff}
ol.steps{list-style:none;counter-reset:s}
ol.steps li{counter-increment:s;display:grid;grid-template-columns:30px minmax(0,1fr);gap:9px;padding:6px 0;font-size:17px;line-height:1.35}
ol.steps li::before{content:counter(s);width:26px;height:26px;margin-top:1px;border-radius:50%;display:grid;place-items:center;background:color-mix(in srgb,var(--c) 18%,transparent);color:var(--c);font-weight:800;font-size:14px}
.more{margin:4px 0 0 39px;font-size:15px;color:#8a94a4}
.p{display:inline-block;padding:0 7px;border-radius:6px;background:rgba(167,139,250,.18);color:#ddd6fe;font:650 15px/1.5 Consolas,"Cascadia Mono",monospace}
.params{display:flex;flex-wrap:wrap;gap:8px}
.param{display:inline-flex;align-items:center;gap:7px;padding:6px 10px;border-radius:10px;background:#151922;border:1px solid rgba(255,255,255,.08);font:650 15px/1.2 Consolas,"Cascadia Mono",monospace;color:#e9edf3}
.param i{font-style:normal;font:700 12px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:.4px;text-transform:uppercase;color:#8a94a4}
.param .req{color:#fb7185}
.box{padding:13px 15px;border-radius:14px;background:#151922;border:1px solid rgba(255,255,255,.08);font-size:17px}
.box+.box{margin-top:8px}
.box .k{display:block;font-size:13px;font-weight:800;letter-spacing:.9px;text-transform:uppercase;color:#8a94a4;margin-bottom:3px}
.change{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px 10px;align-items:center;padding:12px 14px;border-radius:14px;background:#151922;border:1px solid rgba(255,255,255,.08)}
.change+.change{margin-top:8px}
.change .what{font-size:17px;font-weight:650;line-height:1.3;overflow-wrap:anywhere}
.change .old{color:#fda4af;text-decoration:line-through;text-decoration-thickness:1.5px}
.change .arrow{color:#fbbf24;font-weight:800;margin:0 6px}
.change .new{color:#bbf7d0}
.rung{white-space:nowrap;padding:4px 10px;border-radius:999px;font-size:13.5px;font-weight:800;color:#0b0d12;background:var(--t)}
.ok{color:#4ade80}.bad{color:#fb7185}
.foot{margin-top:20px;padding-top:14px;border-top:1px solid rgba(255,255,255,.1);font-size:14.5px;color:#9aa4b2;line-height:1.4}
.foot code{font:650 14.5px Consolas,"Cascadia Mono",monospace;color:#e9edf3;background:#151922;padding:1px 6px;border-radius:5px}
.credit{margin-top:8px;font-size:14px;font-weight:750;color:#c4b5fd}
`;

/** The reusable card: brand row, title, chips, big stats, sections, foot. Returns a full HTML document. */
export function phoneCardHtml(c: PhoneCardSpec): string {
  const color = TONE[c.tone ?? "replay"];
  const chips = (c.chips ?? [])
    .map((x) => `<span class="chip" style="--t:${TONE[x.tone ?? "muted"]}">${esc(x.text)}</span>`)
    .join("");
  const stats = (c.stats ?? []).slice(0, 3);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="card" style="--c:${color}">
<div class="brand">${LOGO}<b>Dockhand</b><span class="eyebrow">${esc(c.eyebrow)}</span></div>
<h1>${esc(c.title)}</h1>${c.sub ? `<div class="sub">${esc(c.sub)}</div>` : ""}
${chips ? `<div class="chips">${chips}</div>` : ""}
${stats.length ? `<div class="stats" style="--n:${stats.length}">${stats.map((s) => `<div class="stat" style="--t:${TONE[s.tone ?? "replay"]}"><b>${esc(s.value)}</b><span>${esc(s.label)}</span></div>`).join("")}</div>` : ""}
${c.sections.map((s) => `<h2>${esc(s.heading)}</h2>${s.html}`).join("\n")}
${c.foot || c.credit ? `<div class="foot">${c.foot ?? ""}${c.credit ? `<div class="credit">${esc(c.credit)}</div>` : ""}</div>` : ""}
</div></body></html>`;
}

/** "{{company_name}}" in a step becomes a param chip; the rest is escaped. */
export function withParams(text: string): string {
  return text
    .split(/(\{\{[a-z][a-z0-9_]*(?:\|[^}]*)?\}\})/g)
    .map((p) =>
      /^\{\{.*\}\}$/.test(p) ? `<span class="p">${esc(p.slice(2, -2).split("|")[0])}</span>` : esc(p),
    )
    .join("");
}

// ---------- frames from a video ----------

/** Length of a video in seconds (from ffmpeg's banner), or undefined. */
export async function videoDuration(ffmpeg: string, src: string): Promise<number | undefined> {
  const probe = await run(ffmpeg, ["-hide_banner", "-i", src], { timeout: 10_000, windowsHide: true }).catch(
    (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  const m = /Duration:s*(d+):(d+):(d+(?:.d+)?)/.exec(String(probe.stderr));
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
    const probe = await run(ffmpeg, ["-hide_banner", "-i", src], {
      timeout: 10_000,
      windowsHide: true,
    }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }));
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(probe.stderr));
    if (!m) return [];
    const dur = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
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
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
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

const jpeg = (b: Uint8Array) => `data:image/jpeg;base64,${Buffer.from(b).toString("base64")}`;

// ---------- teach: what Muse saw ----------

export interface TeachCardOptions {
  portalName: string;
  /** Frames sampled evenly from the recording (videoFrames). */
  frames?: Uint8Array[];
  /** Recording length in seconds, for the frame timestamps and the subtitle. */
  durationS?: number;
}

export function teachPhoneCardHtml(d: SkillDraft, o: TeachCardOptions): string {
  const frames = (o.frames ?? []).slice(0, 3);
  const n = frames.length;
  const steps = d.steps.slice(0, 4);
  const required = d.params.filter((p) => p.required).length;
  const sections: PhoneCardSpec["sections"] = [];
  if (n > 0) {
    sections.push({
      heading: "What Muse saw",
      html: `<div class="frames">${frames
        .map(
          (f, i) =>
            `<figure><img src="${jpeg(f)}"><figcaption>${o.durationS ? clock(((i + 0.5) / n) * o.durationS) : `${i + 1}/${n}`}</figcaption></figure>`,
        )
        .join("")}</div>`,
    });
  }
  sections.push({
    heading: `The steps it wrote (${d.steps.length})`,
    html: `<ol class="steps">${steps.map((s) => `<li><span>${withParams(s)}</span></li>`).join("")}</ol>${
      d.steps.length > steps.length ? `<div class="more">+${d.steps.length - steps.length} more</div>` : ""
    }`,
  });
  const optional = d.params.length - required;
  sections.push({
    heading: `Typed values it will ask for (${d.params.length})`,
    html: `<div class="params">${d.params
      .filter((p) => p.required)
      .map((p) => `<span class="param">${esc(p.name)}<i>${esc(p.type)}</i></span>`)
      .join("")}${optional > 0 ? `<span class="param"><i>+${optional} optional</i></span>` : ""}</div>`,
  });
  sections.push({
    heading: "Done when",
    html: `<div class="box">${esc(d.success)}<span class="k" style="margin:8px 0 0">Submits with “${esc(d.commitStep)}”, only after your tap</span></div>`,
  });
  return phoneCardHtml({
    eyebrow: "Teach",
    tone: "cu",
    title: d.title,
    sub: o.durationS ? `From your ${Math.round(o.durationS)} s recording` : `On ${o.portalName}`,
    stats: [
      { value: String(d.steps.length), label: "steps, in plain words", tone: "cu" },
      { value: String(d.params.length), label: `typed values · ${required} required`, tone: "cu" },
    ],
    sections,
    foot: "Values seen in the video are never reused. The first real request runs once with computer use, then replays as a program.",
  });
}

// ---------- diff: v1 -> v2 ----------

const RUNG_CHIP: Record<HealRung, { text: string; tone: Tone }> = {
  fallback: { text: "rung 1 · free", tone: "heal" },
  similarity: { text: "rung 1 · free", tone: "heal" },
  open_weights: { text: "rung 2 · Muse Spark Open", tone: "heal" },
  computer_use: { text: "rung 3 · computer use", tone: "heal" },
  ask_rep: { text: "rung 4 · you answered", tone: "wait" },
};

export interface DiffCardInput {
  portalName: string;
  parent: Pick<Skill, "name" | "version" | "steps" | "params">;
  saved: Pick<Skill, "name" | "version" | "title" | "steps" | "params">;
  /** The run's step results (rung per step id). */
  steps: StepResult[];
  canary: { passed: number; total: number };
  /** Execution cost of the healing run. */
  costUsd: number;
  usedOpenWeights?: boolean;
}

function money(v: number): string {
  if (v <= 0) return "$0";
  return v < 0.01 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
}

export function diffPhoneCardHtml(v: DiffCardInput): string {
  const rungOf = new Map(v.steps.flatMap((s) => (s.rung ? [[s.stepId, s.rung] as const] : [])));
  const before = new Map(v.parent.steps.map((s) => [s.id, s]));
  const named: string[] = [];
  let free = 0;
  for (const s of v.saved.steps) {
    const rung = rungOf.get(s.id);
    if (!rung) continue;
    const old = before.get(s.id);
    const a = old ? displayName(stepTarget(old)?.fingerprint) : "";
    const b = displayName(stepTarget(s)?.fingerprint);
    const chip = RUNG_CHIP[rung];
    if ((rung === "fallback" || rung === "similarity") && (!a || a === b)) {
      free++;
      continue;
    }
    const what =
      rung === "ask_rep" || !old
        ? `<span class="new">New: ${esc(b || s.intent)}</span>`
        : a && a !== b
          ? `<span class="old">${esc(a)}</span><span class="arrow">→</span><span class="new">${esc(b)}</span>`
          : `<span class="new">${esc(b || s.intent)}</span>: new selector`;
    named.push(
      `<div class="change"><span class="what">${what}</span><span class="rung" style="--t:${TONE[chip.tone]}">${esc(chip.text)}</span></div>`,
    );
  }
  if (free > 0) {
    named.push(
      `<div class="change"><span class="what"><span class="new">${free} field${free === 1 ? "" : "s"}</span>: found by stored selectors</span><span class="rung" style="--t:${TONE.heal}">rung 1 · free</span></div>`,
    );
  }
  const added = v.saved.params.filter((p) => !v.parent.params.some((q) => q.name === p.name));
  const fixed = [...rungOf.keys()].length;
  const allPassed = v.canary.passed === v.canary.total;
  return phoneCardHtml({
    eyebrow: "Skill repaired",
    tone: "heal",
    title: `${v.portalName} changed`,
    sub: `${v.saved.name} v${v.parent.version} → v${v.saved.version}`,
    stats: [
      { value: String(fixed), label: `step${fixed === 1 ? "" : "s"} fixed`, tone: "heal" },
      {
        value: `${v.canary.passed}/${v.canary.total}`,
        label: "dry runs passed before going live",
        tone: allPassed ? "ok" : "bad",
      },
      { value: money(v.costUsd), label: "to repair", tone: "replay" },
    ],
    sections: [
      {
        heading: "What changed",
        html: named.slice(0, 5).join("") || `<div class="box">Selectors refreshed</div>`,
      },
      ...(added.length
        ? [
            {
              heading: "New values",
              html: `<div class="params">${added.map((p) => `<span class="param">${esc(p.name)}<i>${esc(p.type)}</i></span>`).join("")}</div>`,
            },
          ]
        : []),
    ],
    foot: `v${v.parent.version} kept for rollback: <code>/rollback ${esc(v.saved.name)} ${v.parent.version}</code>`,
    ...(v.usedOpenWeights ? { credit: "Built with Muse Spark Open" } : {}),
  });
}

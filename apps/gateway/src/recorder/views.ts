// Flight recorder pages: run, skill and teach views, plus the index. Server-rendered from the ledger.

import { modelLabel } from "@dockhand/browser";
import type { Candidate, ParamValue, Skill, Step, Target, Trace, TraceStep } from "@dockhand/core";
import {
  diffSkills,
  displayName,
  exportPlaywright,
  renderTemplate,
  stepTarget,
  valuesEquivalent,
} from "@dockhand/skills";
import type { DraftRow, GateRow, ModelCallRow, RecorderData, RunRow, SkillRow, StepRow } from "./data.ts";
import {
  COLORS,
  chip,
  esc,
  type Html,
  highlight,
  html,
  int,
  latency,
  MODE_COLOR,
  MODE_LABEL,
  ms,
  OUTCOME_COLOR,
  page,
  RUNG,
  raw,
  usd,
  when,
} from "./html.ts";
import type { PickDoc } from "./reveal.ts";

const VIEW_W = 1280;
const VIEW_H = 800;
const REAL_PROVIDERS = new Set(["meta", "baseten"]);

const STATUS_COLOR: Record<string, string> = {
  ok: COLORS.replay,
  healed: COLORS.repair,
  repaired: COLORS.repair,
  asked: COLORS.wait,
  failed: COLORS.bad,
  skipped: COLORS.muted,
};

function stat(k: string, v: Html | string, n?: Html | string): Html {
  return html`<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${n ? html`<div class="n">${n}</div>` : ""}</div>`;
}

function shortId(id: string): string {
  return id.length > 12 ? id.slice(-8) : id;
}

function cand(c: Candidate): string {
  switch (c.by) {
    case "testid":
      return `testid=${c.value}`;
    case "role":
      return `role=${c.role} "${c.name}"`;
    case "label":
      return `label "${c.value}"`;
    case "placeholder":
      return `placeholder "${c.value}"`;
    case "text":
      return `text "${c.value}"`;
    case "css":
      return `css ${c.value}`;
  }
}

function cands(t: Target | undefined, n = 3): Html {
  if (!t || t.candidates.length === 0) return html``;
  return html`<div class="cands">${t.candidates.slice(0, n).map((c, i) => html`<span class="cand" title="${cand(c)}"><em>${i + 1}.</em> ${cand(c)}</span>`)}${
    t.candidates.length > n ? html`<span class="cand"><em>+${t.candidates.length - n}</em></span>` : ""
  }</div>`;
}

function render(t: string, params: Record<string, unknown> | null): string {
  try {
    return renderTemplate(t, (params ?? {}) as Record<string, ParamValue>);
  } catch {
    return t;
  }
}

function img(base: string, id: string | null | undefined, cap?: string, overlay?: Html): Html {
  if (!id) return html``;
  return html`<figure class="shot"><img src="${base}a/${id}" alt="${cap ?? "screenshot"}" loading="lazy">${overlay ?? ""}${cap ? html`<span class="cap">${cap}</span>` : ""}</figure>`;
}

function pct(v: number, of: number): string {
  return `${((v / of) * 100).toFixed(3)}%`;
}

function simulated(calls: ModelCallRow[]): string[] {
  return [...new Set(calls.filter((c) => !REAL_PROVIDERS.has(c.provider)).map((c) => c.provider))];
}

function modelName(c: ModelCallRow): string {
  return modelLabel(c.model, c.provider);
}

// ---------- index ----------

export function indexView(d: RecorderData, base: string): string {
  const runs = d.runs(60);
  const skills = d.skillNames();
  const drafts = d.drafts(20);
  const body = html`
  <div class="head"><div><h1 class="title">Flight recorder</h1><p class="sub">Every run, skill version and teach draft in the ledger. Pick one to see what the model saw, what was clicked and verified, and what healed.</p></div>
  <div class="legend"><span><i style="--c:var(--cu)"></i>computer use</span><span><i style="--c:var(--replay)"></i>replay, 0 model calls</span><span><i style="--c:var(--heal)"></i>heal</span><span><i style="--c:var(--wait)"></i>asked the rep</span></div></div>
  <div class="grid">
    <section class="panel" id="runs"><h2>Runs <span>${runs.length} latest</span></h2>${
      runs.length === 0
        ? html`<p class="empty">No runs yet.</p>`
        : html`<table><thead><tr><th>Started</th><th>Mode</th><th>Skill</th><th>Outcome</th><th class="num">Time</th><th class="num">Model calls</th><th class="num">Cost</th><th>Run</th></tr></thead><tbody>${runs.map(
            (
              r,
            ) => html`<tr class="link" data-href="${base}runs/${r.id}"><td class="muted">${when(r.startedAt)}</td>
            <td>${chip(MODE_LABEL[r.mode] ?? r.mode, MODE_COLOR[r.mode] ?? COLORS.muted, { dot: true })}${r.evalSuite ? html` <span class="tag">eval</span>` : ""}</td>
            <td>${r.skillName ?? "–"}${r.skillVersion ? html` <span class="muted">v${r.skillVersion}</span>` : ""}</td>
            <td>${r.outcome ? chip(r.outcome.replace(/_/g, " "), OUTCOME_COLOR[r.outcome] ?? COLORS.muted) : chip("running", COLORS.wait)}</td>
            <td class="num">${ms(r.ms)}</td><td class="num">${int(r.modelCalls)}</td><td class="num">${usd(r.costUsd)}</td><td class="mono muted">${shortId(r.id)}</td></tr>`,
          )}</tbody></table>`
    }</section>
    <aside class="side">
      <section class="panel" id="skills"><h2>Skills <span>${skills.length}</span></h2>${
        skills.length === 0
          ? html`<p class="empty">No compiled skills yet.</p>`
          : html`<table><tbody>${skills.map(
              (s) =>
                html`<tr class="link" data-href="${base}skills/${s.name}"><td><b>${s.title}</b><div class="mono muted">${s.name}</div></td><td class="num">${s.active ? chip(`v${s.active} active`, COLORS.replay) : ""}<div class="muted" style="margin-top:4px">${s.versions} version${s.versions === 1 ? "" : "s"}</div></td></tr>`,
            )}</tbody></table>`
      }</section>
      <section class="panel" id="teach"><h2>Teach drafts <span>${drafts.length}</span></h2>${
        drafts.length === 0
          ? html`<p class="empty">No recordings taught yet.</p>`
          : html`<table><tbody>${drafts.map(
              (t) =>
                html`<tr class="link" data-href="${base}teach/${t.id}"><td><b>${t.draft.title}</b><div class="muted">${t.draft.steps.length} steps · ${t.draft.params.length} values · ${when(t.createdAt)}</div></td><td class="num">${chip(t.status, t.status === "compiled" ? COLORS.ok : t.status === "draft" ? COLORS.agentic : COLORS.muted)}</td></tr>`,
            )}</tbody></table>`
      }</section>
    </aside>
  </div>`;
  return page({ title: "Runs", nav: "runs", body, base });
}

// ---------- run ----------

/** What the runner keeps per read-back (packages/skills runner, artifact kind "readback"). */
export interface ReadBackDoc {
  runId: string;
  dryRun?: boolean;
  at?: number;
  checked: number;
  matched: number;
  rows: { stepId: string; label: string; expected: string; actual: string; ok: boolean }[];
}

interface ReadbackRow {
  label: string;
  actual: string;
  expected: string | null;
  ok: boolean | null;
}

function writeSteps(skill: Skill | undefined): { label: string; step: Step }[] {
  if (!skill) return [];
  return skill.steps
    .filter((s) => s.op === "fill" || s.op === "select" || s.op === "check" || s.op === "upload")
    .map((s) => ({ label: displayName(stepTarget(s)?.fingerprint), step: s }));
}

function expectedOf(step: Step, params: Record<string, unknown> | null): string {
  if (step.op === "fill") return render(step.value, params);
  if (step.op === "select") return render(step.option, params);
  if (step.op === "check") return String(step.checked);
  if (step.op === "upload") {
    const v = params?.[step.fileParam] as { filename?: string } | undefined;
    return v?.filename ?? `{{${step.fileParam}}}`;
  }
  return "";
}

/** The read-back shown on the commit approval card (gate body), checked against what the skill meant to write. */
function readback(
  gates: GateRow[],
  skill: Skill | undefined,
  params: Record<string, unknown> | null,
): ReadbackRow[] {
  const gate = [...gates].reverse().find((g) => g.kind === "commit");
  if (!gate) return [];
  const writes = writeSteps(skill);
  const rows: ReadbackRow[] = [];
  for (const line of gate.body.split("\n")) {
    const m = /^•\s+(.+?):\s(.*)$/.exec(line.trim());
    if (!m) continue;
    const label = (m[1] ?? "").trim();
    const actual = (m[2] ?? "").trim();
    const w = writes.find((x) => x.label === label);
    if (!w) {
      rows.push({ label, actual, expected: null, ok: null });
      continue;
    }
    const expected = expectedOf(w.step, params);
    const ok =
      w.step.op === "check"
        ? expected === actual.toLowerCase()
        : valuesEquivalent(expected, actual) || expected.trim() === actual.trim();
    rows.push({ label, actual, expected, ok });
  }
  return rows;
}

function readbackPanel(rows: ReadbackRow[]): Html {
  if (rows.length === 0) return html``;
  const checked = rows.filter((r) => r.ok !== null);
  const matched = checked.filter((r) => r.ok).length;
  return html`<section class="panel"><h2>Read-back before submit <span class="${matched === checked.length ? "ok" : "bad"}">${matched}/${checked.length} verified</span></h2>
  <table class="rb"><thead><tr><th></th><th>Field</th><th>On the page</th></tr></thead><tbody>${rows.map(
    (r) =>
      html`<tr><td style="width:84px">${r.ok === null ? html`<span class="faint">–</span>` : html`<span class="ic ${r.ok ? "ok" : "bad"}">${r.ok ? "Match" : "Mismatch"}</span>`}</td><td>${r.label}${
        r.ok === false ? html`<div class="bad" style="font-size:12px">expected ${r.expected}</div>` : ""
      }</td><td class="v">${r.actual}</td></tr>`,
  )}</tbody></table></section>`;
}

function callsPanel(calls: ModelCallRow[]): Html {
  if (calls.length === 0) return html``;
  const total = calls.reduce((a, c) => a + c.costUsd, 0);
  return html`<section class="panel"><h2>Model calls <span>${calls.length} · ${usd(total)}</span></h2><table><thead><tr><th>#</th><th>Purpose</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Img</th><th class="num">Latency</th><th class="num">Cost</th></tr></thead><tbody>${calls.map(
    (
      c,
      i,
    ) => html`<tr><td class="muted">${i + 1}</td><td class="mono">${c.purpose}${c.stepIdx !== null ? html` <span class="muted">· step ${c.stepIdx + 1}</span>` : ""}</td><td>${modelName(c)}${REAL_PROVIDERS.has(c.provider) ? "" : html` <span class="tag">${c.provider}</span>`}${c.status !== "ok" ? html` <span class="tag blocked">${c.status}</span>` : ""}</td>
    <td class="num">${int(c.inputTokens)}${c.cachedInputTokens ? html`<div class="faint">${int(c.cachedInputTokens)} cached</div>` : ""}</td><td class="num">${int(c.outputTokens)}</td><td class="num">${c.images || "–"}</td><td class="num">${latency(c.latencyMs, c.provider)}</td><td class="num">${usd(c.costUsd)}</td></tr>`,
  )}</tbody></table></section>`;
}

function stepValue(step: Step, params: Record<string, unknown> | null): Html {
  const tpl = (t: string) => {
    const v = render(t, params);
    return v === t
      ? html`<span class="val">${t}</span>`
      : html`<span class="val">${v}</span> <span class="tpl">${t}</span>`;
  };
  switch (step.op) {
    case "fill":
      return tpl(step.value);
    case "select":
      return tpl(step.option);
    case "check":
      return html`<span class="val">${step.checked ? "checked" : "unchecked"}</span>`;
    case "upload":
      return html`<span class="tpl">{{${step.fileParam}}}</span>`;
    case "goto":
      return html`<span class="tpl">${step.url}</span>`;
    case "press":
      return html`<span class="val">${step.key}</span>`;
    case "waitFor":
      return html`<span class="tpl">${step.urlIncludes ?? step.text ?? ""}</span>`;
    case "extract":
      return html`<span class="tpl">${step.name} /${step.regex}/</span>`;
    default:
      return html``;
  }
}

function replayTimeline(
  run: RunRow,
  steps: StepRow[],
  used: Skill | undefined,
  patched: Skill | undefined,
): Html {
  const byId = new Map<string, Step>();
  for (const s of used?.steps ?? []) byId.set(s.id, s);
  const after = new Map<string, Step>((patched?.steps ?? []).map((s) => [s.id, s]));
  const max = Math.max(1, ...steps.map((s) => s.ms));
  if (steps.length === 0)
    return html`<section class="panel"><h2>Timeline</h2><p class="empty">No steps recorded.</p></section>`;
  return html`<section class="panel"><h2>Timeline <span>${steps.length} steps · ${ms(steps.reduce((a, s) => a + s.ms, 0))} in steps</span></h2><ol class="steps">${steps.map(
    (s) => {
      const step = after.get(s.stepId) ?? byId.get(s.stepId);
      const before = byId.get(s.stepId);
      const target = step ? stepTarget(step) : undefined;
      const color = STATUS_COLOR[s.status] ?? COLORS.muted;
      const rung = s.rung ? RUNG[s.rung] : undefined;
      const moved =
        before &&
        step &&
        before !== step &&
        stepTarget(before) &&
        target &&
        JSON.stringify(stepTarget(before)?.candidates[0]) !== JSON.stringify(target.candidates[0]);
      return html`<li class="st"><span class="i" style="--c:${raw(color)}">${s.idx + 1}</span><span><span class="op">${s.op}</span></span>
      <div class="what"><b>${step?.intent ?? s.stepId}</b>${target ? html` <span class="muted">· ${displayName(target.fingerprint)}</span>` : ""}
        <div class="t">${step ? stepValue(step, run.params) : ""}</div>
        ${moved ? html`<div class="chg"><span class="cand" style="text-decoration:line-through">${cand(stepTarget(before)?.candidates[0] as Candidate)}</span><span class="muted">now</span><span class="cand">${cand(target?.candidates[0] as Candidate)}</span></div>` : ""}
        ${s.error ? html`<div class="err">${s.errorCode ? html`<b>${s.errorCode}</b> ` : ""}${s.error}</div>` : ""}</div>
      <div class="rung">${chip(s.status, color)}${rung ? chip(`rung ${rung.n} · ${rung.how}`, rung.color) : ""}</div>
      <div class="ms-col"><div class="ms">${ms(s.ms)}</div><div class="bar"><i style="width:${raw(pct(s.ms, max))};--c:${raw(color)}"></i></div></div></li>`;
    },
  )}</ol></section>`;
}

function describeAction(s: TraceStep): string {
  const a = s.action;
  const name = s.target ? `'${displayName(s.target.fingerprint)}'` : "";
  switch (a.type) {
    case "fn":
      return `${a.name}(${a.name === "request_commit" ? JSON.stringify((a.args as { summary?: string })?.summary ?? "") : a.name === "attach_file" ? JSON.stringify((a.args as { slot?: string })?.slot ?? "") : ""})`;
    case "click":
      return a.button === "back" ? "Back" : `Click ${name || `(${a.x}, ${a.y})`}`;
    case "double_click":
      return `Double-click ${name || `(${a.x}, ${a.y})`}`;
    case "type":
      return `Type “${a.text}”${name ? ` into ${name}` : ""}`;
    case "keypress":
      return `Press ${a.keys.join("+")}`;
    case "scroll":
      return `Scroll ${a.scroll_y > 0 ? "down" : "up"} (${a.scroll_y})`;
    case "move":
      return `Move to ${name || `(${a.x}, ${a.y})`}`;
    case "drag":
      return "Drag";
    case "wait":
      return "Wait";
    case "screenshot":
      return "Screenshot";
    default:
      return "Action";
  }
}

function pointOf(s: TraceStep): { x: number; y: number } | null {
  const a = s.action;
  if (a.type === "click" || a.type === "double_click" || a.type === "move" || a.type === "scroll")
    return { x: a.x, y: a.y };
  if (a.type === "drag") return a.path[0] ?? null;
  if (a.type === "fn" && a.name === "propose_target") {
    const p = a.args as { x?: number; y?: number };
    return typeof p.x === "number" && typeof p.y === "number" ? { x: p.x, y: p.y } : null;
  }
  return null;
}

function agenticTimeline(
  base: string,
  trace: Trace,
  shots: { id: string; at: number }[],
  calls: ModelCallRow[],
): Html {
  const steps = trace.steps.filter((s) => !(s.action.type === "screenshot"));
  const before = (ts: number) => {
    let pick = shots[0];
    for (const s of shots) if (s.at <= ts) pick = s;
    return pick;
  };
  const cuCalls = calls.filter((c) => c.purpose.startsWith("cu_"));
  const callFor = (ts: number) => {
    let pick: ModelCallRow | undefined;
    for (const c of cuCalls) if (c.ts <= ts) pick = c;
    return pick;
  };
  const batches: { shot: { id: string; at: number } | undefined; steps: TraceStep[] }[] = [];
  for (const s of steps) {
    const shot = before(s.ts);
    const last = batches.at(-1);
    if (last && last.shot?.id === shot?.id) last.steps.push(s);
    else batches.push({ shot, steps: [s] });
  }
  return html`<section class="panel"><h2>What the model saw and did <span>${steps.length} actions · ${batches.length} screenshots</span></h2>${batches.map(
    (b, bi) => {
      const call = callFor(b.steps[0]?.ts ?? 0);
      let sy = 0;
      const overlay: Html[] = [];
      const rows: Html[] = [];
      b.steps.forEach((s, i) => {
        const n = i + 1;
        const pt = pointOf(s);
        const box = s.target?.fingerprint.bbox;
        if (pt && box && box.h > 0) {
          const inside = pt.y >= box.y - 2 && pt.y <= box.y + box.h + 2;
          sy = inside ? 0 : Math.round(box.y + box.h / 2 - pt.y);
        }
        const noise = s.tags.includes("noise");
        const color = s.tags.includes("blocked")
          ? "var(--bad)"
          : s.tags.includes("commit")
            ? "var(--ok)"
            : "var(--cu)";
        if (box && box.w > 0 && !noise && s.action.type !== "scroll") {
          overlay.push(
            html`<i class="bx" style="--c:${raw(color)};left:${raw(pct(box.x, VIEW_W))};top:${raw(pct(box.y - sy, VIEW_H))};width:${raw(pct(box.w, VIEW_W))};height:${raw(pct(box.h, VIEW_H))}"></i>`,
          );
        }
        if (pt)
          overlay.push(
            html`<i class="pt" style="--c:${raw(color)};left:${raw(pct(pt.x, VIEW_W))};top:${raw(pct(pt.y, VIEW_H))}">${n}</i>`,
          );
        rows.push(
          html`<li class="act"><span class="n" style="--c:${raw(color)}">${n}</span><div class="d"><b>${describeAction(s)}</b>${
            s.tags.length
              ? html`<span class="tags">${s.tags.map((t) => html`<span class="tag ${t}">${t}</span>`)}</span>`
              : ""
          }${s.fieldValueAfter !== undefined && s.action.type !== "fn" ? html`<div class="muted" style="font-size:12px">field now: <span class="mono" style="color:#d9f99d">${s.fieldValueAfter}</span></div>` : ""}${cands(s.target)}</div></li>`,
        );
      });
      return html`<div class="batch"><div>${b.shot ? html`<figure class="shot"><img src="${base}a/${b.shot.id}" alt="screenshot ${bi + 1}" loading="lazy">${overlay}<span class="cap">Screenshot ${bi + 1} · what the model saw</span></figure>` : html`<p class="empty">No screenshot.</p>`}</div>
      <div><div class="bh"><b>Turn ${bi + 1}</b>${call ? html`<span>${modelName(call)}</span>${REAL_PROVIDERS.has(call.provider) ? "" : html`<span class="tag">${call.provider}</span>`}<span>${int(call.inputTokens)} in · ${int(call.outputTokens)} out</span><span>${latency(call.latencyMs, call.provider)}</span><span>${usd(call.costUsd)}</span>` : ""}</div><ol class="acts">${rows}</ol></div></div>`;
    },
  )}</section>`;
}

function canaryPanel(docs: ReadBackDoc[], runId: string): Html {
  if (docs.length === 0) return html``;
  return html`<section class="panel"><h2>Dry runs before the new version went live <span>${docs.filter((x) => x.matched === x.checked).length}/${docs.length} read back clean</span></h2><table><tbody>${docs.map(
    (x) =>
      html`<tr><td class="mono">${x.runId.slice(runId.length + 1)}</td><td>${x.dryRun ? chip("dry run", COLORS.dry) : ""}</td><td class="num ${x.matched === x.checked ? "ok" : "bad"}"><b>${x.matched}/${x.checked}</b> verified</td></tr>`,
  )}</tbody></table></section>`;
}

export function runView(
  d: RecorderData,
  base: string,
  run: RunRow,
  trace: Trace | null,
  readbacks: ReadBackDoc[] = [],
  picks: { id: string; doc: PickDoc; call?: { provider: string; latencyMs: number } }[] = [],
): string {
  const steps = d.steps(run.id);
  const calls = d.modelCalls(run.id);
  const gates = d.gates(run.id);
  const versions = run.skillName ? d.skillVersions(run.skillName) : [];
  const used = versions.find((v) => v.version === run.skillVersion)?.skill;
  const created = d.skillFromRun(run.id);
  const skillForReadback = created?.skill ?? used;
  // The runner's own read-back when it kept one (every run since it does), else the approval card's lines.
  const own = readbacks.filter((x) => x.runId === run.id).at(-1);
  const rb: ReadbackRow[] = own
    ? own.rows.map((x) => ({ label: x.label, actual: x.actual, expected: x.expected, ok: x.ok }))
    : readback(gates, skillForReadback, run.params);
  const canaries = readbacks.filter((x) => x.runId !== run.id);
  const sim = simulated(calls);
  const heals = steps.filter((s) => s.rung);
  const verified = rb.filter((r) => r.ok !== null);
  const commitGate = [...gates].reverse().find((g) => g.kind === "commit");
  const draftId = (created?.skill ?? used)?.createdFrom.draftId;
  const id = run.extracted ? Object.values(run.extracted).find((v) => v) : undefined;
  const actions = trace ? trace.steps.filter((s) => s.action.type !== "screenshot").length : 0;

  const body = html`
  <div class="crumbs"><a href="${base.slice(0, -1)}">Runs</a> / <span class="mono">${run.id}</span></div>
  <div class="head"><div>
    <h1 class="title">${chip(MODE_LABEL[run.mode] ?? run.mode, MODE_COLOR[run.mode] ?? COLORS.muted, { dot: true, lg: true })}
      ${run.skillName ? html`<a href="${base}skills/${run.skillName}${run.skillVersion ? `?v=${run.skillVersion}` : ""}">${run.skillName}${run.skillVersion ? html` <span class="muted">v${run.skillVersion}</span>` : ""}</a>` : "Run"}
      ${run.outcome ? chip(run.outcome.replace(/_/g, " "), OUTCOME_COLOR[run.outcome] ?? COLORS.muted, { lg: true }) : chip("running", COLORS.wait, { lg: true })}
      ${sim.length ? chip(`simulated models: ${sim.join(", ")}`, COLORS.muted, { title: "These calls did not go to Meta or Baseten; their numbers are not reported anywhere." }) : ""}
      ${run.evalSuite ? chip(`eval: ${run.evalSuite}`, COLORS.muted) : ""}</h1>
    <p class="sub">${run.portalId ?? "portal"} · started ${when(run.startedAt)}${run.errorCode ? html` · <span class="bad">${run.errorCode}</span>` : ""}</p></div></div>
  <div class="stats">
    ${stat("Time", ms(run.ms), run.mode === "agentic" ? "wall clock, incl. approvals" : "incl. the approval wait")}
    ${stat("Model calls", int(run.modelCalls ?? calls.length), run.mode === "replay" ? "replay path: none" : `${calls.length} in the ledger`)}
    ${stat("Execution cost", usd(run.costUsd), "Standard list price")}
    ${stat(trace ? "Actions" : "Steps", int(trace ? actions : steps.length), trace ? `${trace.steps.filter((s) => s.tags.includes("noise")).length} noise (dropped)` : `${steps.filter((s) => s.status === "ok").length} as recorded`)}
    ${stat("Heals", int(heals.length), heals.length ? heals.map((h) => `rung ${RUNG[h.rung ?? ""]?.n ?? "?"}`).join(" · ") : "none needed")}
    ${stat("Verified", verified.length ? html`${verified.filter((r) => r.ok).length}<small>/ ${verified.length}</small>` : "–", "read back before submit")}
    ${stat("Result", id ? html`<span class="mono" style="font-size:17px">${id}</span>` : (run.outcome ?? "–"), run.extracted ? Object.keys(run.extracted).join(", ") : "")}
  </div>
  <div class="grid"><div style="display:flex;flex-direction:column;gap:20px;min-width:0">
    ${trace ? agenticTimeline(base, trace, d.screenshots(run.id), calls) : replayTimeline(run, steps, used, created?.skill)}
    ${callsPanel(calls)}
  </div>
  <aside class="side">
    ${run.finalScreenshotId ? html`<section class="panel"><h2>Final page</h2><div class="pb">${img(base, run.finalScreenshotId)}</div></section>` : ""}
    ${commitGate?.imageArtifactId ? html`<section class="panel"><h2>On the approval card <span>${commitGate.status}</span></h2><div class="pb">${img(base, commitGate.imageArtifactId)}</div></section>` : ""}
    ${readbackPanel(rb)}
    ${canaryPanel(canaries, run.id)}
    ${
      picks.length
        ? html`<section class="panel"><h2>Open-weights picks <span>heal rung 2, text only</span></h2><table><tbody>${picks.map(
            (p) =>
              html`<tr class="link" data-href="${base}picks/${p.id}"><td>Step ${p.doc.stepIdx + 1}<div class="muted" style="font-size:12px">${p.doc.chosen ? `now '${p.doc.chosen}'` : (p.doc.reason ?? "")}</div></td><td>${p.doc.ok ? chip("accepted", COLORS.ok) : chip("rejected", COLORS.bad)}</td><td class="num">${p.call ? latency(p.call.latencyMs, p.call.provider) : ms(p.doc.ms)}<div class="muted">${usd(p.doc.costUsd)}</div></td></tr>`,
          )}</tbody></table></section>`
        : ""
    }
    <section class="panel"><h2>Links</h2><div class="pb"><dl class="kv">
      ${run.skillName && run.skillVersion ? html`<dt>Skill run</dt><dd><a href="${base}skills/${run.skillName}${run.skillVersion ? `?v=${run.skillVersion}` : ""}">${run.skillName} v${run.skillVersion ?? "?"}</a></dd>` : ""}
      ${created ? html`<dt>Created</dt><dd><a href="${base}skills/${created.name}?v=${created.version}">${created.name} v${created.version}</a> <span class="muted">(${created.source})</span></dd>` : ""}
      ${draftId ? html`<dt>Taught from</dt><dd><a href="${base}teach/${draftId}">teach draft</a></dd>` : ""}
      ${run.jobId ? html`<dt>Job</dt><dd class="mono">${run.jobId}</dd>` : ""}
      <dt>Run id</dt><dd class="mono">${run.id}</dd>
    </dl></div></section>
  </aside></div>`;
  return page({ title: `Run ${shortId(run.id)}`, nav: "runs", body, base });
}

// ---------- skill ----------

function diffLines(parent: SkillRow, sel: SkillRow, notes: { stepId: string; rung: string }[]): Html {
  const lines = diffSkills(parent.skill, sel.skill, notes as never);
  if (lines.length === 0) return html`<p class="empty">No differences.</p>`;
  return html`<ul class="diff">${lines.map((l) => {
    const cls = /^(new|added|\+)/i.test(l)
      ? "add"
      : /^(removed|dropped|-)/i.test(l)
        ? "del"
        : /^(step|param|success|title|~)/i.test(l)
          ? "chg"
          : "inf";
    const mark = cls === "add" ? "+" : cls === "del" ? "−" : cls === "chg" ? "~" : "·";
    return html`<li class="${cls}"><span class="m">${mark}</span><span>${l}</span></li>`;
  })}</ul>`;
}

function targetPairs(parent: SkillRow, sel: SkillRow, notes: Map<string, string>): Html {
  const old = new Map(parent.skill.steps.map((s) => [s.id, s]));
  const pairs: Html[] = [];
  for (const s of sel.skill.steps) {
    const o = old.get(s.id);
    const a = o ? stepTarget(o) : undefined;
    const b = stepTarget(s);
    if (!b) continue;
    if (!o) {
      const how = notes.get(s.id);
      pairs.push(
        html`<div class="pair"><div class="side-a" style="opacity:.55"><h4>v${parent.version}</h4><span class="muted">no such step</span></div><div class="arrow">now</div><div class="side-b"><h4>v${sel.version} · new step ${s.id}${how ? html` · ${RUNG[how] ? `rung ${RUNG[how]?.n} · ${RUNG[how]?.how}` : how}` : ""}</h4><b>${s.intent}</b>${cands(b, 2)}</div></div>`,
      );
      continue;
    }
    if (!a || JSON.stringify(a.candidates) === JSON.stringify(b.candidates)) continue;
    const how = notes.get(s.id);
    pairs.push(
      html`<div class="pair"><div class="side-a"><h4>v${parent.version} · ${s.id}</h4><b>${displayName(a.fingerprint)}</b>${cands(a, 3)}</div><div class="arrow">now</div><div class="side-b"><h4>v${sel.version}${how ? html` · ${RUNG[how] ? `rung ${RUNG[how]?.n} · ${RUNG[how]?.how}` : how}` : ""}</h4><b>${displayName(b.fingerprint)}</b>${cands(b, 3)}</div></div>`,
    );
  }
  return html`${pairs}`;
}

function programTable(skill: Skill): Html {
  return html`<table><thead><tr><th>#</th><th>Op</th><th>Intent</th><th>Element</th><th>Value</th></tr></thead><tbody>${skill.steps.map(
    (s, i) =>
      html`<tr><td class="muted">${i + 1}</td><td><span class="op">${s.op}</span>${"commit" in s && s.commit ? html` <span class="tag commit">commit</span>` : ""}</td><td>${s.intent}</td><td>${stepTarget(s) ? html`<b>${displayName(stepTarget(s)?.fingerprint)}</b>${cands(stepTarget(s), 1)}` : html`<span class="faint">–</span>`}</td><td>${stepValue(s, null)}</td></tr>`,
  )}</tbody></table>`;
}

export function skillView(d: RecorderData, base: string, name: string, v: number | null): string | null {
  const versions = d.skillVersions(name);
  if (versions.length === 0) return null;
  const sel =
    versions.find((x) => x.version === v) ?? versions.find((x) => x.active) ?? (versions.at(-1) as SkillRow);
  const parent = sel.parentVersion ? versions.find((x) => x.version === sel.parentVersion) : undefined;
  const sourceSteps = sel.sourceRunId ? d.steps(sel.sourceRunId) : [];
  const notes = sourceSteps.filter((s) => s.rung).map((s) => ({ stepId: s.stepId, rung: s.rung as string }));
  const runs = d.runsForSkill(name, 30);
  const draftId = sel.skill.createdFrom.draftId;
  const json = JSON.stringify(sel.skill, null, 2);
  const ts = exportPlaywright(sel.skill);
  const body = html`
  <div class="crumbs"><a href="${base.slice(0, -1)}#skills">Skills</a> / <span class="mono">${name}</span></div>
  <div class="head"><div><h1 class="title">${sel.skill.title} ${chip(`v${sel.version}`, COLORS.replay, { lg: true })}${sel.active ? chip("active", COLORS.ok, { lg: true }) : chip("inactive (kept for rollback)", COLORS.muted, { lg: true })}</h1>
  <p class="sub"><span class="mono">${name}</span> · ${sel.skill.portalId} · ${sel.skill.params.length} values · ${sel.skill.steps.length} steps · source: ${sel.source}${sel.sourceRunId ? html` (<a href="${base}runs/${sel.sourceRunId}">run</a>)` : ""} · ${when(sel.createdAt)}</p></div></div>
  <div class="versions" style="margin-bottom:20px">${versions.map(
    (x) =>
      html`<a class="ver${x.version === sel.version ? " on" : ""}" href="${base}skills/${name}?v=${x.version}"><b>v${x.version}${x.active ? html` <span class="ok" style="font-size:12px">active</span>` : ""}</b><span>${x.source === "compile" ? "compiled from a run" : x.source === "heal" ? "healed" : x.source === "ask_rep" ? "asked the rep" : x.source}${x.parentVersion ? ` · from v${x.parentVersion}` : ""}</span><span>${when(x.createdAt)}</span></a>`,
  )}</div>
  <div class="grid"><div style="display:flex;flex-direction:column;gap:20px;min-width:0">
    ${parent ? html`<section class="panel"><h2>What changed from v${parent.version} to v${sel.version} <span>${notes.length ? `${notes.length} step${notes.length === 1 ? "" : "s"} fixed in the run` : ""}</span></h2>${diffLines(parent, sel, notes)}${targetPairs(parent, sel, new Map(notes.map((n) => [n.stepId, n.rung])))}</section>` : ""}
    <section class="panel"><div class="ph"><span style="display:flex;gap:12px;align-items:center;color:var(--text)">Compiled program <a class="chip" style="--c:var(--replay)" href="${base}skills/${name}/code?v=${sel.version}">▶ code reveal</a></span><div class="tabs" data-tabs="prog"><button data-tab="steps" class="on">Steps</button><button data-tab="json">JSON</button><button data-tab="ts">Playwright export</button></div></div>
      <div data-pane="prog" data-name="steps">${programTable(sel.skill)}</div>
      <div data-pane="prog" data-name="json" hidden><pre class="code">${highlight(json, "json")}</pre></div>
      <div data-pane="prog" data-name="ts" hidden><pre class="code">${highlight(ts, "ts")}</pre></div>
    </section>
  </div><aside class="side">
    <section class="panel"><h2>Parameters</h2><table><tbody>${sel.skill.params.map(
      (p) =>
        html`<tr><td><span class="pchip">${p.name}</span>${p.required ? html` <span class="bad">*</span>` : ""}<div class="muted" style="font-size:12px;margin-top:3px">${p.description}</div></td><td class="num"><span class="tag">${p.type}</span></td></tr>`,
    )}</tbody></table></section>
    <section class="panel"><h2>Success check</h2><div class="pb"><dl class="kv">${sel.skill.success.urlIncludes ? html`<dt>URL contains</dt><dd class="mono">${sel.skill.success.urlIncludes}</dd>` : ""}${sel.skill.success.textPattern ? html`<dt>Text matches</dt><dd class="mono">${sel.skill.success.textPattern}</dd>` : ""}${sel.skill.success.extract.map((e) => html`<dt>Extract ${e.name}</dt><dd class="mono">/${e.regex}/</dd>`)}
      <dt>Created from</dt><dd>${sel.skill.createdFrom.kind === "video" ? "a screen recording" : "a goal"}${draftId ? html` · <a href="${base}teach/${draftId}">teach draft</a>` : ""} · <a href="${base}runs/${sel.skill.createdFrom.traceRunId}">first run</a></dd></dl></div></section>
    <section class="panel"><h2>Runs <span>${runs.length}</span></h2>${
      runs.length
        ? html`<table><tbody>${runs.map(
            (r) =>
              html`<tr class="link" data-href="${base}runs/${r.id}"><td>${chip(MODE_LABEL[r.mode] ?? r.mode, MODE_COLOR[r.mode] ?? COLORS.muted, { dot: true })} <span class="muted">v${r.skillVersion ?? "?"}</span></td><td>${r.outcome ? chip(r.outcome.replace(/_/g, " "), OUTCOME_COLOR[r.outcome] ?? COLORS.muted) : ""}</td><td class="num">${ms(r.ms)}</td><td class="num">${usd(r.costUsd)}</td></tr>`,
          )}</tbody></table>`
        : html`<p class="empty">No runs yet.</p>`
    }</section>
  </aside></div>`;
  return page({ title: `${name} v${sel.version}`, nav: "skills", body, base }).toString();
}

// ---------- teach ----------

function stepWithParams(text: string): Html {
  const parts = text.split(/(\{\{[a-z][a-z0-9_]*\}\})/g);
  return html`${parts.map((p) => (/^\{\{.*\}\}$/.test(p) ? html`<span class="pchip">${p.slice(2, -2)}</span>` : p))}`;
}

const TEACH_FOCUS_CSS = `
body.focus{background:var(--paper)}
.stage{position:fixed;inset:0;padding:44px 84px 40px;display:flex;flex-direction:column;gap:18px}
.tk{font-size:22px;color:var(--muted)}
.th{font-size:42px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.tframes{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
.tframes img{width:100%;aspect-ratio:16/10;object-fit:cover;border-radius:2px;border:1px solid var(--line);display:block;background:var(--surface)}
.tcols{display:grid;grid-template-columns:minmax(0,1.9fr) minmax(0,1fr);gap:36px;min-height:0}
.tsteps li>span{;overflow-wrap:anywhere}
.tsteps{list-style:none;margin:0;padding:0;counter-reset:s;border-top:1px solid var(--line)}
.tsteps li{counter-increment:s;display:grid;grid-template-columns:40px minmax(0,1fr);gap:8px;padding:6px 0;border-bottom:1px solid var(--line);font-size:26px;line-height:1.25;overflow-wrap:anywhere}
.tsteps li::before{content:counter(s);color:var(--muted);font:400 22px var(--mono);padding-top:3px}
.tsteps li.more::before{content:""}
.tsteps li.more{color:var(--muted);font-size:22px}
.tsteps .pchip,.tparams .pchip{font-size:.85em}
.tparams{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.tparams li{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:24px}
.tparams li span:last-child{color:var(--muted);font-size:20px;white-space:nowrap}
`;

/** Filming: what Muse saw (4 frames), the steps it wrote with its values by name, the value list. */
function teachFocus(d: RecorderData, base: string, t: DraftRow): string {
  const draft = t.draft;
  const video = d.draftVideo(t);
  const n = 4;
  const steps = draft.steps.slice(0, 6);
  const more = draft.steps.length - steps.length;
  const body = html`<style>${raw(TEACH_FOCUS_CSS)}</style>
  <div class="tk">Taught from one screen recording · ${draft.steps.length} steps · ${draft.params.length} values</div>
  <h1 class="th">${draft.title}</h1>
  ${video ? html`<div class="tframes">${Array.from({ length: n }, (_, i) => html`<img src="${base}frames/${video}/${i}?n=${n}" alt="frame ${i + 1}">`)}</div>` : ""}
  <div class="tcols"><ol class="tsteps">${steps.map((s) => html`<li><span>${stepWithParams(s)}</span></li>`)}${more > 0 ? html`<li class="more"><span>+${more} more steps</span></li>` : ""}</ol>
  <ul class="tparams">${draft.params.slice(0, 5).map((p) => html`<li><span class="pchip">${p.name}</span><span>${p.type}${p.required ? ", required" : ""}</span></li>`)}${draft.params.length > 5 ? html`<li><span class="muted">+${draft.params.length - 5} more</span><span></span></li>` : ""}</ul></div>`;
  return page({ title: draft.title, nav: "teach", body, base, focus: true });
}

export function teachView(d: RecorderData, base: string, t: DraftRow, frames: number, focus = false): string {
  if (focus) return teachFocus(d, base, t);
  const draft = t.draft;
  const video = d.draftVideo(t);
  const compiled = d.skillFromDraft(t.id);
  const observed = draft.observedValues ?? {};
  const body = html`
  <div class="crumbs"><a href="${base.slice(0, -1)}#teach">Teach</a> / <span class="mono">${t.id}</span></div>
  <div class="head"><div><h1 class="title">${draft.title} ${chip(t.status, t.status === "compiled" ? COLORS.ok : t.status === "draft" ? COLORS.agentic : COLORS.muted, { lg: true })}</h1>
  <p class="sub">${draft.goal}</p></div></div>
  <div class="stats">
    ${stat("Steps", int(draft.steps.length), "plain language, params by name")}
    ${stat("Params", int(draft.params.length), `${draft.params.filter((p) => p.required).length} required`)}
    ${stat("Submit control", html`<span style="font-size:16px">${draft.commitStep}</span>`, "always waits for approval")}
    ${stat("Portal", html`<span style="font-size:16px">${draft.portalId}</span>`, draft.startUrl.replace(/^https?:\/\/[^/]+/, ""))}
    ${stat("Compiled", compiled ? html`<a href="${base}skills/${compiled.name}?v=${compiled.version}">v${compiled.version}</a>` : "not yet", compiled ? "after the first real run" : "first real request runs with computer use")}
  </div>
  <section class="panel" style="margin-bottom:20px"><h2>What Muse saw <span>${video ? `${frames} frames sampled evenly across the recording` : "no recording stored"}</span></h2>${
    video
      ? html`<div class="film">${Array.from({ length: frames }, (_, i) => html`<figure><img src="${base}frames/${video}/${i}?n=${frames}" alt="frame ${i + 1}" loading="lazy"><figcaption data-i="${i}">${i + 1}/${frames}</figcaption></figure>`)}</div>`
      : html`<p class="empty">The recording is not in the artifact store.</p>`
  }</section>
  <div class="grid"><div style="display:flex;flex-direction:column;gap:20px;min-width:0">
    <section class="panel"><h2>Draft steps <span>written by the teach model</span></h2><ol class="dsteps">${draft.steps.map((s) => html`<li><span>${stepWithParams(s)}</span></li>`)}</ol></section>
  </div><aside class="side">
    <section class="panel"><h2>Typed parameters <span>values seen are never reused</span></h2><table><thead><tr><th>Param</th><th>Type</th><th>Seen in the video</th></tr></thead><tbody>${draft.params.map(
      (p) =>
        html`<tr><td><span class="pchip">${p.name}</span>${p.required ? html` <span class="bad">*</span>` : ""}<div class="muted" style="font-size:12px;margin-top:3px">${p.description}${p.enumValues?.length ? html`<br>one of: ${p.enumValues.join(", ")}` : ""}</div></td><td><span class="tag">${p.type}</span></td><td class="mono" style="font-size:12px;color:var(--text-2)">${observed[p.name] ?? html`<span class="faint">–</span>`}</td></tr>`,
    )}</tbody></table></section>
    <section class="panel"><h2>Success check</h2><div class="pb">${draft.success}</div></section>
  </aside></div>`;
  return page({ title: draft.title, nav: "teach", body, base }).toString();
}

export { esc };

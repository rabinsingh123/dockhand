// Receipts and cards: HTML templates rendered to PNG in the shared browser. Text comes from templates
// (zero model calls); costs always show execution and intake separately.

import type { ArtifactRef, ArtifactStore, Id, Receipt, Skill, SkillDraft, Transcript } from "@dockhand/core";

export type RenderHtml = (
  html: string,
  size: { w: number; h: number },
  opts?: { fullPage?: boolean },
) => Promise<Uint8Array>;

export const OPEN_WEIGHTS_CREDIT = "Built with Muse Spark Open";

const TIER_LABEL: Record<Receipt["tier"], string> = {
  api: "API",
  replay: "Replay · compiled skill",
  agentic: "First run · computer use",
  repair: "Replay · repaired",
};

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** "$0.00", "$0.004", "$0.12"; anything under a tenth of a cent is "<$0.001". */
export function usd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0.00";
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  if (n >= 0.001) return `$${n.toFixed(3)}`;
  return "<$0.001";
}

/** "3.1 s" under a minute, "2 min 5 s" above. */
export function seconds(s: number): string {
  if (!Number.isFinite(s) || s < 0) return "0.0 s";
  if (s < 59.95) return `${s.toFixed(1)} s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)} min ${whole % 60} s`;
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font:15px/1.45 "Segoe UI",system-ui,-apple-system,Helvetica,Arial,sans-serif;color:#13212f;background:#eef2f5;padding:20px}
.card{background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 1px 3px rgba(16,32,48,.12)}
.top{background:#0b3048;color:#fff;padding:18px 24px}
.brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9cc3d6}
h1{font-size:22px;line-height:1.25;margin-top:4px}
.badge{display:inline-block;margin-top:10px;padding:3px 10px;border-radius:999px;background:#1f8a8a;color:#fff;font-size:12px;font-weight:600}
.badge.agentic{background:#7a4cc2}.badge.repair{background:#c2721f}.badge.api{background:#2b6cb0}
.body{padding:18px 24px}
.id{font:600 26px/1.2 Consolas,"Cascadia Mono",monospace;color:#0b3048;margin-bottom:10px}
ul{list-style:none}li{padding:4px 0 4px 18px;position:relative}
li:before{content:"";position:absolute;left:2px;top:12px;width:6px;height:6px;border-radius:50%;background:#1f8a8a}
ol{padding-left:22px}ol li{padding-left:2px}ol li:before{display:none}
.stats{display:flex;flex-wrap:wrap;gap:10px;margin-top:14px}
.stat{flex:1 1 140px;background:#f3f6f8;border-radius:10px;padding:10px 12px}
.stat b{display:block;font-size:18px}.stat span{font-size:12px;color:#5b6b78}
.shot{margin-top:14px;border:1px solid #d8e0e6;border-radius:10px;width:100%}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:#5b6b78;margin:16px 0 6px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:5px 6px;border-bottom:1px solid #e6ecf0;vertical-align:top}
td.k{font-family:Consolas,monospace;color:#0b3048;white-space:nowrap}
.muted{color:#5b6b78;font-size:13px}
.foot{display:flex;justify-content:space-between;padding:10px 24px;background:#f7f9fa;color:#5b6b78;font-size:12px}
.credit{font-weight:600;color:#0b3048}
code{font-family:Consolas,monospace;font-size:13px;background:#f3f6f8;padding:1px 5px;border-radius:4px}
`;

function page(inner: string, footLeft: string, footRight = "Synthetic demo data"): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body><div class="card">${inner}<div class="foot"><span>${footLeft}</span><span>${esc(footRight)}</span></div></div></body></html>`;
}

function dataUri(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

// ---------- receipt ----------

export interface ReceiptView {
  title: string;
  tier: Receipt["tier"];
  headline?: string;
  lines: string[];
  seconds: number;
  execCostUsd: number;
  intakeCostUsd: number;
  skill?: { name: string; version: number };
  verified?: { matched: number; checked: number };
  usedOpenWeights?: boolean;
  /** PNG of the final page. */
  screenshot?: Uint8Array;
}

export function receiptHtml(r: ReceiptView): string {
  const stats = [
    [seconds(r.seconds), "wall time"],
    [usd(r.execCostUsd), "execution cost"],
    [usd(r.intakeCostUsd), "intake cost"],
    ...(r.verified ? [[`${r.verified.matched}/${r.verified.checked}`, "fields verified before submit"]] : []),
    ...(r.skill ? [[`${r.skill.name} v${r.skill.version}`, "skill"]] : []),
  ];
  const inner = `<div class="top"><div class="brand">Dockhand receipt</div><h1>${esc(r.title)}</h1><span class="badge ${r.tier}">${esc(TIER_LABEL[r.tier])}</span></div>
<div class="body">${r.headline ? `<div class="id">${esc(r.headline)}</div>` : ""}<ul>${r.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<div class="stats">${stats.map(([v, k]) => `<div class="stat"><b>${esc(v ?? "")}</b><span>${esc(k ?? "")}</span></div>`).join("")}</div>
${r.screenshot ? `<img class="shot" src="${dataUri("image/png", r.screenshot)}">` : ""}</div>`;
  return page(
    inner,
    r.usedOpenWeights ? `<span class="credit">${OPEN_WEIGHTS_CREDIT}</span>` : "Tidewater Cloud · Dockhand",
  );
}

// ---------- skill card ----------

export interface SkillCardView {
  skill: Pick<Skill, "name" | "version" | "title" | "portalId" | "params" | "steps" | "success">;
  portalName: string;
  verified: { passed: number; total: number };
  fromRun: Id;
  successDescription?: string;
}

export function skillCardHtml(v: SkillCardView): string {
  const s = v.skill;
  const id = s.success.extract[0];
  const inner = `<div class="top"><div class="brand">New skill · compiled from a computer-use run</div><h1>${esc(s.title)}</h1><span class="badge">${esc(`${s.name} v${s.version}`)}</span></div>
<div class="body"><ul>
<li>${esc(`${v.portalName}: ${s.steps.length} steps, ${s.params.length} params`)}</li>
<li>${esc(`Verified by ${v.verified.passed}/${v.verified.total} dry runs before saving`)}</li>
<li>${esc(`Success check: ${v.successDescription ?? s.success.textPattern ?? s.success.urlIncludes ?? "confirmation page"}${id ? ` · ID /${id.regex}/` : ""}`)}</li>
<li>${esc("Next time: replay in seconds, zero model calls")}</li></ul>
<h2>Params</h2><table>${s.params
    .map(
      (p) =>
        `<tr><td class="k">${esc(p.name)}</td><td>${esc(p.type)}${p.required ? "" : " · optional"}</td><td class="muted">${esc(p.description)}</td></tr>`,
    )
    .join("")}</table></div>`;
  return page(inner, esc(`compiled from run ${v.fromRun}`));
}

// ---------- teach card ----------

export function teachCardHtml(d: SkillDraft, narration?: Transcript): string {
  const observed = Object.entries(d.observedValues ?? {});
  const inner = `<div class="top"><div class="brand">What Muse saw in your recording</div><h1>${esc(d.title)}</h1><span class="badge">${esc(d.name)}</span></div>
<div class="body"><div class="muted">${esc(d.goal)}</div>
<h2>Steps</h2><ol>${d.steps.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
<h2>Params</h2><table>${d.params
    .map(
      (p) =>
        `<tr><td class="k">${esc(p.name)}</td><td>${esc(p.type)}${p.required ? "" : " · optional"}</td><td class="muted">${esc(p.enumValues?.length ? `${p.description} (${p.enumValues.length} options)` : p.description)}</td></tr>`,
    )
    .join("")}</table>
<h2>Submit and success</h2><ul><li>${esc(`Submits with "${d.commitStep}" (always after your approval)`)}</li><li>${esc(d.success)}</li></ul>
${observed.length ? `<h2>Values in the video (shown, never reused)</h2><div class="muted">${esc(observed.map(([k, v]) => `${k}: ${v}`).join(" · "))}</div>` : ""}
${narration?.text ? `<h2>Narration</h2><div class="muted">${esc(narration.text.slice(0, 400))}</div>` : ""}</div>`;
  return page(inner, "Draft · the first real request runs once with computer use, then compiles");
}

// ---------- diff card ----------

export interface DiffCardView {
  name: string;
  title: string;
  from: number;
  to: number;
  lines: string[];
  rungs: string[];
  canary: { passed: number; total: number };
  usedOpenWeights?: boolean;
}

export function diffCardHtml(v: DiffCardView): string {
  const inner = `<div class="top"><div class="brand">Portal changed · skill repaired</div><h1>${esc(v.title)}</h1><span class="badge repair">${esc(`${v.name} v${v.from} → v${v.to}`)}</span></div>
<div class="body"><ul>${v.lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<div class="stats"><div class="stat"><b>${esc(v.rungs.join(", ") || "none")}</b><span>fixed by</span></div>
<div class="stat"><b>${v.canary.passed}/${v.canary.total}</b><span>canary dry runs passed</span></div>
<div class="stat"><b>v${v.from}</b><span>kept for rollback</span></div></div>
<div class="muted" style="margin-top:12px">Undo: <code>/rollback ${esc(v.name)} ${v.from}</code></div></div>`;
  return page(
    inner,
    v.usedOpenWeights ? `<span class="credit">${OPEN_WEIGHTS_CREDIT}</span>` : "Tidewater Cloud · Dockhand",
  );
}

// ---------- rendering ----------

export interface CardRenderer {
  receipt(jobId: Id, view: ReceiptView): Promise<Receipt>;
  card(jobId: Id, html: string): Promise<ArtifactRef>;
}

export function createCardRenderer(deps: {
  artifacts: ArtifactStore;
  render: RenderHtml;
  width?: number;
}): CardRenderer {
  const w = deps.width ?? 720;
  const card = async (jobId: Id, html: string) =>
    deps.artifacts.put(await deps.render(html, { w, h: 400 }, { fullPage: true }), "image/png", {
      kind: "receipt",
      jobId,
    });
  return {
    card,
    async receipt(jobId, view) {
      const image = await card(jobId, receiptHtml(view));
      return {
        jobId,
        title: view.title,
        lines: view.headline ? [view.headline, ...view.lines] : view.lines,
        tier: view.tier,
        seconds: view.seconds,
        execCostUsd: view.execCostUsd,
        intakeCostUsd: view.intakeCostUsd,
        ...(view.skill ? { skill: view.skill } : {}),
        ...(view.verified ? { verified: view.verified } : {}),
        image,
      };
    },
  };
}

/** A record ID ("NW-REG-48213", "Q-2026-0001"): shown in monospace, nothing else is. */
export const looksLikeRecordId = (s: string): boolean => /^[A-Z0-9][A-Z0-9-]{4,}$/.test(s) && /\d/.test(s);

/** The caption under a receipt image: the same facts as short lines, WhatsApp formatting. */
export function receiptCaption(r: Receipt, usedOpenWeights = false): string {
  const first = r.lines[0];
  const facts = [
    ...(r.verified ? [`${r.verified.matched}/${r.verified.checked} fields verified`] : []),
    ...(r.skill ? [`${r.skill.name} v${r.skill.version}`] : []),
  ];
  const parts = [
    `*${r.title}*`,
    ...(first ? [looksLikeRecordId(first) ? `\`${first}\`` : first] : []),
    `${TIER_LABEL[r.tier]} · ${seconds(r.seconds)}`,
    ...(facts.length > 0 ? [facts.join(" · ")] : []),
    `Cost: execution ${usd(r.execCostUsd)} + intake ${usd(r.intakeCostUsd)}`,
    ...(usedOpenWeights ? [OPEN_WEIGHTS_CREDIT] : []),
  ];
  return parts.join("\n");
}

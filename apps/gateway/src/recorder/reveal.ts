// Two close-up views for the video: the compiled program typing itself in (with a heal's patched lines as a
// diff), and an open-weights pick (the text list Muse Spark Open got, its pick, the harness checks, $ and time).

import { exportPlaywright } from "@dockhand/skills";
import type { RecorderData, SkillRow } from "./data.ts";
import { COLORS, chip, esc, type Html, highlight, html, ms, page, raw, usd } from "./html.ts";

// ---------- code reveal ----------

type Op = { t: "same" | "add" | "del"; html: string };

/** Line diff by longest common subsequence (exports are a few hundred lines at most). */
function lineDiff(a: string[], b: string[]): { t: Op["t"]; line: string }[] {
  // the header names the version: compare it without the number, show the new one
  const key = (l: string) => l.replace(/^(\/\/ Dockhand skill \S+) v\d+/, "$1");
  const ka = a.map(key);
  const kb = b.map(key);
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = dp[i] as number[];
      row[j] =
        ka[i] === kb[j]
          ? ((dp[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((dp[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const out: { t: Op["t"]; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (ka[i] === kb[j]) {
      out.push({ t: "same", line: b[j] as string });
      i++;
      j++;
    } else if (((dp[i + 1] as number[])[j] as number) >= ((dp[i] as number[])[j + 1] as number))
      out.push({ t: "del", line: a[i++] as string });
    else out.push({ t: "add", line: b[j++] as string });
  }
  while (i < a.length) out.push({ t: "del", line: a[i++] as string });
  while (j < b.length) out.push({ t: "add", line: b[j++] as string });
  return out;
}

/** Highlights one line of TypeScript with every `p.<param>` shown as a param chip. */
function lineHtml(line: string): string {
  return line
    .split(/(\bp\.[a-z][a-z0-9_]*)/g)
    .map((part) =>
      /^p\.[a-z]/.test(part) ? `<span class="pp">${esc(part)}</span>` : highlight(part, "ts").value,
    )
    .join("");
}

const REVEAL_CSS = `
body{overflow:hidden}
.reveal{position:fixed;inset:52px 0 0 0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:#0a0c10}
.rbar{display:flex;align-items:center;gap:12px;padding:12px 28px;border-bottom:1px solid var(--line);background:#0d1016}
.tab{display:inline-flex;align-items:center;gap:8px;padding:6px 12px;border-radius:8px 8px 0 0;background:#12161d;border:1px solid var(--line);border-bottom:0;font:600 13px var(--mono);color:#e9edf3}
.rbar .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
.rbar button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;background:rgba(255,255,255,.07);font-weight:650;font-size:13px}
.rbar button:hover{background:rgba(255,255,255,.12)}
.editor{overflow:auto;padding:14px 0 40vh;font:15px/1.62 var(--mono);color:#d6dde8;tab-size:2}
.ln{display:grid;grid-template-columns:62px 22px minmax(0,1fr);white-space:pre;min-height:1.62em}
.ln .no{color:#4b5563;text-align:right;padding-right:14px;user-select:none}
.ln .mk{font-weight:800;user-select:none}
.ln .tx{overflow:hidden}
.ln.add{background:rgba(74,222,128,.09)}.ln.add .mk{color:#4ade80}.ln.add .no{color:#4ade80}
.ln.del{background:rgba(251,113,133,.09)}.ln.del .mk{color:#fb7185}.ln.del .tx{text-decoration:line-through;text-decoration-color:rgba(251,113,133,.7);opacity:.75}
.ln.typing .tx::after{content:"";display:inline-block;width:.55em;height:1.15em;margin-left:1px;vertical-align:-.2em;background:#22d3ee;animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.pp{padding:0 4px;border-radius:5px;background:rgba(167,139,250,.2);color:#e9d5ff;box-shadow:inset 0 0 0 1px rgba(167,139,250,.35)}
.code .k,.editor .k{color:#c4b5fd}.editor .s{color:#86efac}.editor .n{color:#fcd34d}.editor .c{color:#64748b;font-style:italic}.editor .f{color:#67e8f9}.editor .p{color:#7dd3fc}
.rfoot{display:flex;gap:18px;align-items:center;padding:10px 28px;border-top:1px solid var(--line);background:#0d1016;font-size:13px;color:var(--muted)}
.rfoot b{color:#e9edf3}
`;

/** GET /recorder/skills/:name/code?v=N : the program types itself in; a healed version types its diff. */
export function codeRevealView(d: RecorderData, base: string, name: string, v: number | null): string | null {
  const versions = d.skillVersions(name);
  if (versions.length === 0) return null;
  const sel =
    versions.find((x) => x.version === v) ?? versions.find((x) => x.active) ?? (versions.at(-1) as SkillRow);
  const parent = sel.parentVersion ? versions.find((x) => x.version === sel.parentVersion) : undefined;
  const now = exportPlaywright(sel.skill).split("\n");
  const ops: Op[] = parent
    ? lineDiff(exportPlaywright(parent.skill).split("\n"), now).map((o) => ({
        t: o.t,
        html: lineHtml(o.line),
      }))
    : now.map((line) => ({ t: "same", html: lineHtml(line) }));
  const added = ops.filter((o) => o.t === "add").length;
  const removed = ops.filter((o) => o.t === "del").length;
  const params = sel.skill.params.length;
  const body = html`<style>${raw(REVEAL_CSS)}</style>
  <div class="reveal">
    <div class="rbar"><span class="tab">${name}.v${sel.version}.ts</span>
      ${chip(parent ? `v${parent.version} → v${sel.version}` : "compiled from one computer-use run", parent ? COLORS.repair : COLORS.agentic, { dot: true })}
      ${parent ? chip(`+${added} −${removed} lines`, COLORS.muted) : ""}
      <span class="sp"><button id="again">Replay</button><button id="all">Show all</button><a class="muted" href="${base}skills/${name}?v=${sel.version}">skill view</a></span></div>
    <div class="editor" id="ed"></div>
    <div class="rfoot"><span><b>${sel.skill.steps.length}</b> steps</span><span><b>${params}</b> typed params, highlighted like <span class="pp">p.name</span></span><span>No model calls when this runs</span>${parent ? html`<span><b class="ok">green</b> lines: the heal's patch · <b class="bad">red</b>: what it replaced</span>` : ""}</div>
  </div>
  <script>
  (() => {
    const ops = ${raw(JSON.stringify(ops).replace(/</g, "\\u003c"))};
    const diff = ${parent ? "true" : "false"};
    const bodyAt = ops.findIndex((o) => o.html.replace(/<[^>]+>/g, "").includes("export async function"));
    const speed = Number(new URLSearchParams(location.search).get("speed") || "1");
    const ed = document.getElementById("ed");
    let timer = null, n = 0;
    function lineEl(op, no) {
      const row = document.createElement("div");
      row.className = "ln " + op.t;
      row.innerHTML = '<span class="no"></span><span class="mk"></span><span class="tx"></span>';
      row.children[0].textContent = op.t === "del" ? "" : String(no);
      row.children[1].textContent = op.t === "add" ? "+" : op.t === "del" ? "−" : "";
      return row;
    }
    function run(instant) {
      clearTimeout(timer); ed.innerHTML = ""; n = 0;
      let i = 0, no = 0;
      const step = () => {
        if (i >= ops.length) return;
        const op = ops[i++];
        if (op.t !== "del") no++;
        const row = lineEl(op, no);
        ed.appendChild(row);
        const tx = row.children[2];
        const tmp = document.createElement("span"); tmp.innerHTML = op.html;
        const text = tmp.textContent;
        // the steps are typed out (in a diff: only the patch); headers, types and helpers stream in fast
        const slow = diff ? op.t !== "same" : bodyAt >= 0 && i - 1 > bodyAt;
        if (instant || !text.trim()) { tx.innerHTML = op.html; return instant ? step() : (timer = setTimeout(step, 4 / speed)); }
        row.classList.add("typing");
        let k = 0;
        const per = (slow ? 9 : 1) / speed, total = Math.min(text.length, slow ? 16 : 2);
        const tick = () => {
          k = Math.min(text.length, k + Math.max(1, Math.ceil(text.length / total)));
          tx.textContent = text.slice(0, k);
          if (k < text.length) { timer = setTimeout(tick, per); return; }
          tx.innerHTML = op.html; row.classList.remove("typing");
          row.scrollIntoView({ block: "nearest" });
          timer = setTimeout(step, (slow ? 45 : 3) / speed);
        };
        tick();
      };
      step();
    }
    document.getElementById("again").onclick = () => run(false);
    document.getElementById("all").onclick = () => run(true);
    run(new URLSearchParams(location.search).has("still"));
  })();
  </script>`;
  return page({ title: `${name} v${sel.version} · code`, nav: "skills", body, base });
}

// ---------- open-weights pick ----------

/** What the open-weights repairer keeps per pick (packages/skills repair.ts, artifact kind "heal_pick"). */
export interface PickDoc {
  runId: string;
  stepIdx: number;
  stepId: string;
  intent: string;
  prevIntent?: string;
  nextIntent?: string;
  kind: string;
  before: Record<string, string>;
  list: ({ index: number } & Record<string, string | number>)[];
  listedOf: number;
  pick: { index: number | null; confidence: number; reason: string };
  checks: { check: string; ok: boolean }[];
  ok: boolean;
  reason?: string;
  chosen?: string;
  model: string;
  costUsd: number;
  ms: number;
}

function describe(e: Record<string, string | number>): Html {
  const name = String(e.name ?? e.label ?? e.placeholder ?? e.text ?? "");
  const extra = ["label", "placeholder", "section", "testId"]
    .filter((k) => e[k] !== undefined && e[k] !== name)
    .map((k) => `${k}: ${e[k]}`);
  return html`<b>${name || "(unnamed)"}</b>${extra.length ? html` <span class="muted">· ${extra.join(" · ")}</span>` : ""}`;
}

const PICK_CSS = `
.plist{list-style:none;margin:0;padding:6px 0;font:13.5px/1.4 var(--mono)}
.plist li{display:grid;grid-template-columns:44px 96px minmax(0,1fr);gap:10px;align-items:baseline;padding:7px 16px;border-left:3px solid transparent}
.plist li .ix{color:var(--faint);text-align:right}
.plist li .rl{color:#7dd3fc}
.plist li b{font-weight:650;color:#e9edf3}
.plist li.picked{background:rgba(74,222,128,.1);border-left-color:var(--ok);box-shadow:inset 0 0 0 1px rgba(74,222,128,.25)}
.plist li.picked .ix{color:var(--ok);font-weight:800}
.plist li.picked.rejected{background:rgba(251,113,133,.1);border-left-color:var(--bad)}
.ask{font:14px/1.5 var(--mono);color:#c2cad6}
.ask .k{color:var(--muted)}
.checks{list-style:none;margin:0;padding:8px 0}
.checks li{display:grid;grid-template-columns:26px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:14px}
.checks .ic{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:900;color:#0b0d12}
.checks .ic.ok{background:var(--ok)}.checks .ic.bad{background:var(--bad)}
.verdict{margin:6px 16px 16px;padding:12px 14px;border-radius:10px;font-size:14.5px;font-weight:650}
.verdict.ok{background:rgba(74,222,128,.12);color:#bbf7d0;border:1px solid rgba(74,222,128,.35)}
.verdict.bad{background:rgba(251,113,133,.12);color:#fecdd3;border:1px solid rgba(251,113,133,.35)}
`;

/** GET /recorder/picks/:artifactId : the text list sent to Muse Spark Open, its pick, the harness checks. */
export function pickView(base: string, doc: PickDoc): string {
  const picked = doc.pick.index;
  const body = html`<style>${raw(PICK_CSS)}</style>
  <div class="crumbs"><a href="${base.slice(0, -1)}">Runs</a> / <a href="${base}runs/${doc.runId}" class="mono">${doc.runId}</a> / open-weights pick</div>
  <div class="head"><div><h1 class="title">${chip("Heal · rung 2", COLORS.repair, { dot: true, lg: true })} Muse Spark Open picks the element
    ${doc.ok ? chip("accepted", COLORS.ok, { lg: true }) : chip("rejected", COLORS.bad, { lg: true })}</h1>
    <p class="sub">Step ${doc.stepIdx + 1}: ${doc.intent} · text only, no screenshot · ${doc.model}</p></div></div>
  <div class="stats">
    <div class="stat"><div class="k">Latency</div><div class="v">${ms(doc.ms)}</div><div class="n">one structured call</div></div>
    <div class="stat"><div class="k">Cost</div><div class="v">${usd(doc.costUsd)}</div><div class="n">Standard list price</div></div>
    <div class="stat"><div class="k">Sent</div><div class="v">${doc.list.length}<small>of ${doc.listedOf}</small></div><div class="n">elements of kind "${doc.kind}"</div></div>
    <div class="stat"><div class="k">Picked</div><div class="v">${picked === null ? "none" : `#${picked}`}</div><div class="n">confidence ${doc.pick.confidence}</div></div>
  </div>
  <div class="grid"><section class="panel"><h2>The pruned accessibility list it was given <span>${doc.list.length} elements, same kind as before</span></h2>
    <ol class="plist">${doc.list.map(
      (e) =>
        html`<li class="${e.index === picked ? `picked${doc.ok ? "" : " rejected"}` : ""}"><span class="ix">#${e.index}</span><span class="rl">${String(e.role ?? "")}</span><span>${describe(e)}${e.index === picked ? html` <span class="${doc.ok ? "ok" : "bad"}" style="font-family:var(--sans);font-weight:700">← its pick</span>` : ""}</span></li>`,
    )}</ol></section>
  <aside class="side">
    <section class="panel"><h2>What it was asked</h2><div class="pb ask">
      <div><span class="k">Step:</span> ${doc.intent}</div>
      ${doc.prevIntent ? html`<div><span class="k">Previous step:</span> ${doc.prevIntent}</div>` : ""}
      ${doc.nextIntent ? html`<div><span class="k">Next step:</span> ${doc.nextIntent}</div>` : ""}
      <div style="margin-top:8px"><span class="k">Element before the change:</span></div><div>${describe(doc.before)}</div>
    </div></section>
    <section class="panel"><h2>Its answer</h2><div class="pb"><div class="mono" style="font-size:13.5px">{ "index": ${picked === null ? "null" : picked}, "confidence": ${doc.pick.confidence} }</div><p style="margin-top:8px;color:var(--text-2)">${doc.pick.reason}</p></div></section>
    <section class="panel"><h2>Harness verification <span>the model proposes, code decides</span></h2>
      <ul class="checks">${doc.checks.map((c) => html`<li><span class="ic ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✕"}</span><span>${c.check}</span></li>`)}</ul>
      <div class="verdict ${doc.ok ? "ok" : "bad"}">${doc.ok ? `Accepted: the step now uses '${doc.chosen ?? "the pick"}'. The replay continues and every field is read back before submit.` : `Rejected: ${doc.reason ?? "a check failed"}. The ladder moves to the next rung.`}</div>
    </section>
  </aside></div>`;
  return page({ title: "Open-weights pick", nav: "runs", body, base });
}

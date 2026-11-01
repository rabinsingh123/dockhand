// Two close-up views for the video: the compiled program typing itself in (with a heal's patched lines as a
// diff), and an open-weights pick (the text list Muse Spark Open got, its pick and reason, the harness checks, the
// ledger's latency and cost). Both open in focus mode, made for filming at device scale 2 in a 1280x720 window:
// no header, only the relevant lines, type that stays 40 px or more in a 1080p frame, everything inside the
// area a 1.15x push-in keeps. `?full` gives the complete page.

import { exportPlaywright } from "@dockhand/skills";
import type { RecorderData, SkillRow } from "./data.ts";
import { COLORS, chip, esc, type Html, highlight, html, latency, ms, page, raw, usd } from "./html.ts";

// ---------- code reveal ----------

type Op = { t: "same" | "add" | "del" | "gap"; html: string };

/** Line diff by longest common subsequence (exports are a few hundred lines at most). */
function lineDiff(a: string[], b: string[]): { t: "same" | "add" | "del"; line: string }[] {
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
  const out: { t: "same" | "add" | "del"; line: string }[] = [];
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

/**
 * Focus for a diff: the whole statement of each step a model or the rep fixed (its comment, what it replaced,
 * the patch); every other changed step is counted in one closing line. With no such step, every changed step.
 */
export function focusOps(
  diff: { t: "same" | "add" | "del"; line: string }[],
  modelSteps: Set<string>,
): { t: Op["t"]; line: string }[] {
  const stepOf: (string | null)[] = [];
  let cur: string | null = null;
  for (const d of diff) {
    const m = /^\s*\/\/ (s\d+): /.exec(d.line);
    if (m?.[1]) cur = m[1];
    else if (/^\s*\/\/ Success check|^}/.test(d.line)) cur = null;
    stepOf.push(cur);
  }
  const changed = new Set<string>();
  diff.forEach((d, i) => {
    const s = stepOf[i];
    if (d.t !== "same" && s) changed.add(s);
  });
  const keep = [...changed].filter((s) => modelSteps.has(s));
  const wanted = new Set(keep.length ? keep : [...changed]);
  const out: { t: Op["t"]; line: string }[] = [];
  let skipped = 0;
  let others = 0;
  const flush = () => {
    if (skipped > 0) out.push({ t: "gap", line: "" });
    skipped = 0;
  };
  diff.forEach((d, i) => {
    const s = stepOf[i];
    const inStep = s != null && wanted.has(s);
    if (inStep) {
      flush();
      out.push(d);
    } else {
      skipped++;
      if (d.t === "add" && s != null && !wanted.has(s)) others++;
    }
  });
  flush();
  const otherSteps = [...changed].filter((s) => !wanted.has(s)).length;
  if (otherSteps > 0)
    out.push({
      t: "gap",
      line: `${otherSteps} more step${otherSteps === 1 ? "" : "s"} re-pointed for free (${others} lines)`,
    });
  return out;
}

const REVEAL_CSS = `
body{overflow:hidden}
.reveal{position:fixed;inset:56px 0 0 0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--surface)}
body.focus .reveal{inset:0}
.rbar{display:flex;align-items:center;gap:14px;padding:14px 32px;border-bottom:1px solid var(--line);background:var(--paper)}
body.focus .rbar{padding:44px 84px 16px;border-bottom:0}
.tab{font:500 15px var(--mono);color:var(--ink)}
body.focus .tab{font-size:28px;letter-spacing:-.01em}
body.focus .rbar .chip{height:38px;font-size:24px;padding:0 14px}
.rbar .sp{margin-left:auto;display:flex;gap:8px;align-items:center}
body.focus .rbar .sp{display:none}
.rbar button{all:unset;cursor:pointer;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--surface);font-weight:500;font-size:14px}
.editor{overflow:auto;padding:14px 0 40vh;font:16px/1.6 var(--mono);color:var(--ink);tab-size:2}
body.focus .editor{padding:10px 64px 30vh;font-size:24px;line-height:1.55}
body.focus.diff .editor{font-size:27px}
.ln{display:grid;grid-template-columns:64px 26px minmax(0,1fr);white-space:pre;min-height:1.55em}
body.focus .ln{grid-template-columns:60px 30px minmax(0,1fr)}
.ln .no{color:#B4B1A8;text-align:right;padding-right:14px;user-select:none}
.ln .mk{font-weight:600;user-select:none}
.ln .tx{overflow:hidden;text-overflow:ellipsis}
.ln.add{background:#FFF1EA}.ln.add .mk{color:var(--accent)}
.ln.del .mk{color:var(--muted)}.ln.del .tx{color:var(--muted);text-decoration:line-through;text-decoration-color:rgba(107,107,107,.5)}
.ln.del .tx span{color:inherit!important}
.ln.gap{color:var(--muted);font-family:var(--sans);font-size:.8em;padding:6px 0 6px 90px;display:block;min-height:0}
.ln.gap:empty::before{content:"⋯"}
.ln.typing .tx::after{content:"";display:inline-block;width:.5em;height:1.1em;margin-left:1px;vertical-align:-.18em;background:var(--ink);animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.pp{padding:0 4px;border-radius:5px;background:var(--paper);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line-2)}
.rfoot{display:flex;gap:20px;align-items:center;padding:12px 32px;border-top:1px solid var(--line);background:var(--paper);font-size:14px;color:var(--muted)}
body.focus .rfoot{padding:16px 84px 40px;font-size:22px;border-top:0}
.rfoot b{color:var(--ink);font-weight:600}
`;

/**
 * GET /recorder/skills/:name/code?v=N : the program types itself in; a healed version types its diff. Focus (the
 * default): a diff shows only the lines a model or the rep changed; `?full` shows the whole program.
 */
export function codeRevealView(
  d: RecorderData,
  base: string,
  name: string,
  v: number | null,
  focus = false,
): string | null {
  const versions = d.skillVersions(name);
  if (versions.length === 0) return null;
  const sel =
    versions.find((x) => x.version === v) ?? versions.find((x) => x.active) ?? (versions.at(-1) as SkillRow);
  const parent = sel.parentVersion ? versions.find((x) => x.version === sel.parentVersion) : undefined;
  const now = exportPlaywright(sel.skill).split("\n");
  const diff = parent ? lineDiff(exportPlaywright(parent.skill).split("\n"), now) : null;
  const modelSteps = new Set(
    (sel.sourceRunId ? d.steps(sel.sourceRunId) : [])
      .filter((s) => s.rung === "open_weights" || s.rung === "computer_use" || s.rung === "ask_rep")
      .map((s) => s.stepId),
  );
  const shown = diff
    ? focus
      ? focusOps(diff, modelSteps)
      : diff
    : now.map((line) => ({ t: "same" as const, line }));
  const ops: Op[] = shown.map((o) => ({ t: o.t, html: o.t === "gap" ? esc(o.line) : lineHtml(o.line) }));
  const added = diff?.filter((o) => o.t === "add").length ?? 0;
  const removed = diff?.filter((o) => o.t === "del").length ?? 0;
  const params = sel.skill.params.length;
  const fixedBy = modelSteps.size
    ? `${modelSteps.size} step${modelSteps.size === 1 ? "" : "s"} fixed by a model or the rep`
    : "";
  const body = html`<style>${raw(REVEAL_CSS)}</style>
  <div class="reveal">
    <div class="rbar"><span class="tab">${name}.v${sel.version}.ts</span>
      ${chip(parent ? `v${parent.version} → v${sel.version}` : "compiled from one computer-use run", COLORS.muted)}
      ${parent && !focus ? chip(`+${added} −${removed} lines`, COLORS.muted) : ""}
      <span class="sp"><button id="again">Replay</button><button id="all">Show all</button><a class="muted" href="${base}skills/${name}?v=${sel.version}">skill view</a></span></div>
    <div class="editor" id="ed"></div>
    <div class="rfoot">${
      parent
        ? html`<span>${fixedBy || `+${added} −${removed} lines`}</span><span>Highlighted: the patch · struck through: what it replaced</span>`
        : html`<span><b>${sel.skill.steps.length}</b> steps</span><span><b>${params}</b> typed params, like <span class="pp">p.name</span></span><span>No model calls when this runs</span>`
    }</div>
  </div>
  <script>
  (() => {
    const ops = ${raw(JSON.stringify(ops).replace(/</g, "\\u003c"))};
    const diff = ${parent ? "true" : "false"};
    const bodyAt = ops.findIndex((o) => o.html.replace(/<[^>]+>/g, "").includes("export async function"));
    const speed = Number(new URLSearchParams(location.search).get("speed") || "1");
    const ed = document.getElementById("ed");
    let timer = null;
    function lineEl(op, no) {
      const row = document.createElement("div");
      row.className = "ln " + op.t;
      if (op.t === "gap") { row.innerHTML = op.html; return row; }
      row.innerHTML = '<span class="no"></span><span class="mk"></span><span class="tx"></span>';
      row.children[0].textContent = op.t === "del" ? "" : String(no);
      row.children[1].textContent = op.t === "add" ? "+" : op.t === "del" ? "−" : "";
      return row;
    }
    function run(instant) {
      clearTimeout(timer); ed.innerHTML = "";
      let i = 0, no = 0;
      const step = () => {
        if (i >= ops.length) return;
        const op = ops[i++];
        if (op.t !== "del" && op.t !== "gap") no++;
        const row = lineEl(op, no);
        ed.appendChild(row);
        if (op.t === "gap") return instant ? step() : (timer = setTimeout(step, 120 / speed));
        const tx = row.children[2];
        const tmp = document.createElement("span"); tmp.innerHTML = op.html;
        const text = tmp.textContent;
        // the steps are typed out (in a diff: only the patch); headers, types and helpers stream in fast
        const slow = diff ? op.t === "add" : bodyAt >= 0 && i - 1 > bodyAt;
        if (instant || !text.trim()) { tx.innerHTML = op.html; return instant ? step() : (timer = setTimeout(step, 4 / speed)); }
        row.classList.add("typing");
        let k = 0;
        const per = (slow ? 14 : 1) / speed, total = Math.min(text.length, slow ? 18 : 2);
        const tick = () => {
          k = Math.min(text.length, k + Math.max(1, Math.ceil(text.length / total)));
          tx.textContent = text.slice(0, k);
          if (k < text.length) { timer = setTimeout(tick, per); return; }
          tx.innerHTML = op.html; row.classList.remove("typing");
          row.scrollIntoView({ block: "nearest" });
          timer = setTimeout(step, (slow ? 70 : 3) / speed);
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
  const out = page({ title: `${name} v${sel.version} · code`, nav: "skills", body, base, focus });
  return focus && parent ? out.replace('<body class="focus">', '<body class="focus diff">') : out;
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

/** The ledger row of the pick's model call, when there is one. */
export interface PickCall {
  provider: string;
  latencyMs: number;
  costUsd: number;
}

function describe(e: Record<string, string | number>): Html {
  const name = String(e.name ?? e.label ?? e.placeholder ?? e.text ?? "");
  const extra = ["label", "placeholder", "section", "testId"]
    .filter((k) => e[k] !== undefined && e[k] !== name)
    .map((k) => `${k}: ${e[k]}`);
  return html`<b>${name || "(unnamed)"}</b>${extra.length ? html` <span class="muted">· ${extra.join(" · ")}</span>` : ""}`;
}

const nameOfEl = (e: Record<string, string | number>) =>
  String(e.name ?? e.label ?? e.placeholder ?? e.text ?? "(unnamed)");

const PICK_CSS = `
.plist{list-style:none;margin:0;padding:6px 0;font:14px/1.4 var(--mono)}
.plist li{display:grid;grid-template-columns:48px 96px minmax(0,1fr);gap:10px;align-items:baseline;padding:8px 16px;border-left:3px solid transparent}
.plist li .ix{color:var(--faint);text-align:right}
.plist li .rl{color:var(--muted)}
.plist li b{font-weight:500;color:var(--ink)}
.plist li.picked{background:#FFF1EA;border-left-color:var(--accent)}
.plist li.picked .ix{color:var(--ink);font-weight:600}
.plist li.picked.rejected{background:var(--paper);border-left-color:var(--error)}
.ask{font:14px/1.55 var(--mono);color:var(--text-2)}
.ask .k{color:var(--muted)}
.checks{list-style:none;margin:0;padding:8px 0}
.checks li{display:grid;grid-template-columns:26px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:14.5px}
.checks .ic{width:20px;height:20px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:700;color:#fff}
.checks .ic.ok{background:var(--ink)}.checks .ic.bad{background:var(--error)}
.verdict{margin:6px 16px 16px;padding:12px 14px;border-radius:10px;font-size:15px;font-weight:500;border:1px solid var(--line);background:var(--paper)}
.verdict.bad{color:var(--error)}
body.focus{background:var(--paper)}
.stage{position:fixed;inset:0;padding:44px 84px 40px;display:flex;flex-direction:column;gap:22px}
.fk{font-size:22px;color:var(--muted)}
.fh{font-size:42px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
.fcols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;min-height:0;flex:1}
.fcol{display:flex;flex-direction:column;gap:12px;min-height:0}
.flist{list-style:none;margin:0;padding:0;border-top:1px solid var(--line)}
.flist li{display:grid;grid-template-columns:62px minmax(0,1fr) auto;gap:12px;align-items:baseline;padding:9px 12px 9px 14px;border-bottom:1px solid var(--line);border-left:3px solid transparent;font-size:27px;line-height:1.25}
.flist li .ix{font:400 22px var(--mono);color:var(--faint)}
.flist li .nm{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.flist li .tg{font-size:20px;color:var(--muted)}
.flist li.picked{background:var(--surface);border-left-color:var(--accent)}
.flist li.picked .ix{color:var(--ink)}
.flist li.picked .tg{color:var(--ink);font-weight:600}
.flist li.more{font-size:20px;color:var(--muted);border-left:0}
.freason{font-size:28px;line-height:1.32;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}
.fmeta{display:flex;gap:34px;font-size:30px;font-weight:600;letter-spacing:-.01em}
.fmeta span small{display:block;font-size:20px;font-weight:400;color:var(--muted);letter-spacing:0}
.fchecks{list-style:none;margin:0;padding:0;font-size:22px;display:flex;flex-direction:column;gap:6px}
.fchecks li{display:flex;gap:10px;align-items:center}
.fchecks .ic{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:13px;color:#fff;background:var(--ink);flex:none}
.fchecks .ic.bad{background:var(--error)}
.fnote{font-size:18px;color:var(--muted)}
`;

/** At most `n` list rows, kept around the pick; the rest counted. */
function around<T extends { index: number }>(
  list: T[],
  picked: number | null,
  n: number,
): { rows: T[]; more: number } {
  if (list.length <= n) return { rows: list, more: 0 };
  const at = Math.max(
    0,
    list.findIndex((e) => e.index === picked),
  );
  const start = Math.max(0, Math.min(list.length - n, at - Math.floor(n / 2)));
  return { rows: list.slice(start, start + n), more: list.length - n };
}

/** A model's reason without parentheticals (the HUD's spotlight shows the same text). */
const plainReason = (s: string) =>
  s
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** GET /recorder/picks/:artifactId : the text list sent to Muse Spark Open, its pick, the harness checks. */
export function pickView(base: string, doc: PickDoc, call?: PickCall, focus = false): string {
  const picked = doc.pick.index;
  const lat = call ? latency(call.latencyMs, call.provider) : ms(doc.ms);
  const cost = usd(call?.costUsd ?? doc.costUsd);
  if (focus) {
    const { rows, more } = around(doc.list, picked, 7);
    const chosen =
      doc.chosen ?? (picked === null ? null : nameOfEl(doc.list.find((e) => e.index === picked) ?? {}));
    const body = html`<style>${raw(PICK_CSS)}</style>
    <div class="fk">Step ${doc.stepIdx + 1} · ‘${nameOfEl(doc.before)}’ is no longer on the page · heal rung 2, text only</div>
    <h1 class="fh">${doc.ok ? html`Muse Spark Open picked ‘${chosen ?? "the element"}’` : html`Muse Spark Open’s pick was rejected`}</h1>
    <div class="fcols">
      <div class="fcol"><div class="fk">The list it got: ${doc.list.length} ${doc.kind} elements of ${doc.listedOf} on the page</div>
        <ol class="flist">${rows.map(
          (e) =>
            html`<li class="${e.index === picked ? `picked${doc.ok ? "" : " rejected"}` : ""}"><span class="ix">#${e.index}</span><span class="nm">${nameOfEl(e)}</span><span class="tg">${e.index === picked ? "its pick" : String(e.role ?? "")}</span></li>`,
        )}${more ? html`<li class="more"><span></span><span>+${more} more of the same kind</span><span></span></li>` : ""}</ol></div>
      <div class="fcol"><div class="fk">Its reason</div>
        <div class="freason">${plainReason(doc.pick.reason)}</div>
        <div class="fmeta"><span>${lat}<small>latency, from the ledger</small></span><span>${cost}<small>cost, list price</small></span></div>
        <ul class="fchecks">${doc.checks.map((c) => html`<li><span class="ic ${c.ok ? "" : "bad"}">${c.ok ? "✓" : "✕"}</span><span>${c.check}</span></li>`)}</ul>
        ${call?.provider === "cassette" ? html`<div class="fnote">Rehearsal: the recorded live answer, replayed</div>` : ""}
      </div>
    </div>`;
    return page({ title: "Open-weights pick", nav: "runs", body, base, focus: true });
  }
  const body = html`<style>${raw(PICK_CSS)}</style>
  <div class="crumbs"><a href="${base.slice(0, -1)}">Runs</a> / <a href="${base}runs/${doc.runId}" class="mono">${doc.runId}</a> / open-weights pick</div>
  <div class="head"><div><h1 class="title">Muse Spark Open picks the element
    ${doc.ok ? chip("accepted", COLORS.ok, { lg: true }) : chip("rejected", COLORS.bad, { lg: true })}</h1>
    <p class="sub">Heal, rung 2 · step ${doc.stepIdx + 1}: ${doc.intent} · text only, no screenshot · ${doc.model}</p></div></div>
  <div class="stats">
    <div class="stat"><div class="k">Latency</div><div class="v">${lat}</div><div class="n">${call ? "from the ledger" : "measured by the repairer"}</div></div>
    <div class="stat"><div class="k">Cost</div><div class="v">${cost}</div><div class="n">Standard list price</div></div>
    <div class="stat"><div class="k">Sent</div><div class="v">${doc.list.length}<small>of ${doc.listedOf}</small></div><div class="n">elements of kind "${doc.kind}"</div></div>
    <div class="stat"><div class="k">Picked</div><div class="v">${picked === null ? "none" : `#${picked}`}</div><div class="n">confidence ${doc.pick.confidence}</div></div>
  </div>
  <div class="grid"><section class="panel"><h2>The pruned accessibility list it was given <span>${doc.list.length} elements, same kind as before</span></h2>
    <ol class="plist">${doc.list.map(
      (e) =>
        html`<li class="${e.index === picked ? `picked${doc.ok ? "" : " rejected"}` : ""}"><span class="ix">#${e.index}</span><span class="rl">${String(e.role ?? "")}</span><span>${describe(e)}${e.index === picked ? html` <span style="font-family:var(--sans);font-weight:600">its pick</span>` : ""}</span></li>`,
    )}</ol></section>
  <aside class="side">
    <section class="panel"><h2>What it was asked</h2><div class="pb ask">
      <div><span class="k">Step:</span> ${doc.intent}</div>
      ${doc.prevIntent ? html`<div><span class="k">Previous step:</span> ${doc.prevIntent}</div>` : ""}
      ${doc.nextIntent ? html`<div><span class="k">Next step:</span> ${doc.nextIntent}</div>` : ""}
      <div style="margin-top:8px"><span class="k">Element before the change:</span></div><div>${describe(doc.before)}</div>
    </div></section>
    <section class="panel"><h2>Its answer</h2><div class="pb"><div class="mono" style="font-size:14px">{ "index": ${picked === null ? "null" : picked}, "confidence": ${doc.pick.confidence} }</div><p style="margin-top:8px;color:var(--text-2)">${doc.pick.reason}</p></div></section>
    <section class="panel"><h2>Harness verification <span>the model proposes, code decides</span></h2>
      <ul class="checks">${doc.checks.map((c) => html`<li><span class="ic ${c.ok ? "ok" : "bad"}">${c.ok ? "✓" : "✕"}</span><span>${c.check}</span></li>`)}</ul>
      <div class="verdict ${doc.ok ? "ok" : "bad"}">${doc.ok ? `Accepted: the step now uses '${doc.chosen ?? "the pick"}'. The replay continues and every field is read back before submit.` : `Rejected: ${doc.reason ?? "a check failed"}. The ladder moves to the next rung.`}</div>
    </section>
    ${call?.provider === "cassette" ? html`<p class="muted" style="font-size:13px">Rehearsal: the recorded live answer, replayed from a cassette.</p>` : ""}
  </aside></div>`;
  return page({ title: "Open-weights pick", nav: "runs", body, base });
}

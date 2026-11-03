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

// Filmed at device scale 2 in a 1280x720 window: 27 px here is 40 px in a 1080p frame. Code is monochrome, so the
// one color on screen is the patch.
const REVEAL_CSS = `
body{overflow:hidden}
.reveal{position:fixed;inset:64px 0 0 0;display:grid;grid-template-rows:auto minmax(0,1fr) auto;background:var(--ground)}
body.focus .reveal{inset:0}
.rbar{display:flex;align-items:baseline;gap:20px;padding:16px 40px;border-bottom:1px solid var(--hair)}
body.focus .rbar{padding:48px 84px 16px;border-bottom:0}
.tab{font:400 16px var(--mono);letter-spacing:-.01em;color:var(--text)}
body.focus .tab{font-size:27px;letter-spacing:-.02em}
body.focus .rbar .chip{font-size:27px;color:var(--gray)}
.rbar .sp{margin-left:auto;display:flex;gap:16px;align-items:baseline}
body.focus .rbar .sp{display:none}
.rbar button{all:unset;cursor:pointer;font-size:15px;color:var(--gray)}
.rbar button:hover{color:var(--text)}
.editor{overflow:auto;padding:14px 0 40vh;font:400 16px/1.6 var(--mono);color:var(--text);tab-size:2}
body.focus .editor{padding:6px 84px 30vh;font-size:27px;line-height:38px;letter-spacing:-.03em}
.ln{display:grid;grid-template-columns:64px 26px minmax(0,1fr);white-space:pre-wrap;min-height:1.6em}
body.focus .ln{grid-template-columns:56px 28px minmax(0,1fr);min-height:38px}
.ln .no{color:var(--faint);text-align:right;padding-right:14px;user-select:none}
.ln .mk{user-select:none}
.ln .tx{overflow-wrap:anywhere}
.ln.add{background:var(--accent);color:var(--on-accent)}
.ln.add .no{color:var(--on-accent)}
.ln.add .tx span{color:inherit!important}
.ln.add .pp{border-color:var(--on-accent);background:none}
.ln.del{color:var(--gray)}
.ln.del .no{color:var(--faint)}
.ln.del .tx{color:var(--gray);text-decoration:line-through;text-decoration-color:var(--faint)}
.ln.del .tx span{color:inherit!important}
body .ln.gap{color:var(--gray);font-family:var(--sans);padding:6px 0 6px 84px;display:block;min-height:0}
body .ln.gap:empty{height:1px;padding:0;margin:18px 0;background:var(--hair)}
.ln.typing .tx::after{content:"";display:inline-block;width:.5em;height:1.1em;margin-left:1px;vertical-align:-.18em;background:currentColor;animation:blink 1s steps(1) infinite}
@keyframes blink{50%{opacity:0}}
.pp{padding:0 4px;background:var(--surface);color:var(--text)}
.rfoot{display:flex;flex-wrap:wrap;gap:0 32px;align-items:baseline;padding:12px 40px;border-top:1px solid var(--hair);font-size:15px;color:var(--gray)}
body.focus .rfoot{padding:12px 84px 40px;font-size:27px;border-top:0;background:var(--ground)}
.rfoot b{color:var(--text);font-weight:600}
.rfoot>span{white-space:nowrap}
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
  // Filmed at 27 px a line holds 66 characters: half the indent keeps a patched selector on one line.
  const fit = (l: string) => (focus ? l.replace(/^ +/, (m) => " ".repeat(m.length / 2)) : l);
  // A focused diff opens on its first change, not on a rule for the lines before it.
  const lines = shown[0]?.t === "gap" && !shown[0].line ? shown.slice(1) : shown;
  const ops: Op[] = lines.map((o) => ({ t: o.t, html: o.t === "gap" ? esc(o.line) : lineHtml(fit(o.line)) }));
  const added = diff?.filter((o) => o.t === "add").length ?? 0;
  const removed = diff?.filter((o) => o.t === "del").length ?? 0;
  const params = sel.skill.params.length;
  const fixedBy = modelSteps.size
    ? `${modelSteps.size} step${modelSteps.size === 1 ? "" : "s"} fixed by a model or the rep`
    : "";
  const body = html`<style>${raw(REVEAL_CSS)}</style>
  <div class="reveal">
    <div class="rbar"><span class="tab">${name}.v${sel.version}.ts</span>
      ${chip(parent ? `v${parent.version} to v${sel.version}` : "compiled from one computer-use run", COLORS.muted)}
      ${parent && !focus ? chip(`+${added} −${removed} lines`, COLORS.muted) : ""}
      <span class="sp"><button id="again">Replay</button><button id="all">Show all</button><a class="muted" href="${base}skills/${name}?v=${sel.version}">skill view</a></span></div>
    <div class="editor" id="ed"></div>
    <div class="rfoot">${
      parent
        ? html`<span>${fixedBy || `+${added} −${removed} lines`}</span><span>Highlighted: the patch · struck through: what it replaced</span>`
        : html`<span><b>${sel.skill.steps.length}</b> steps</span><span><b>${params}</b> values, like <span class="pp">p.name</span></span><span>No model calls when this runs</span>`
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

// The focus half is filmed at device scale 2 in a 1280x720 window: 27 px here is 40 px in a 1080p frame.
const PICK_CSS = `
.plist{list-style:none;margin:0;padding:0;font:400 14px/1.4 var(--mono)}
.plist li{display:grid;grid-template-columns:48px 96px minmax(0,1fr);gap:12px;align-items:baseline;padding:8px 12px;border-top:1px solid var(--hair)}
.plist li .ix{color:var(--gray);text-align:right}
.plist li .rl{color:var(--gray)}
.plist li b{font-weight:400;color:var(--text)}
.plist li .muted{color:inherit}
.plist li.picked{background:var(--accent);color:var(--on-accent)}
.plist li.picked .ix,.plist li.picked .rl,.plist li.picked b{color:var(--on-accent)}
.plist li.picked.rejected{background:none;color:var(--error)}
.plist li.picked.rejected .ix,.plist li.picked.rejected .rl,.plist li.picked.rejected b{color:var(--error)}
.ask{font:400 14px/1.55 var(--mono);color:var(--text)}
.ask .k{color:var(--gray)}
.checks{list-style:none;margin:0;padding:0 0 8px}
.checks li{display:grid;grid-template-columns:72px minmax(0,1fr);gap:8px;padding:7px 0;border-top:1px solid var(--hair);font-size:15px}
.checks .ic{font-weight:600;color:var(--text)}
.checks .ic.ok{color:var(--text)}.checks .ic.bad{color:var(--error)}
.verdict{margin:8px 0 16px;font-size:16px;font-weight:600}
.verdict.bad{color:var(--error)}
.stage{position:fixed;inset:0;padding:48px 84px 40px;display:flex;flex-direction:column}
.fk{font-size:27px;line-height:1.2;color:var(--gray)}
.fh{margin:6px 0 24px;font-size:52px;font-weight:600;letter-spacing:-.035em;line-height:1.08}
.fcols{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;min-height:0}
.fcol{display:flex;flex-direction:column;gap:8px;min-height:0}
.flist{list-style:none;margin:0;padding:0}
.flist li{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:4px 12px 5px;border-top:1px solid var(--hair);font-size:27px;line-height:1.2}
.flist li .ix,.flist li .tg{color:var(--gray)}
.flist li .nm{overflow-wrap:anywhere}
.flist li.picked{background:var(--accent);color:var(--on-accent);font-weight:600;border-top-color:var(--accent)}
.flist li.picked .ix,.flist li.picked .tg{color:var(--on-accent)}
.flist li.picked.rejected{background:none;color:var(--error);border-top-color:var(--hair)}
.flist li.picked.rejected .ix,.flist li.picked.rejected .tg{color:var(--error)}
.flist li.more{color:var(--gray)}
.freason{font-size:27px;line-height:1.26}
.fmeta{margin-top:8px;font-size:27px;line-height:1.26;color:var(--gray)}
.fmeta b{color:var(--text);font-weight:600;margin-right:10px}
.fchecks{list-style:none;margin:16px 0 0;padding:12px 0 0;border-top:1px solid var(--hair);font-size:27px;line-height:1.2;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:4px 40px}
.fchecks li{display:flex;gap:12px}
.fchecks .ic{font-weight:600;flex:none}
.fchecks .ic.bad{color:var(--error)}
.fnote{font-size:20px;color:var(--gray)}
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
    const { rows, more } = around(doc.list, picked, doc.list.length > 7 ? 6 : 7);
    const chosen =
      doc.chosen ?? (picked === null ? null : nameOfEl(doc.list.find((e) => e.index === picked) ?? {}));
    const body = html`<style>${raw(PICK_CSS)}</style>
    <div class="fk">Step ${doc.stepIdx + 1}: ‘${nameOfEl(doc.before)}’ is no longer on the page. Heal rung 2, text only.</div>
    <h1 class="fh">${doc.ok ? html`Muse Spark Open picked ‘${chosen ?? "the element"}’` : html`Muse Spark Open’s pick was rejected`}</h1>
    <div class="fcols">
      <div class="fcol"><div class="fk">The list it got: ${doc.list.length} ${doc.kind} elements of ${doc.listedOf}</div>
        <ol class="flist">${rows.map(
          (e) =>
            html`<li class="${e.index === picked ? `picked${doc.ok ? "" : " rejected"}` : ""}"><span class="ix">#${e.index}</span><span class="nm">${nameOfEl(e)}</span><span class="tg">${e.index === picked ? "its pick" : String(e.role ?? "")}</span></li>`,
        )}${more ? html`<li class="more"><span></span><span>+${more} more of the same kind</span><span></span></li>` : ""}</ol></div>
      <div class="fcol"><div class="fk">Its reason</div>
        <div class="freason">${plainReason(doc.pick.reason)}</div>
        <div class="fmeta"><div><b>${lat}</b>latency, from the ledger</div><div><b>${cost}</b>cost, list price</div></div>
        ${call?.provider === "cassette" ? html`<div class="fnote">Rehearsal: the recorded live answer, replayed</div>` : ""}
      </div>
    </div>
    <ul class="fchecks">${doc.checks.map((c) => html`<li><span class="ic ${c.ok ? "" : "bad"}">${c.ok ? "Passed" : "Failed"}</span><span>${c.check}</span></li>`)}</ul>`;
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
    <section class="panel"><h2>Its answer</h2><div class="pb"><div class="mono" style="font-size:14px">{ "index": ${picked === null ? "null" : picked}, "confidence": ${doc.pick.confidence} }</div><p style="margin-top:8px;color:var(--gray)">${doc.pick.reason}</p></div></section>
    <section class="panel"><h2>Harness verification <span>the model proposes, code decides</span></h2>
      <ul class="checks">${doc.checks.map((c) => html`<li><span class="ic ${c.ok ? "ok" : "bad"}">${c.ok ? "Passed" : "Failed"}</span><span>${c.check}</span></li>`)}</ul>
      <div class="verdict ${doc.ok ? "ok" : "bad"}">${doc.ok ? `Accepted: the step now uses '${doc.chosen ?? "the pick"}'. The replay continues and every field is read back before submit.` : `Rejected: ${doc.reason ?? "a check failed"}. The ladder moves to the next rung.`}</div>
    </section>
    ${call?.provider === "cassette" ? html`<p class="muted" style="font-size:13px">Rehearsal: the recorded live answer, replayed from a cassette.</p>` : ""}
  </aside></div>`;
  return page({ title: "Open-weights pick", nav: "runs", body, base });
}

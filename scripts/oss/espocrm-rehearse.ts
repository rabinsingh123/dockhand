// One-command rehearsal of the EspoCRM demo segment, through the real dev process and the WhatsApp emulator:
// start EspoCRM if needed, seed the compiled lead skill (fixtures/oss), apply the admin-tool drifts, send the
// lead request as the rep, tap Approve on the plan, answer the new required field, tap Approve on the submit
// card, then check the stored Lead through EspoCRM's REST API, field by field, and revert the drifts.
//
//   pnpm exec tsx scripts/oss/espocrm-rehearse.ts                 META_MODE=fake: stand-ins, $0, no keys
//   pnpm exec tsx scripts/oss/espocrm-rehearse.ts --live          real models (lead understanding, rung 2)
//   pnpm exec tsx scripts/oss/espocrm-rehearse.ts --live --first-run --drift none
//                                                    no seeded skill: computer use does the first run and compiles v1
//          [--max-usd 0.5] [--drift label,layout,required | --drift none] [--headed] [--keep-drift]
//
// Ports: gateway 8817 (emulator at /dev/chat), mock portals 5121/5122. Var dir: var/agent-oss/rehearse.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs, promisify } from "node:util";
import { openDb, type Skill, systemClock, workspaceRoot } from "../../packages/core/src/index.ts";
import { type LeadUnderstanding, leadParams } from "../../packages/orchestrator/src/espocrm.ts";
import { createSkillStore } from "../../packages/skills/src/index.ts";
import type { ChatEntry } from "../../packages/whatsapp/src/index.ts";
import { ESPO_URL, espoApi, espoUp, gradeLead, leadsSince } from "./espocrm.ts";
import { DRIFTS, type DriftName, REQUIRED_DRIFT_ATTR } from "./espocrm-drift.ts";

const { values } = parseArgs({
  options: {
    live: { type: "boolean", default: false },
    "max-usd": { type: "string", default: "0.5" },
    drift: { type: "string", default: "label,layout,required" },
    headed: { type: "boolean", default: false },
    "keep-drift": { type: "boolean", default: false },
    "first-run": { type: "boolean", default: false },
    port: { type: "string", default: "8817" },
  },
});
const root = workspaceRoot();
const varDir = join(root, "var", "agent-oss", "rehearse");
const base = `http://127.0.0.1:${values.port}`;
const REP = "5511999990077";
const MAX_USD = Number(values["max-usd"]);
const fixture = JSON.parse(
  readFileSync(join(root, "fixtures", "oss", "espocrm-lead-request.json"), "utf8"),
) as {
  text: string;
  lead: LeadUnderstanding;
  taxIdAnswer: string;
};
const drifts = (
  values.drift === "none" ? [] : (values.drift ?? "").split(",").filter(Boolean)
) as DriftName[];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const log = (line: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${line}`);

async function ensureEspo(): Promise<void> {
  if (await espoUp()) return;
  log("starting EspoCRM (apps/oss/espocrm/start.ps1)");
  await promisify(execFile)("powershell", [
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(root, "apps", "oss", "espocrm", "start.ps1"),
  ]);
  if (!(await espoUp())) throw new Error(`EspoCRM did not come up at ${ESPO_URL}`);
}

/** A fresh var dir, with the compiled lead skill active (what a first run would have left behind) unless --first-run. */
function seedSkill(): Skill | null {
  for (const name of ["dockhand.sqlite", "dockhand.sqlite-wal", "dockhand.sqlite-shm"])
    rmSync(join(varDir, name), { force: true });
  for (const dir of ["artifacts", "browser-state", "tmp"])
    rmSync(join(varDir, dir), { recursive: true, force: true });
  mkdirSync(varDir, { recursive: true });
  if (values["first-run"]) return null;
  const { skill } = JSON.parse(
    readFileSync(join(root, "fixtures", "oss", "espocrm-create-lead.skill-v1.json"), "utf8"),
  ) as { skill: Skill };
  const db = openDb(join(varDir, "dockhand.sqlite"));
  try {
    const { version: _v, parentVersion: _p, ...body } = skill;
    return createSkillStore(db, systemClock).saveVersion(body, null, true, "compile");
  } finally {
    db.close();
  }
}

/** EspoCRM refuses a second lead with the same name and email (its duplicate check): remove earlier ones. */
async function removeEarlierLeads(): Promise<void> {
  const q = `Lead?select=id&where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=${encodeURIComponent(fixture.lead.email ?? "")}`;
  for (const l of (await espoApi<{ list: { id: string }[] }>("GET", q)).list)
    await espoApi("DELETE", `Lead/${l.id}`);
}

function startGateway(): { child: ChildProcess; ready: Promise<void>; stop(): Promise<void> } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    META_MODE: values.live ? "live" : "fake",
    WHATSAPP_MODE: "emulator",
    WHATSAPP_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_APP_SECRET: "",
    WHATSAPP_VERIFY_TOKEN: "",
    CRM_MODE: "fake",
    HUBSPOT_TOKEN: "",
    REP_ALLOWLIST: REP,
    GATEWAY_PORT: String(values.port),
    PARTNER_PORTAL_PORT: "5121",
    SUPPLIER_PORTAL_PORT: "5122",
    DOCKHAND_VAR_DIR: varDir,
    ESPOCRM_URL: ESPO_URL,
    HEADLESS: values.headed ? "false" : "true",
    LOG_LEVEL: "info",
  };
  if (values.live) {
    delete env.MODEL_API_KEY; // the child reads the keys from .env itself
    delete env.BASETEN_API_KEY;
  } else {
    env.MODEL_API_KEY = "";
    env.BASETEN_API_KEY = "";
  }
  const out = createWriteStream(join(varDir, "gateway.log"));
  const child = spawn(
    process.execPath,
    [...process.execArgv, join(root, "apps", "gateway", "src", "main.ts")],
    {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    },
  );
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (m) => m === "ready" && resolve());
    void exited.then((code) =>
      reject(new Error(`the gateway exited (code ${code}); see ${join(varDir, "gateway.log")}`)),
    );
  });
  return {
    child,
    ready,
    async stop() {
      if (child.exitCode !== null) return;
      if (child.connected) child.send("shutdown");
      if ((await Promise.race([exited, sleep(15_000).then(() => "timeout")])) === "timeout") child.kill();
      out.end();
    },
  };
}

async function timeline(): Promise<ChatEntry[]> {
  return ((await (await fetch(`${base}/dev/chat/timeline`)).json()) as { entries: ChatEntry[] }).entries;
}
async function send(text: string): Promise<void> {
  const form = new FormData();
  form.set("from", REP);
  form.set("text", text);
  const res = await fetch(`${base}/dev/chat/send`, { method: "POST", body: form });
  if (!res.ok) throw new Error(`/dev/chat/send answered ${res.status}: ${await res.text()}`);
}
async function tap(card: ChatEntry, title: string): Promise<void> {
  const button = card.buttons?.find((b) => b.title === title);
  if (!button) throw new Error(`no "${title}" button on: ${(card.text ?? "").slice(0, 120)}`);
  const res = await fetch(`${base}/dev/chat/tap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: REP, waId: card.waId, buttonId: button.id }),
  });
  if (!res.ok) throw new Error(`/dev/chat/tap answered ${res.status}: ${await res.text()}`);
}

function ledger(): { usd: number; calls: string[] } {
  const path = join(varDir, "dockhand.sqlite");
  if (!existsSync(path)) return { usd: 0, calls: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT purpose, provider, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls GROUP BY purpose, provider",
      )
      .all() as { purpose: string; provider: string; n: number; usd: number }[];
    const real = rows.filter((r) => r.provider === "meta" || r.provider === "baseten");
    return {
      usd: real.reduce((a, r) => a + r.usd, 0),
      calls: rows.map((r) => `${r.purpose} ${r.provider} x${r.n} $${r.usd.toFixed(4)}`),
    };
  } finally {
    db.close();
  }
}

function lastRun(): { mode: string; outcome: string | null; ms: number | null; steps: string[] } | null {
  const db = new DatabaseSync(join(varDir, "dockhand.sqlite"), { readOnly: true });
  try {
    const run = db
      .prepare(
        "SELECT id, mode, outcome, ms FROM runs WHERE eval_suite IS NULL ORDER BY started_at DESC LIMIT 1",
      )
      .get() as { id: string; mode: string; outcome: string | null; ms: number | null } | undefined;
    if (!run) return null;
    const steps = db
      .prepare("SELECT step_id, status, rung FROM run_steps WHERE run_id = ? AND status != 'ok' ORDER BY idx")
      .all(run.id) as { step_id: string; status: string; rung: string | null }[];
    return { ...run, steps: steps.map((s) => `${s.step_id}:${s.status}${s.rung ? `/${s.rung}` : ""}`) };
  } finally {
    db.close();
  }
}

const short = (e: ChatEntry) =>
  `${e.type}: ${(e.text ?? e.caption ?? "").replace(/\s+/g, " ").slice(0, 110)}`;

/** Plays the rep until a receipt arrives, the run stops, or the deadline passes. */
async function converse(deadlineMs: number): Promise<{ ok: boolean; why: string }> {
  let cursor = 0;
  let receipt: string | null = null;
  let lastMessage = Date.now();
  const handled = new Set<string>();
  for (;;) {
    // After the receipt, a few quiet seconds for the skill-patch card (approved like the rep would).
    if (receipt && Date.now() - lastMessage > 4000) return { ok: true, why: receipt };
    if (Date.now() > deadlineMs) return { ok: false, why: "no receipt within the deadline" };
    const spent = ledger().usd;
    if (spent > MAX_USD) return { ok: false, why: `cost cap: $${spent.toFixed(4)} > $${MAX_USD}` };
    const fresh = (await timeline()).filter((e) => e.dir === "out" && e.seq > cursor);
    for (const e of fresh) {
      cursor = Math.max(cursor, e.seq);
      if (handled.has(e.waId)) continue;
      handled.add(e.waId);
      lastMessage = Date.now();
      log(`dockhand -> ${short(e)}`);
      const body = e.text ?? "";
      if (e.type === "interactive" && /now (asks for|requires) "Tax ID"/.test(body)) {
        log(`rep      -> ${fixture.taxIdAnswer}`);
        await send(fixture.taxIdAnswer);
      } else if (e.type === "interactive" && e.buttons?.some((b) => b.title === "Approve")) {
        log("rep      -> [Approve]");
        await tap(e, "Approve");
      } else if (e.type === "image" && /\nCost: /.test(e.caption ?? "")) {
        receipt = e.caption ?? "receipt";
      } else if (e.type === "text" && /stopped|Nothing was (submitted|sent)|went wrong/i.test(body)) {
        return { ok: false, why: body.slice(0, 200) };
      }
    }
    await sleep(300);
  }
}

let gateway: ReturnType<typeof startGateway> | undefined;
const applied: DriftName[] = [];
let exitCode = 1;
try {
  if (values["first-run"] && !values.live)
    throw new Error("--first-run needs --live: fake mode has no scripted computer use for EspoCRM");
  await ensureEspo();
  const skill = seedSkill();
  log(
    skill
      ? `seeded ${skill.name} v${skill.version} (${skill.steps.length} steps) in ${varDir}`
      : "no skill seeded: first run",
  );
  await removeEarlierLeads();
  for (const d of drifts) {
    log(`drift ${d}: ${await DRIFTS[d].apply()}`);
    applied.push(d);
  }
  gateway = startGateway();
  await gateway.ready;
  log(`gateway up at ${base} (META_MODE=${values.live ? "live" : "fake"}); emulator at ${base}/dev/chat`);
  const since = Date.now();
  log(`rep      -> ${fixture.text}`);
  await send(fixture.text);
  const end = await converse(Date.now() + 5 * 60_000);
  await sleep(1500);
  const extra: Record<string, string> = drifts.includes("required")
    ? { [REQUIRED_DRIFT_ATTR]: fixture.taxIdAnswer }
    : {};
  const leads = await leadsSince(since, Object.keys(extra));
  const g = gradeLead(leads.at(-1), leadParams(fixture.lead), extra);
  const run = lastRun();
  const cost = ledger();
  log(
    `run: ${run?.mode} ${run?.outcome} in ${((run?.ms ?? 0) / 1000).toFixed(1)} s; heals ${run?.steps.join(", ") || "none"}`,
  );
  log(
    `EspoCRM: ${leads.length} lead(s) created; fields ${g.correct}/${g.total}${g.mismatches.length ? ` (${g.mismatches.join("; ")})` : ""}`,
  );
  log(`model calls: ${cost.calls.join(", ") || "none"}; real spend $${cost.usd.toFixed(4)}`);
  const ok = end.ok && leads.length === 1 && g.mismatches.length === 0;
  log(ok ? "REHEARSAL PASSED" : `REHEARSAL FAILED: ${end.ok ? "ground truth differs" : end.why}`);
  exitCode = ok ? 0 : 1;
} catch (err) {
  log(`REHEARSAL FAILED: ${(err as Error).message}`);
} finally {
  await gateway?.stop();
  if (!values["keep-drift"])
    for (const d of applied.reverse())
      log(`revert ${d}: ${await DRIFTS[d].revert().catch((e: Error) => e.message)}`);
}
process.exit(exitCode);

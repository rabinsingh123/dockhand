// `pnpm video:overnight`: the film's opening shot, for real. At a local time tonight it changes the Caravela portal
// and runs the drift watch on a live gateway with real WhatsApp, so Rabin's locked phone shows the genuine
// "Caravela Partner Hub changed overnight … Nothing to do." notification at 3 AM.
//
//   pnpm video:overnight --at 03:00                     next 03:00 local time (DST-safe), its own gateway
//   pnpm video:overnight --at 03:00 --from-db <sqlite>  the Caravela skill from this database
//   pnpm video:overnight --rehearse --now               $0 check now: emulator WhatsApp, fake models
//      [--no-text] [--tz America/New_York] [--preflight-min 25] [--ports 8827,5141,5142]
//
// What it does:
// 1. Copies only the Caravela skill (every version up to the active one) from a session database (default: the
//    newest session's snapshot taken before its overnight take, where v3 is active) into its own var dir.
// 2. Starts a gateway with cloud WhatsApp and live models at once (so a bad key fails now, not at 3 AM) and keeps
//    the machine awake for its own lifetime (SetThreadExecutionState, released when it exits).
// 3. Pre-flight, about 25 min before the time: tries candidate UI changes on a throwaway gateway with live models
//    and the emulator (nothing reaches the phone) and keeps the first the watch repairs. Live Muse Spark Open can
//    refuse a rename the tapes accepted (live-sim-1: the relabeled Country combobox), so the change is proven
//    first; if none repairs, nothing is sent.
// 4. At the time: applies that change, runs the watch addressed to the first allow-listed rep (the watch would
//    otherwise report to whoever last ran the skill), then sends one short plain-text line: the lock screen shows
//    the newest message, and plain text always previews in full (the card is an image with buttons). Everything
//    sent is logged in var/overnight/<stamp>/hook.log.
//
// Needs: Rabin messaged the Dockhand number within the 24 hours before (WhatsApp's customer-service window: no
// template is set up), the laptop plugged in with the lid open, and a network. Outbound only: no tunnel.

import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nextLocal } from "../../apps/gateway/src/video/clock.ts";
import { loadConfig, openDb, workspaceRoot } from "../../packages/core/src/index.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string) => args.includes(name);
const root = workspaceRoot();
const rehearse = has("--rehearse");
const tz = opt("--tz") ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const [gwPort, partnerPort, supplierPort] = (opt("--ports") ?? "8827,5141,5142").split(",").map(Number) as [
  number,
  number,
  number,
];
const PREFLIGHT_PORTS: [number, number, number] = [gwPort + 10, partnerPort + 10, supplierPort + 10];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = join(root, "var", "overnight", `${stamp}${rehearse ? "-rehearse" : ""}`);
mkdirSync(dir, { recursive: true });
const logPath = join(dir, "hook.log");
const log = (line: string) => {
  const s = `${new Date().toISOString()}  ${line}`;
  process.stdout.write(`${s}\n`);
  appendFileSync(logPath, `${s}\n`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const local = (t: number) =>
  new Intl.DateTimeFormat("en-US", { timeZone: tz, dateStyle: "medium", timeStyle: "long" }).format(t);

/** Asks Windows not to sleep while this process lives (ES_CONTINUOUS | ES_SYSTEM_REQUIRED); released on exit. */
function keepAwake(): ChildProcess | null {
  if (process.platform !== "win32") return null;
  const ps = `
Add-Type -Namespace W -Name P -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'
[void][W.P]::SetThreadExecutionState([uint32]"0x80000001")
while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }
[void][W.P]::SetThreadExecutionState([uint32]"0x80000000")`;
  return spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], {
    stdio: "ignore",
    windowsHide: true,
  });
}

/** Waits on the wall clock in short steps (a single long timer is not trusted across hours). */
async function until(t: number, what: string): Promise<void> {
  let beat = Date.now();
  while (Date.now() < t) {
    await sleep(Math.min(30_000, t - Date.now()));
    if (Date.now() - beat > 30 * 60_000) {
      beat = Date.now();
      log(`waiting for ${what}: ${Math.round((t - Date.now()) / 60_000)} min to go`);
    }
  }
}

// ---------- the skill and the changes ----------

interface SkillRow {
  name: string;
  version: number;
  parent_version: number | null;
  json: string;
  active: number;
  changelog: string;
  source: string;
  created_at: number;
}

function defaultSource(): string | null {
  const rec = join(root, "var", "recordings");
  if (!existsSync(rec)) return null;
  return (
    readdirSync(rec)
      .map((s) => join(rec, s, "snapshots", "overnight.sqlite"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null
  );
}

interface Change {
  version: "v1" | "v2";
  mutation: { seed: number; operators: string[] } | null;
  what: string;
}

/**
 * Changes the active version has not seen, the demo's first. v3 was healed for v2 with "Partner tier" required, so
 * every v3 change keeps that field (removing it would be a change too).
 */
const CHANGES: Record<number, Change[]> = {
  1: [{ version: "v2", mutation: null, what: "portal switched to its v2 UI" }],
  2: [
    {
      version: "v2",
      mutation: { seed: 1, operators: ["label_synonym", "button_rename"] },
      what: "labels and submit renamed",
    },
    { version: "v2", mutation: { seed: 1, operators: ["button_rename"] }, what: "submit button renamed" },
    {
      version: "v2",
      mutation: { seed: 2, operators: ["label_synonym", "button_rename"] },
      what: "labels and submit renamed",
    },
  ],
  3: [
    {
      version: "v2",
      mutation: { seed: 1, operators: ["insert_required_field", "label_synonym", "button_rename"] },
      what: "labels and submit renamed",
    },
    {
      version: "v2",
      mutation: { seed: 1, operators: ["insert_required_field", "button_rename"] },
      what: "submit button renamed",
    },
    {
      version: "v2",
      mutation: { seed: 2, operators: ["insert_required_field", "label_synonym", "button_rename"] },
      what: "labels and submit renamed",
    },
    {
      version: "v2",
      mutation: { seed: 3, operators: ["insert_required_field", "label_synonym"] },
      what: "labels renamed",
    },
  ],
};

/** A var dir holding only the given skill rows. */
function seedVar(at: string, rows: SkillRow[]): string {
  mkdirSync(at, { recursive: true });
  const db = openDb(join(at, "dockhand.sqlite"));
  try {
    const insert = db.raw.prepare(
      "INSERT INTO skills (name, version, parent_version, json, active, changelog, source, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    );
    for (const r of rows)
      insert.run(r.name, r.version, r.parent_version, r.json, r.active, r.changelog, r.source, r.created_at);
  } finally {
    db.close();
  }
  return at;
}

// ---------- gateways ----------

interface Gateway {
  base: string;
  partner: string;
  varDir: string;
  stop(): Promise<void>;
}

async function startGateway(o: {
  varDir: string;
  ports: [number, number, number];
  whatsapp: "cloud" | "emulator";
  models: "live" | "fake";
  logName: string;
}): Promise<Gateway> {
  const emulator = o.whatsapp === "emulator";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_PORT: String(o.ports[0]),
    PARTNER_PORTAL_PORT: String(o.ports[1]),
    SUPPLIER_PORTAL_PORT: String(o.ports[2]),
    DOCKHAND_VAR_DIR: o.varDir,
    HEADLESS: "true",
    LOG_LEVEL: "info",
    DEMO_MODE: "0",
    DEMO_CAPTURE_DIR: "",
    DRIFT_WATCH_EVERY_MIN: "",
    CRM_MODE: "fake",
    HUBSPOT_TOKEN: "",
    ESPOCRM_URL: "",
    META_MODE: o.models,
    ...(o.models === "fake" ? { MODEL_API_KEY: "", BASETEN_API_KEY: "" } : {}),
    WHATSAPP_MODE: o.whatsapp,
    ...(emulator
      ? {
          WHATSAPP_TOKEN: "",
          WHATSAPP_PHONE_NUMBER_ID: "",
          WHATSAPP_APP_SECRET: "",
          WHATSAPP_VERIFY_TOKEN: "",
          REP_ALLOWLIST: "5511999990001",
        }
      : {}),
  };
  const gwLog = join(dir, o.logName);
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
  child.stdout?.on("data", (d: Buffer) => appendFileSync(gwLog, d));
  child.stderr?.on("data", (d: Buffer) => appendFileSync(gwLog, d));
  const stop = async () => {
    if (child.exitCode !== null) return;
    if (child.connected) child.send("shutdown");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(15_000)]);
    if (child.exitCode === null) child.kill();
  };
  try {
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        child.on("message", (m) => m === "ready" && resolve());
        child.once("exit", (code) => reject(new Error(`the gateway exited (code ${code}); see ${gwLog}`)));
      }),
      sleep(90_000).then(() => {
        throw new Error(`the gateway did not start within 90 s; see ${gwLog}`);
      }),
    ]);
  } catch (e) {
    await stop();
    throw e;
  }
  return {
    base: `http://127.0.0.1:${o.ports[0]}`,
    partner: `http://127.0.0.1:${o.ports[1]}`,
    varDir: o.varDir,
    stop,
  };
}

async function post(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

interface WatchOutcome {
  outcome: string;
  message?: string;
  activated?: number;
  costUsd: number;
}

/** Applies the change on the gateway's portal and runs the watch for `skill`, reporting to `rep`. */
async function changeAndWatch(
  gw: Gateway,
  change: Change,
  skill: string,
  rep?: string,
): Promise<WatchOutcome | undefined> {
  await post(`${gw.partner}/api/__admin/version`, { version: change.version });
  if (change.mutation) await post(`${gw.partner}/api/__admin/mutation`, change.mutation);
  else await fetch(`${gw.partner}/api/__admin/mutation`, { method: "DELETE" });
  const outcomes = (await post(`${gw.base}/__dev/watch`, {
    skill,
    ...(rep ? { rep } : {}),
  })) as WatchOutcome[];
  return outcomes[0];
}

// ---------- main ----------

async function main(): Promise<number> {
  const at = opt("--at") ?? "03:00";
  const now = has("--now");
  const target = now ? Date.now() : nextLocal(at, tz);
  const preflightAt = now ? Date.now() : target - Number(opt("--preflight-min") ?? "25") * 60_000;
  const source = opt("--from-db") ?? defaultSource();
  if (!source || !existsSync(source))
    throw new Error("no source database: pass --from-db <path to a session's snapshots/overnight.sqlite>");

  const src = new DatabaseSync(source, { readOnly: true });
  const all = src.prepare("SELECT * FROM skills ORDER BY name, version").all() as unknown as SkillRow[];
  src.close();
  // The Caravela skill, whatever the teach model named it (register_partner_deal, register_deal).
  const active = all.find(
    (r) => r.active === 1 && (JSON.parse(r.json) as { portalId?: string }).portalId === "caravela",
  );
  if (!active) throw new Error(`${source} has no active skill on the Caravela portal`);
  const skill = active.name;
  const rows = all.filter((r) => r.name === skill && r.version <= active.version);
  const candidates = CHANGES[active.version];
  if (!candidates?.length) throw new Error(`${skill} v${active.version}: no planned change for that version`);
  copyFileSync(source, join(dir, "source-snapshot.sqlite"));

  loadConfig(); // .env into this process's environment
  const config = loadConfig({
    ...process.env,
    ...(rehearse
      ? {
          WHATSAPP_MODE: "emulator",
          WHATSAPP_TOKEN: "",
          WHATSAPP_PHONE_NUMBER_ID: "",
          WHATSAPP_APP_SECRET: "",
          WHATSAPP_VERIFY_TOKEN: "",
          REP_ALLOWLIST: "5511999990001",
        }
      : { WHATSAPP_MODE: "cloud" }),
  });
  const rep = config.reps.allowlist[0];
  if (!rep) throw new Error("REP_ALLOWLIST is empty");
  log(`skill: ${skill} v${active.version} active (from ${source}); ${candidates.length} candidate change(s)`);
  log(`recipient: the first allow-listed rep (…${rep.slice(-4)}); WhatsApp ${config.whatsapp.mode}`);
  log(
    `pre-flight at ${local(preflightAt)}; fires at ${local(target)} (${new Date(target).toISOString()}), ${tz}`,
  );
  if (!rehearse)
    log(
      "REMINDER: Rabin must have messaged the Dockhand number within the 24 hours before, or WhatsApp refuses the send",
    );

  const graph = rehearse ? `http://127.0.0.1:${gwPort}/graph` : "https://graph.facebook.com";
  if (!rehearse) {
    const res = await fetch(
      `${graph}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}?fields=display_phone_number`,
      { headers: { authorization: `Bearer ${config.whatsapp.token}` } },
    ).catch(() => null);
    if (!res?.ok)
      throw new Error(`the WhatsApp token cannot read the sending number (HTTP ${res?.status ?? "none"})`);
    log("WhatsApp token checked");
  }

  const awake = keepAwake();
  const realOpts = {
    varDir: seedVar(join(dir, "var"), rows),
    ports: [gwPort, partnerPort, supplierPort] as [number, number, number],
    whatsapp: rehearse ? ("emulator" as const) : ("cloud" as const),
    models: rehearse ? ("fake" as const) : ("live" as const),
    logName: "gateway.log",
  };
  let real = await startGateway(realOpts);
  try {
    log(`gateway up at ${real.base}${awake ? "; keeping the machine awake" : ""}`);

    // Pre-flight: the first change the watch repairs on a throwaway gateway (live models, emulator WhatsApp).
    await until(preflightAt, "the pre-flight");
    let chosen: Change | null = null;
    for (const [i, c] of candidates.entries()) {
      const gw = await startGateway({
        varDir: seedVar(join(dir, `preflight-${i + 1}`), rows),
        ports: PREFLIGHT_PORTS,
        whatsapp: "emulator",
        models: rehearse ? "fake" : "live",
        logName: `preflight-${i + 1}.log`,
      });
      try {
        const o = await changeAndWatch(gw, c, skill);
        log(
          `pre-flight ${i + 1} (${c.what}, ${JSON.stringify(c.mutation)}): ${o?.outcome} $${(o?.costUsd ?? 0).toFixed(4)}`,
        );
        if (o?.outcome === "repaired") {
          chosen = c;
          break;
        }
      } finally {
        await gw.stop();
      }
    }
    if (!chosen) {
      log("NOT SENT: no candidate change was repaired in pre-flight, so nothing goes to the phone");
      return 1;
    }

    // A gateway armed hours ago runs the code it loaded then, and a merge since can delete a file it reads only
    // when it renders (Nov 3: the old card font, so the 3 AM card failed). Restart it on the code the pre-flight ran.
    await real.stop();
    real = await startGateway(realOpts);
    log("gateway restarted on the code on disk now");

    await until(target, "the time");
    const o = await changeAndWatch(real, chosen, skill, rep);
    log(`portal changed (${chosen.what}); watch: ${JSON.stringify(o)}`);
    const db = new DatabaseSync(join(real.varDir, "dockhand.sqlite"), { readOnly: true });
    for (const m of db
      .prepare(
        "SELECT wa_id, kind, text, created_at FROM messages WHERE direction = 'out' ORDER BY created_at",
      )
      .all() as { wa_id: string; kind: string; text: string | null; created_at: number }[])
      log(
        `sent ${m.kind} ${m.wa_id} at ${local(m.created_at)}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 220)}`,
      );
    db.close();

    if (o?.outcome === "repaired" && o.message && !has("--no-text")) {
      // The headline only; the detail is in the card's own message just above it.
      const line = `${o.message.split(". ")[0]}. Nothing to do.`;
      const res = await fetch(
        `${graph}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${config.whatsapp.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: rep,
            type: "text",
            text: { body: line },
          }),
        },
      );
      const reply = (await res.json().catch(() => null)) as {
        messages?: { id: string }[];
        error?: { message?: string };
      } | null;
      if (res.ok) log(`sent text ${reply?.messages?.[0]?.id ?? "?"} at ${local(Date.now())}: ${line}`);
      else log(`plain-text follow-up refused: HTTP ${res.status} ${reply?.error?.message ?? ""}`);
    }
    const ok = o?.outcome === "repaired";
    log(ok ? "DONE: the overnight card is on the phone" : `NOT AS PLANNED: outcome ${o?.outcome ?? "none"}`);
    return ok ? 0 : 1;
  } finally {
    await real.stop();
    awake?.kill();
    log("gateway stopped");
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);

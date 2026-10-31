// `pnpm video:overnight`: the film's opening shot, for real. At a local time tonight it changes the Caravela portal
// and runs the drift watch on a live gateway with real WhatsApp, so Rabin's locked phone shows the genuine
// "Caravela Partner Hub changed overnight … Nothing to do." notification at 3 AM.
//
//   pnpm video:overnight --at 03:00                     next 03:00 local time (DST-safe), its own gateway
//   pnpm video:overnight --at 03:00 --from-db <sqlite>  the Caravela skill from this database
//   pnpm video:overnight --rehearse --now               $0 check now: emulator WhatsApp, fake models
//      [--no-text] [--tz America/New_York] [--ports 8827,5141,5142]
//
// What it does: starts a gateway (cloud WhatsApp, live models, its own var dir under var/overnight/) whose skill
// store holds only the Caravela skill (register_partner_deal), copied from a session database (default: the newest session's snapshot
// taken before its overnight take, where v3 is active), keeps the machine awake (process-scoped), waits for the
// time, applies the UI change that version has not seen, triggers the watch addressed to the first allow-listed
// rep, then sends the watch's sentence once more as plain text: the lock screen shows the newest message, and a
// plain text always previews in full (the card is an image with buttons). Everything sent is logged.
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
const [gwPort, partnerPort, supplierPort] = (opt("--ports") ?? "8827,5141,5142").split(",").map(Number);
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

// ---------- the time ----------

const local = (t: number) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "medium",
    timeStyle: "long",
  }).format(t);

// ---------- keep awake (process-scoped) ----------

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

// ---------- the skill ----------

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

/** The newest session snapshot taken before an overnight take (register_partner_deal v3 active there). */
function defaultSource(): string | null {
  const rec = join(root, "var", "recordings");
  if (!existsSync(rec)) return null;
  const found = readdirSync(rec)
    .map((s) => join(rec, s, "snapshots", "overnight.sqlite"))
    .filter((p) => existsSync(p))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return found[0] ?? null;
}

/** The change that version has not seen yet, from the state it was compiled or healed for. */
const CHANGE: Record<number, { version: "v1" | "v2"; mutation: unknown | null; what: string }> = {
  1: { version: "v2", mutation: null, what: "portal switched to its v2 UI" },
  2: {
    version: "v2",
    mutation: { seed: 1, operators: ["label_synonym", "button_rename"] },
    what: "labels and submit button renamed",
  },
  3: {
    version: "v2",
    mutation: { seed: 1, operators: ["insert_required_field", "label_synonym", "button_rename"] },
    what: "labels and submit button renamed",
  },
};

// ---------- main ----------

async function main(): Promise<number> {
  const at = opt("--at") ?? "03:00";
  const target = has("--now") ? Date.now() : nextLocal(at, tz);
  const source = opt("--from-db") ?? defaultSource();
  if (!source || !existsSync(source))
    throw new Error("no source database: pass --from-db <path to a session's snapshots/overnight.sqlite>");

  // The skill: every version up to the active one, so the card's diff and the rollback have their parent.
  const src = new DatabaseSync(source, { readOnly: true });
  const all = src.prepare("SELECT * FROM skills ORDER BY name, version").all() as unknown as SkillRow[];
  src.close();
  // The Caravela skill, whatever the teach model named it (register_partner_deal, register_deal).
  const active = all.find(
    (r) => r.active === 1 && (JSON.parse(r.json) as { portalId?: string }).portalId === "caravela",
  );
  if (!active) throw new Error(`${source} has no active skill on the Caravela portal`);
  const skill = active.name;
  const rows = all.filter((r) => r.name === skill);
  const change = CHANGE[active.version];
  if (!change) throw new Error(`${skill} v${active.version}: no planned change for that version`);
  const varDir = join(dir, "var");
  mkdirSync(varDir, { recursive: true });
  const db = openDb(join(varDir, "dockhand.sqlite"));
  try {
    const insert = db.raw.prepare(
      "INSERT INTO skills (name, version, parent_version, json, active, changelog, source, source_run_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
    );
    for (const r of rows.filter((r) => r.version <= active.version))
      insert.run(r.name, r.version, r.parent_version, r.json, r.active, r.changelog, r.source, r.created_at);
  } finally {
    db.close();
  }
  copyFileSync(source, join(dir, "source-snapshot.sqlite"));

  // The gateway's environment, and the config it will see (the hook reads the rep and the token from it).
  loadConfig(); // loads .env into this process's environment
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GATEWAY_PORT: String(gwPort),
    PARTNER_PORTAL_PORT: String(partnerPort),
    SUPPLIER_PORTAL_PORT: String(supplierPort),
    DOCKHAND_VAR_DIR: varDir,
    HEADLESS: "true",
    LOG_LEVEL: "info",
    DEMO_MODE: "0",
    DEMO_CAPTURE_DIR: "",
    DRIFT_WATCH_EVERY_MIN: "",
    CRM_MODE: "fake",
    HUBSPOT_TOKEN: "",
    ESPOCRM_URL: "",
    ...(rehearse
      ? {
          META_MODE: "fake",
          MODEL_API_KEY: "",
          BASETEN_API_KEY: "",
          WHATSAPP_MODE: "emulator",
          WHATSAPP_TOKEN: "",
          WHATSAPP_PHONE_NUMBER_ID: "",
          WHATSAPP_APP_SECRET: "",
          WHATSAPP_VERIFY_TOKEN: "",
          REP_ALLOWLIST: "5511999990001",
        }
      : { META_MODE: "live", WHATSAPP_MODE: "cloud" }),
  };
  const config = loadConfig(env);
  const rep = config.reps.allowlist[0];
  if (!rep) throw new Error("REP_ALLOWLIST is empty");
  const base = `http://127.0.0.1:${gwPort}`;
  const partner = `http://127.0.0.1:${partnerPort}`;
  const graph = rehearse ? `${base}/graph` : "https://graph.facebook.com";
  const masked = `…${rep.slice(-4)}`;
  log(`skill: ${skill} v${active.version} active (from ${source}); change at the time: ${change.what}`);
  log(
    `recipient: the first allow-listed rep (${masked}); WhatsApp ${config.whatsapp.mode}; models ${config.meta.mode}`,
  );
  log(`fires at ${local(target)} (${new Date(target).toISOString()}), ${tz}`);
  if (!rehearse)
    log(
      "REMINDER: Rabin must have messaged the Dockhand number within the 24 hours before, or WhatsApp refuses the send",
    );

  // Fail now, not at 3 AM: the token must be able to read the sending number.
  if (!rehearse) {
    const res = await fetch(
      `${graph}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}?fields=display_phone_number`,
      { headers: { authorization: `Bearer ${config.whatsapp.token}` } },
    ).catch(() => null);
    if (!res?.ok)
      throw new Error(`the WhatsApp token cannot read the sending number (HTTP ${res?.status ?? "none"})`);
    log("WhatsApp token checked: it can send from the configured number");
  }

  const awake = keepAwake();
  const gwLog = join(dir, "gateway.log");
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
    if (child.exitCode === null && child.connected) child.send("shutdown");
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(15_000)]);
    if (child.exitCode === null) child.kill();
    awake?.kill();
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
    log(`gateway up at ${base}; waiting${awake ? " (keeping the machine awake)" : ""}`);

    // Wait on the wall clock in short steps: a timer is not trusted across hours (or a sleep that slipped by).
    let beat = Date.now();
    while (Date.now() < target) {
      await sleep(Math.min(30_000, target - Date.now()));
      if (Date.now() - beat > 30 * 60_000) {
        beat = Date.now();
        log(`waiting: ${Math.round((target - Date.now()) / 60_000)} min to go`);
      }
    }

    const post = async (url: string, body: unknown) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`POST ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
      return text ? (JSON.parse(text) as unknown) : null;
    };
    await post(`${partner}/api/__admin/version`, { version: change.version });
    if (change.mutation) await post(`${partner}/api/__admin/mutation`, change.mutation);
    log(
      `portal changed: ${change.what} (version ${change.version}, mutation ${JSON.stringify(change.mutation)})`,
    );
    const outcomes = (await post(`${base}/__dev/watch`, { rep, skill })) as {
      outcome: string;
      message?: string;
      activated?: number;
      costUsd: number;
    }[];
    log(`watch: ${JSON.stringify(outcomes)}`);
    const o = outcomes[0];

    // What reached the phone, from the gateway's own message log.
    const sent = new DatabaseSync(join(varDir, "dockhand.sqlite"), { readOnly: true });
    for (const m of sent
      .prepare(
        "SELECT wa_id, kind, text, created_at FROM messages WHERE direction = 'out' ORDER BY created_at",
      )
      .all() as { wa_id: string; kind: string; text: string | null; created_at: number }[])
      log(
        `sent ${m.kind} ${m.wa_id} at ${local(m.created_at)}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
      );
    sent.close();

    if (o?.outcome === "repaired" && o.message && !has("--no-text")) {
      const res = await fetch(
        `${graph}/${config.whatsapp.graphVersion}/${config.whatsapp.phoneNumberId}/messages`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${config.whatsapp.token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: rep,
            type: "text",
            text: { body: o.message },
          }),
        },
      );
      const reply = (await res.json().catch(() => null)) as {
        messages?: { id: string }[];
        error?: { message?: string };
      } | null;
      if (res.ok) log(`sent text ${reply?.messages?.[0]?.id ?? "?"} at ${local(Date.now())}: ${o.message}`);
      else log(`plain-text follow-up refused: HTTP ${res.status} ${reply?.error?.message ?? ""}`);
    }
    const ok = o?.outcome === "repaired";
    log(ok ? "DONE: the overnight card is on the phone" : `NOT AS PLANNED: outcome ${o?.outcome ?? "none"}`);
    return ok ? 0 : 1;
  } finally {
    await stop();
    log(`gateway stopped; log ${gwLog}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  },
);

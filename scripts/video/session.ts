// `pnpm video:session`: directs the recording session. It runs the dev process with the demo overlay on and every
// leased page filmed from inside Chromium (no screen or desktop capture), sets the stage for each take (portal
// version or UI change, pacing, EspoCRM), waits for Rabin on his phone (live) or plays him through the emulator
// (rehearsal), marks every event on the wall clock for the cut, films the recorder's close-ups with a separate
// camera browser, and snapshots the database before each take so any one take can be redone on its own.
//
//   pnpm video:session --mode cassette            rehearsal: the emulator plays Rabin, the demo tapes answer, $0
//   pnpm video:session --mode fake                rehearsal with the stand-ins (includes EspoCRM), $0
//   pnpm video:session --mode live-sim            the director against live timings: live Meta and Baseten models,
//                                                 real HubSpot, the emulator plays Rabin (no phone); spends credits
//   pnpm video:session --mode live                the real session: WhatsApp on Rabin's phone, live models
//      [--session name] [--from take] [--only teach,use] [--optional] [--cue-port 8799] [--no-camera]
//      [--no-tunnel] [--keep-drift] [--max-usd 6] [--use-photo]
//
// Output: var/recordings/<session>/ (clips/, camera/, phone/, snapshots/, var/, cutlist.json, director.log).
// The cue screen for Rabin: http://localhost:8799/ (live: press Start per take there).

import { type ChildProcess, execFile, spawn } from "node:child_process";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { type Browser, chromium } from "playwright";
import { gradeFor, type Options, Rep, STEPS, type World } from "../../apps/gateway/src/demo-check.ts";
import { encodeClip, readClipInfo, startScreencast } from "../../packages/browser/src/index.ts";
import { loadConfig, openDb, type Skill, systemClock, workspaceRoot } from "../../packages/core/src/index.ts";
import { createSkillStore } from "../../packages/skills/src/index.ts";
import { ESPO_URL, espoApi, espoUp, LEAD_SKILL } from "../oss/espocrm.ts";
import { DRIFTS } from "../oss/espocrm-drift.ts";
import { type Camera, type Filmed, openCamera } from "./camera.ts";
import { type CueState, startCue } from "./cue.ts";
import {
  activeSkills,
  type GateRow,
  latestDraft,
  latestPick,
  type Msg,
  providerCalls,
  type RunRow,
  readSince,
  realSpend,
  snapshotDb,
} from "./lib/events.ts";
import { type Mode, TAKES, type Take, type TakeCtx, type TakeId, takesFor } from "./takes.ts";

// ---------- options ----------

interface Args {
  mode: Mode;
  session: string;
  from?: TakeId;
  only?: TakeId[];
  optional: boolean;
  cuePort: number;
  camera: boolean;
  tunnel: boolean;
  keepDrift: boolean;
  /** Live: the "use" take on the referral photo instead of the voice note (if the transcript came out wrong). */
  usePhoto: boolean;
  /** Film the recorder close-ups again for takes already done (the recorder's views changed); nothing else. */
  refilm: boolean;
  /** Live models: stop the session once its spend passes this (USD, list price). */
  maxUsd: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    mode: "cassette",
    session: "",
    optional: false,
    cuePort: 8799,
    camera: true,
    tunnel: true,
    keepDrift: false,
    usePhoto: false,
    maxUsd: 6,
    refilm: false,
  };
  const ids = new Set(TAKES.map((t) => t.id));
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => {
      const x = argv[++i];
      if (x === undefined) throw new Error(`${k} needs a value`);
      return x;
    };
    if (k === "--mode") {
      const m = v();
      if (m !== "live" && m !== "live-sim" && m !== "cassette" && m !== "fake")
        throw new Error("--mode live|live-sim|cassette|fake");
      a.mode = m;
    } else if (k === "--session") a.session = v();
    else if (k === "--from") {
      const t = v() as TakeId;
      if (!ids.has(t)) throw new Error(`--from: unknown take ${t}`);
      a.from = t;
    } else if (k === "--only") {
      a.only = v().split(",") as TakeId[];
      for (const t of a.only) if (!ids.has(t)) throw new Error(`--only: unknown take ${t}`);
    } else if (k === "--optional") a.optional = true;
    else if (k === "--cue-port") a.cuePort = Number(v());
    else if (k === "--no-camera") a.camera = false;
    else if (k === "--no-tunnel") a.tunnel = false;
    else if (k === "--keep-drift") a.keepDrift = true;
    else if (k === "--use-photo") a.usePhoto = true;
    else if (k === "--max-usd") a.maxUsd = Number(v());
    else if (k === "--refilm") a.refilm = true;
    else if (k === "--help" || k === "-h") {
      process.stdout.write(readFileSync(new URL(import.meta.url), "utf8").split("\n\n")[0] ?? "");
      process.exit(0);
    } else throw new Error(`unknown option ${k}`);
  }
  a.session ||= `${new Date().toISOString().slice(0, 10)}-${a.mode}`;
  return a;
}

// ---------- the dev process ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = workspaceRoot();

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") {
    await promisify(execFile)("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => {});
  } else child.kill("SIGTERM");
}

class Gateway {
  private child: ChildProcess | null = null;
  private exited: Promise<number | null> = Promise.resolve(null);

  constructor(
    readonly env: NodeJS.ProcessEnv,
    private readonly logPath: string,
  ) {}

  async start(): Promise<void> {
    const log = createWriteStream(this.logPath, { flags: "a" });
    const child = spawn(
      process.execPath,
      [...process.execArgv, join(root, "apps", "gateway", "src", "main.ts")],
      {
        cwd: root,
        env: this.env,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    this.child = child;
    this.exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
    const ready = new Promise<void>((resolve, reject) => {
      child.on("message", (m) => m === "ready" && resolve());
      void this.exited.then((code) =>
        reject(new Error(`the dev process exited (code ${code}); see ${this.logPath}`)),
      );
    });
    await Promise.race([
      ready,
      sleep(90_000).then(() => {
        throw new Error(`the dev process did not start within 90 s; see ${this.logPath}`);
      }),
    ]);
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    if (child.connected) child.send("shutdown");
    const code = await Promise.race([this.exited, sleep(15_000).then(() => "timeout" as const)]);
    if (code === "timeout") await killTree(child);
    this.child = null;
  }
}

/** `pnpm tunnel` as a child: up once it reports the webhook registered; stays up across gateway restarts. */
async function startTunnel(env: NodeJS.ProcessEnv, logPath: string): Promise<ChildProcess> {
  const log = createWriteStream(logPath, { flags: "a" });
  const child = spawn(process.execPath, [...process.execArgv, join(root, "scripts", "tunnel.ts")], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`the tunnel did not register within 150 s; see ${logPath}`)),
      150_000,
    );
    child.stdout?.on("data", (d: Buffer) => {
      if (/Registered with app/.test(d.toString())) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the tunnel exited (code ${code}); see ${logPath}`));
    });
  });
  return child;
}

// ---------- the cut list ----------

export interface Attempt {
  id: TakeId;
  title: string;
  shot: string;
  attempt: number;
  status: "done" | "failed" | "redone" | "skipped";
  startedAt: number;
  readyAt: number | null;
  doneAt: number | null;
  endedAt: number | null;
  pacingMs: number;
  events: { msgs: Msg[]; gates: GateRow[]; runs: RunRow[] };
  camera: Filmed[];
  timings: { setupMs: number; runMs: number; cameraMs: number };
  speed: { fromAt: number; toAt: number; factor: number }[];
  error?: string;
}

export interface CutList {
  session: string;
  mode: Mode;
  createdAt: number;
  updatedAt: number;
  /** Rehearsal only: the emulator chat page, filmed as a stand-in for the phone (must be labeled simulated). */
  phoneSim: { folder: string; startedAt: number | null; endedAt: number | null } | null;
  takes: Attempt[];
}

function speedRegions(take: Take, ev: Attempt["events"]): Attempt["speed"] {
  const regions: Attempt["speed"] = [];
  for (const rule of take.speed ?? []) {
    const from =
      rule.from.kind === "run_start"
        ? ev.runs.find((r) => r.mode === (rule.from as { mode: string }).mode && r.suite === null)?.startedAt
        : ev.msgs.find((m) => m.dir === "out" && (rule.from as { text: RegExp }).text.test(m.text))?.at;
    if (from === undefined) continue;
    const to =
      rule.to.kind === "gate"
        ? ev.gates.find((g) => g.kind === (rule.to as { gateKind: string }).gateKind && g.at > from)?.at
        : ev.msgs.find(
            (m) => m.dir === "out" && m.at > from && (rule.to as { text: RegExp }).text.test(m.text),
          )?.at;
    if (to !== undefined && to - from > 3000)
      regions.push({ fromAt: from + 1000, toAt: to - 1000, factor: rule.factor });
  }
  return regions;
}

// ---------- status for the cue screen ----------

const firstLine = (s: string) => (s.split("\n")[0] ?? "").slice(0, 120);

function liveStatus(
  take: Take,
  msgs: Msg[],
  gates: GateRow[],
  now: number,
): { status: string; detail: string } {
  if (take.done(msgs, now)) return { status: "Done", detail: "" };
  const pending = gates.filter((g) => g.status === "pending").at(-1);
  if (pending) {
    const button =
      pending.kind === "skill_confirm"
        ? "Looks right"
        : pending.kind === "question"
          ? (take.answer ?? "the answer")
          : "Approve";
    return { status: `Tap ${button}`, detail: firstLine(pending.body) };
  }
  const lastIn = msgs.filter((m) => m.dir === "in").at(-1);
  const lastOut = msgs.filter((m) => m.dir === "out").at(-1);
  if (!lastIn && take.id !== "overnight") return { status: `Your turn: ${take.phone[0]}`, detail: "" };
  if (take.id === "overnight" && !msgs.some((m) => /changed overnight/.test(m.text)))
    return { status: "Running the overnight check (about a minute)…", detail: "" };
  if (lastOut && (!lastIn || lastOut.at > lastIn.at) && lastOut.kind === "interactive")
    return { status: "Your turn: next step on the list", detail: firstLine(lastOut.text) };
  return { status: "Working…", detail: lastOut ? firstLine(lastOut.text) : "" };
}

// ---------- main ----------

const REP = "5511999990001";
// demo:check's ports: the portal URL is part of what the tapes were recorded against.
const REHEARSAL_PORTS = { gateway: 8797, partner: 5111, supplier: 5112 };

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const sessionDir = join(root, "var", "recordings", a.session);
  const dirs = {
    clips: join(sessionDir, "clips"),
    camera: join(sessionDir, "camera"),
    phone: join(sessionDir, "phone"),
    snaps: join(sessionDir, "snapshots"),
    var: join(sessionDir, "var"),
    shots: join(sessionDir, "rehearsal-shots"),
  };
  const dbPath = join(dirs.var, "dockhand.sqlite");
  const cutPath = join(sessionDir, "cutlist.json");
  if (existsSync(dbPath) && !a.from && !a.refilm)
    throw new Error(
      `session ${a.session} already exists: pass --from <take> to resume it, or a new --session`,
    );
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  const logFile = createWriteStream(join(sessionDir, "director.log"), { flags: "a" });
  const t0 = Date.now();
  const log = (line: string) => {
    const s = `[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s] ${line}`;
    process.stdout.write(`${s}\n`);
    logFile.write(`${s}\n`);
    cueState.notes.push(line);
  };

  const cut: CutList = existsSync(cutPath)
    ? (JSON.parse(readFileSync(cutPath, "utf8")) as CutList)
    : {
        session: a.session,
        mode: a.mode,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        phoneSim: null,
        takes: [],
      };
  const saveCut = () => {
    cut.updatedAt = Date.now();
    writeFileSync(cutPath, `${JSON.stringify(cut, null, 2)}\n`);
  };

  // Resuming: start from the snapshot taken before that take.
  if (a.from) {
    const snap = join(dirs.snaps, `${a.from}.sqlite`);
    if (existsSync(snap)) {
      for (const f of ["dockhand.sqlite", "dockhand.sqlite-wal", "dockhand.sqlite-shm"])
        rmSync(join(dirs.var, f), { force: true });
      copyFileSync(snap, dbPath);
    }
  }

  // live: Rabin's phone on real WhatsApp. live-sim: live models and real HubSpot, the emulator plays the rep.
  const live = a.mode === "live";
  const liveModels = live || a.mode === "live-sim";
  const ports = live
    ? (() => {
        const p = loadConfig().ports;
        return { gateway: p.gateway, partner: p.partnerPortal, supplier: p.supplierPortal };
      })()
    : REHEARSAL_PORTS;
  const base = `http://127.0.0.1:${ports.gateway}`;
  const partner = `http://127.0.0.1:${ports.partner}`;
  const common: NodeJS.ProcessEnv = {
    GATEWAY_PORT: String(ports.gateway),
    PARTNER_PORTAL_PORT: String(ports.partner),
    SUPPLIER_PORTAL_PORT: String(ports.supplier),
    DOCKHAND_VAR_DIR: dirs.var,
    HEADLESS: "true",
    LOG_LEVEL: "info",
    DEMO_MODE: "1",
    DEMO_PACING_MS: "0",
    DEMO_CAPTURE_DIR: dirs.clips,
    DRIFT_WATCH_EVERY_MIN: "",
  };
  const emulator: NodeJS.ProcessEnv = {
    WHATSAPP_MODE: "emulator",
    WHATSAPP_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_APP_SECRET: "",
    WHATSAPP_VERIFY_TOKEN: "",
    REP_ALLOWLIST: REP,
  };
  const env: NodeJS.ProcessEnv = live
    ? { ...process.env, ...common, META_MODE: "live", WHATSAPP_MODE: "cloud", CRM_MODE: "hubspot" }
    : a.mode === "live-sim"
      ? // Keys and the HubSpot token come from .env (the child reads it); only WhatsApp is the emulator.
        { ...process.env, ...common, ...emulator, META_MODE: "live", CRM_MODE: "hubspot" }
      : {
          ...process.env,
          ...common,
          ...emulator,
          META_MODE: a.mode,
          MODEL_API_KEY: "",
          BASETEN_API_KEY: "",
          ...(a.mode === "cassette"
            ? { DOCKHAND_CASSETTE_DIR: join(root, "fixtures", "cassettes-demo") }
            : {}),
          HUBSPOT_TOKEN: "",
          CRM_MODE: "fake",
        };
  if (liveModels) delete env.DOCKHAND_CASSETTE_DIR;
  delete env.ESPOCRM_URL; // set only when the EspoCRM take begins (a gateway restart)

  const takes = takesFor(a.mode, a.optional, { usePhoto: a.usePhoto }).filter(
    (t) => !a.only || a.only.includes(t.id),
  );
  const startIdx = a.from
    ? Math.max(
        0,
        takes.findIndex((t) => t.id === a.from),
      )
    : 0;
  const cueState: CueState = {
    session: a.session,
    mode: a.mode,
    takes: takes.map((t) => ({
      id: t.id,
      title: t.title,
      shot: t.shot,
      optional: !!t.optional,
      state: "next",
      attempts: cut.takes.filter((x) => x.id === t.id).length,
    })),
    current: null,
    spendUsd: 0,
    notes: [],
  };

  const gw = new Gateway(env, join(sessionDir, "gateway.log"));
  let tunnel: ChildProcess | null = null;
  let repBrowser: Browser | null = null;
  let camera: Camera | null = null;
  let chatCapture: Awaited<ReturnType<typeof startScreencast>> | null = null;
  let espoDrifted = false;
  let world: World | undefined;
  let failed = false;
  const encodes: string[] = [];
  let encoding: Promise<void> = Promise.resolve();
  const queueEncodes = () => {
    encoding = encoding.then(async () => {
      for (const dir of [dirs.clips, dirs.camera, dirs.phone]) {
        for (const name of readdirSync(dir)) {
          const folder = join(dir, name);
          const info = readClipInfo(folder);
          if (!info?.endedAt || existsSync(join(folder, "clip.mkv")) || encodes.includes(folder)) continue;
          encodes.push(folder);
          await encodeClip(folder).catch((e) => log(`encode failed for ${name}: ${(e as Error).message}`));
        }
      }
    });
  };

  /** The PHP side caches metadata, layouts and translations on first use: ask for them before a run does. */
  const warmEspo = async () => {
    for (const path of ["App/user", "Metadata", "I18n", "Settings", "Lead?maxSize=1", "Lead/layout/detail"])
      await espoApi("GET", path).catch(() => null);
    await fetch(`${ESPO_URL}/`).catch(() => null);
  };
  let espoStarting: Promise<void> | null = null;
  const ensureEspo = () =>
    (espoStarting ??= (async () => {
      if (!(await espoUp())) {
        log("starting EspoCRM (apps/oss/espocrm/start.ps1)");
        await promisify(execFile)("powershell", [
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          join(root, "apps", "oss", "espocrm", "start.ps1"),
        ]);
        if (!(await espoUp())) throw new Error(`EspoCRM did not come up at ${ESPO_URL}`);
      }
      await warmEspo();
      log("EspoCRM up and warm");
    })());

  const cue = await startCue({ port: a.cuePort, state: cueState, auto: !live });
  log(`cue screen: ${cue.url}`);

  try {
    log(
      `starting the dev process (${a.mode}) on ${base}; filming leased pages into ${relative(root, dirs.clips)}`,
    );
    await gw.start();
    if (live && a.tunnel) {
      log("starting the tunnel and registering the WhatsApp webhook");
      tunnel = await startTunnel(env, join(sessionDir, "tunnel.log"));
      log("tunnel up: webhook registered");
    }
    // EspoCRM starts cold in ~40 s and its first form load is slow: bring it up now, long before its take.
    if (!a.refilm && takes.some((t) => t.id === "espocrm"))
      void ensureEspo().catch((e) => log(`EspoCRM: ${(e as Error).message}`));

    // Rehearsal: the emulator page plays Rabin, filmed as the phone's stand-in (labeled simulated in any cut).
    const repOptions: Options = {
      headed: false,
      slowMo: 0,
      // live-sim is demo:check's record mode: live models may ask twice to submit; free text is ungraded.
      mode: a.mode === "fake" ? "fake" : a.mode === "live-sim" ? "record" : "cassette",
      maxUsd: 0,
      cassettes: join(root, "fixtures", "cassettes-demo"),
      varDir: dirs.var,
      ports: { gateway: ports.gateway, partner: ports.partner, supplier: ports.supplier },
      rep: REP,
      stepTimeoutMs: a.mode === "live-sim" ? 900_000 : 300_000,
    };
    const openChat = async () => {
      repBrowser ??= await chromium.launch({ headless: true });
      const context = await repBrowser.newContext({
        viewport: { width: 420, height: 860 },
        deviceScaleFactor: 2,
      });
      const page = await context.newPage();
      await page.addInitScript((rep) => localStorage.setItem("dockhand.from", rep), REP);
      await page.goto(`${base}/dev/chat`);
      await page.locator("#from").waitFor();
      return page;
    };
    if (!live && !a.refilm) {
      gradeFor(repOptions.mode);
      const page = await openChat();
      chatCapture = await startScreencast(page, {
        dir: dirs.phone,
        label: "emulator-chat",
        maxWidth: 840,
        maxHeight: 1720,
        meta: { simulated: true },
      });
      world = {
        o: repOptions,
        rep: new Rep(page, repOptions, base, dirs.shots),
        base,
        partner,
        supplier: `http://127.0.0.1:${ports.supplier}`,
        dbPath,
        skill: "register_partner_deal",
      };
    }
    camera = a.camera ? await openCamera() : null;

    const post = async (url: string, body?: unknown) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) throw new Error(`POST ${url} answered ${res.status}`);
      return res.json().catch(() => null);
    };

    /** Starts the dev process again; the emulator's chat lived in it, so the rep gets a fresh page and cursor. */
    const startAgain = async () => {
      await gw.start();
      if (world) {
        const page = world.rep.page;
        await page.reload();
        await page.locator("#from").waitFor();
        world.rep = new Rep(page, repOptions, base, dirs.shots);
      }
    };

    const ctx: TakeCtx = {
      mode: a.mode,
      base,
      partner,
      dbPath,
      log,
      post,
      ...(world ? { world } : {}),
      async steps(...names) {
        for (const name of names) {
          const step = STEPS.find((s) => s.name === name);
          if (!step) throw new Error(`no demo:check step "${name}"`);
          await step.run(world as World);
        }
      },
      async prepareEspo() {
        await ensureEspo();
        await warmEspo();
        // EspoCRM refuses a second lead with the same name and email: remove earlier ones.
        const fx = JSON.parse(
          readFileSync(join(root, "fixtures", "oss", "espocrm-lead-request.json"), "utf8"),
        ) as {
          lead: { email?: string };
        };
        const q = `Lead?select=id&where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=${encodeURIComponent(fx.lead.email ?? "")}`;
        for (const l of (await espoApi<{ list: { id: string }[] }>("GET", q)).list)
          await espoApi("DELETE", `Lead/${l.id}`);
        for (const d of ["required", "layout", "label"] as const) await DRIFTS[d].revert().catch(() => "");
        log(`EspoCRM drift label: ${await DRIFTS.label.apply()}`);
        log(`EspoCRM drift layout: ${await DRIFTS.layout.apply()}`);
        espoDrifted = true;
        const needSkill = activeSkills(dbPath)[LEAD_SKILL] === undefined;
        if (needSkill || !gw.env.ESPOCRM_URL) {
          await gw.stop();
          if (needSkill) {
            const { skill } = JSON.parse(
              readFileSync(join(root, "fixtures", "oss", "espocrm-create-lead.skill-v1.json"), "utf8"),
            ) as { skill: Skill };
            const db = openDb(dbPath);
            try {
              const { version: _v, parentVersion: _p, ...body } = skill;
              createSkillStore(db, systemClock).saveVersion(body, null, true, "compile");
            } finally {
              db.close();
            }
            log(`seeded ${LEAD_SKILL} v1 (compiled from an earlier live first run on EspoCRM)`);
          }
          gw.env.ESPOCRM_URL = ESPO_URL;
          log("restarting the dev process with ESPOCRM_URL");
          await startAgain();
        }
      },
    };

    const runTake = async (take: Take, n: number): Promise<"done" | "failed" | "redo"> => {
      const attempt: Attempt = {
        id: take.id,
        title: take.title,
        shot: take.shot,
        attempt: n,
        status: "failed",
        startedAt: Date.now(),
        readyAt: null,
        doneAt: null,
        endedAt: null,
        pacingMs: take.pacingMs,
        events: { msgs: [], gates: [], runs: [] },
        camera: [],
        timings: { setupMs: 0, runMs: 0, cameraMs: 0 },
        speed: [],
      };
      const cur = cueState.current;
      const set = (phase: NonNullable<CueState["current"]>["phase"], status: string, detail = "") => {
        if (!cur) return;
        cur.phase = phase;
        cur.status = status;
        cur.detail = detail;
      };
      let result: "done" | "failed" | "redo" = "failed";
      try {
        snapshotDb(dbPath, join(dirs.snaps, `${take.id}.sqlite`));
        set("setting_up", `Setting the stage: ${take.director}`);
        await post(`${base}/__dev/demo`, { pacingMs: take.pacingMs }).catch(() =>
          log("pacing not set (HUD off?)"),
        );
        await take.setup(ctx);
        attempt.readyAt = Date.now();
        attempt.timings.setupMs = attempt.readyAt - attempt.startedAt;
        if (cur) cur.readyAt = attempt.readyAt;
        set("running", live ? `Your turn: ${take.phone[0]}` : "Rehearsing (the emulator plays the rep)");
        log(`take ${take.id} #${n}: ready (${take.director})`);
        const rh: { error: Error | null; done: boolean } = { error: null, done: false };
        const rehearsal = live
          ? null
          : take.rehearse(ctx).then(
              () => {
                rh.done = true;
              },
              (e: unknown) => {
                rh.error = e instanceof Error ? e : new Error(String(e));
              },
            );
        const deadline = attempt.readyAt + (liveModels ? 25 * 60_000 : 12 * 60_000);
        for (;;) {
          const now = Date.now();
          const snap = readSince(dbPath, attempt.readyAt);
          const st = liveStatus(take, snap.msgs, snap.gates, now);
          if (cur) {
            cur.status = st.status;
            cur.detail = st.detail;
            cur.lastDockhand = firstLine(snap.msgs.filter((m) => m.dir === "out").at(-1)?.text ?? "");
          }
          cueState.spendUsd = liveModels ? realSpend(dbPath, t0) : 0;
          if (liveModels && cueState.spendUsd > a.maxUsd)
            throw new Error(`model spend ${cueState.spendUsd.toFixed(2)} passed the ${a.maxUsd} USD cap`);
          if (rh.error) throw rh.error;
          if (take.done(snap.msgs, now) && (live || rh.done)) break;
          if (cue.poll() === "redo") {
            result = "redo";
            log(`take ${take.id} #${n}: redo requested`);
            return result;
          }
          if (now > deadline)
            throw new Error(
              `take ${take.id}: not done within ${Math.round((deadline - attempt.readyAt) / 60000)} min`,
            );
          await sleep(500);
        }
        await rehearsal;
        attempt.doneAt = Date.now();
        attempt.timings.runMs = attempt.doneAt - attempt.readyAt;
        set("done", "Done: holding 2 s for the cut");
        await sleep(2000);
        attempt.endedAt = Date.now();
        attempt.status = "done";
        result = "done";
        log(`take ${take.id} #${n}: done in ${(attempt.timings.runMs / 1000).toFixed(1)} s`);
        // Close-ups from the recorder (camera browser), after the take.
        if (camera && take.camera) {
          const c0 = Date.now();
          const shots = take.camera(ctx, {
            since: attempt.startedAt,
            skills: activeSkills(dbPath),
            pick: latestPick(dbPath, attempt.startedAt, Date.now()),
            draft: latestDraft(dbPath, attempt.startedAt),
          });
          for (const s of shots) {
            set("done", `Filming the close-up: ${s.label}`);
            try {
              attempt.camera.push(
                await camera.film({
                  url: `${base}${s.path}`,
                  view: s.view,
                  label: `${take.id}__${s.label}`,
                  dir: dirs.camera,
                }),
              );
            } catch (e) {
              log(`camera ${s.label} failed: ${(e as Error).message}`);
            }
          }
          attempt.timings.cameraMs = Date.now() - c0;
        }
        set("done", "Done");
      } catch (e) {
        attempt.error = (e as Error).message;
        log(`take ${take.id} #${n}: FAILED: ${attempt.error}`);
        set("failed", "Failed", attempt.error);
      } finally {
        attempt.events = readSince(dbPath, attempt.startedAt);
        attempt.speed = speedRegions(take, attempt.events);
        if (result !== "redo") {
          cut.takes.push(attempt);
          saveCut();
        }
        queueEncodes();
      }
      return result;
    };

    const restore = async (take: Take) => {
      const snap = join(dirs.snaps, `${take.id}.sqlite`);
      if (!existsSync(snap)) throw new Error(`no snapshot for ${take.id}`);
      if (cueState.current) {
        cueState.current.phase = "restarting";
        cueState.current.status = `Restoring the state before "${take.title}"…`;
      }
      await gw.stop();
      for (const f of ["dockhand.sqlite", "dockhand.sqlite-wal", "dockhand.sqlite-shm"])
        rmSync(join(dirs.var, f), { force: true });
      copyFileSync(snap, dbPath);
      for (const x of cut.takes) if (x.id === take.id && x.status === "done") x.status = "redone";
      saveCut();
      await startAgain();
      log(`restored the state before ${take.id}`);
    };

    let i = startIdx;
    if (a.refilm && camera) {
      // Close-ups only: each from its own take's window (a later take's pick is not this one's).
      for (const take of takes) {
        const at = [...cut.takes].reverse().find((x) => x.id === take.id && x.status === "done");
        if (!at || !take.camera) continue;
        const end = at.endedAt ?? Date.now();
        const shots = take.camera(ctx, {
          since: at.startedAt,
          skills: activeSkills(dbPath),
          pick: latestPick(dbPath, at.startedAt, end),
          draft: latestDraft(dbPath, at.startedAt, end),
        });
        at.camera = [];
        for (const s of shots) {
          log(`refilming ${take.id}: ${s.label}`);
          at.camera.push(
            await camera.film({
              url: `${base}${s.path}`,
              view: s.view,
              label: `${take.id}__${s.label}`,
              dir: dirs.camera,
            }),
          );
        }
      }
      saveCut();
      i = takes.length;
    }
    while (i < takes.length) {
      const take = takes[i] as Take;
      const pill = cueState.takes.find((t) => t.id === take.id);
      cueState.current = {
        id: take.id,
        title: take.title,
        shot: take.shot,
        director: take.director,
        phone: take.phone,
        approxMin: take.approxMin,
        phase: "waiting_start",
        status: live ? "Press Start when your phone is ready" : "Starting…",
        detail: take.optional ? "Optional: unrehearsed. Skip it if time is short." : "",
        readyAt: null,
        lastDockhand: "",
      };
      const action = await cue.next();
      if (action === "finish") break;
      if (action === "skip") {
        if (pill) pill.state = "skipped";
        i++;
        continue;
      }
      if (action === "redo") {
        if (i > startIdx) {
          i--;
          await restore(takes[i] as Take);
          const prev = cueState.takes.find((t) => t.id === (takes[i] as Take).id);
          if (prev) prev.state = "next";
        }
        continue;
      }
      if (pill) {
        pill.state = "active";
        pill.attempts++;
      }
      const r = await runTake(take, pill?.attempts ?? 1);
      if (r === "redo") {
        await restore(take);
        if (pill) pill.state = "next";
        continue;
      }
      if (pill) pill.state = r === "done" ? "done" : "failed";
      if (r === "failed") {
        if (!live) {
          failed = true;
          break;
        }
        // Live: stay on this take; Rabin can redo it (restores the state before it) or skip it.
        await restore(take);
        continue;
      }
      i++;
    }
  } catch (e) {
    failed = true;
    log(`session stopped: ${(e as Error).message}`);
  } finally {
    cueState.current = null;
    if (chatCapture) {
      const info = await chatCapture.stop();
      cut.phoneSim = {
        folder: relative(root, chatCapture.folder),
        startedAt: info.startedAt,
        endedAt: info.endedAt,
      };
      saveCut();
    }
    await camera?.close();
    await (repBrowser as Browser | null)?.close().catch(() => {});
    await gw.stop().catch(() => {});
    if (tunnel) await killTree(tunnel);
    if (espoDrifted && !a.keepDrift) {
      for (const d of ["layout", "label"] as const) await DRIFTS[d].revert().catch(() => "");
      log("EspoCRM drifts reverted");
    }
    queueEncodes();
    log("encoding the clips…");
    await encoding;
    await cue.close();
  }

  // Summary: per-take timings, and for a cassette rehearsal proof that nothing reached a provider.
  const rows = cut.takes.filter((x) => x.status !== "redone");
  process.stdout.write(
    `\n${"take".padEnd(11)}${"#".padEnd(3)}${"setup s".padStart(9)}${"run s".padStart(9)}${"camera s".padStart(10)}  status\n`,
  );
  for (const x of rows)
    process.stdout.write(
      `${x.id.padEnd(11)}${String(x.attempt).padEnd(3)}${(x.timings.setupMs / 1000).toFixed(1).padStart(9)}${(x.timings.runMs / 1000).toFixed(1).padStart(9)}${(x.timings.cameraMs / 1000).toFixed(1).padStart(10)}  ${x.status}${x.error ? `: ${x.error}` : ""}\n`,
    );
  if (!liveModels) {
    const misses = join(dirs.var, "cassette-misses");
    const missCount = existsSync(misses)
      ? readdirSync(misses, { recursive: true }).filter((f) => String(f).endsWith(".json")).length
      : 0;
    const leaked = providerCalls(dbPath);
    process.stdout.write(`model calls that reached a provider: ${leaked}; cassette misses: ${missCount}\n`);
    if (leaked > 0 || missCount > 0) failed = true;
  } else {
    process.stdout.write(
      `live model spend this session: $${realSpend(dbPath, t0).toFixed(3)} at list price\n`,
    );
  }
  process.stdout.write(`${failed ? "FAIL" : "PASS"}  session ${a.session}: ${relative(root, sessionDir)}\n`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(2);
  },
);

// `pnpm demo:check`: the whole demo, driven as the rep through /dev/chat in a real browser against the real dev
// process (started here on its own ports and var dir), asserting every message the rep sees, the buttons,
// numbers, costs and skill versions, and the portals' ground truth. A screenshot of every chat state lands in
// <var>/demo-check/. Exit code 0 only when every step passed.
//
//   pnpm demo:check                     headless, META_MODE=fake (free: fixtures + scripted computer use)
//   pnpm demo:check --headed            watch it (add --slow-mo 150 to follow along)
//   pnpm demo:check --mode cassette     replay recorded real-model calls instead of the stand-ins
//   pnpm demo:check --var var/demo-check --ports 8797,5111,5112
//
// It never runs live or record mode: those spend credits.

import { type ChildProcess, spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { workspaceRoot } from "@dockhand/core";
import type { ChatEntry } from "@dockhand/whatsapp";
import { type Browser, chromium, type Page } from "playwright";

// ---------- options ----------

interface Options {
  headed: boolean;
  slowMo: number;
  mode: "fake" | "cassette" | "record";
  /** Record mode only: abort once the run's model calls cost more than this (USD). */
  maxUsd: number;
  /** Where record mode writes tapes and cassette mode reads them. */
  cassettes: string;
  varDir: string;
  ports: { gateway: number; partner: number; supplier: number };
  rep: string;
  stepTimeoutMs: number;
}

function parseArgs(argv: string[]): Options {
  const root = workspaceRoot();
  const o: Options = {
    headed: false,
    slowMo: 0,
    mode: "fake",
    maxUsd: 3,
    cassettes: join(root, "fixtures", "cassettes-demo"),
    varDir: join(root, "var", "demo-check"),
    ports: { gateway: 8797, partner: 5111, supplier: 5112 },
    rep: "5511999990001",
    stepTimeoutMs: 180_000,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--headed") o.headed = true;
    else if (a === "--slow-mo") o.slowMo = Number(next());
    else if (a === "--mode") {
      const m = next();
      if (m !== "fake" && m !== "cassette")
        throw new Error(`--mode ${m}: only fake and cassette are allowed (live and record spend credits)`);
      o.mode = m;
    } else if (a === "--var") {
      const v = next();
      o.varDir = isAbsolute(v) ? v : join(root, v);
    } else if (a === "--ports") {
      const [g, p, s] = next().split(",").map(Number);
      if (!g || !p || !s) throw new Error("--ports gateway,partner,supplier");
      o.ports = { gateway: g, partner: p, supplier: s };
    } else if (a === "--record") {
      // Live calls written to tapes: costs money, so only behind this explicit flag and under --max-usd.
      o.mode = "record";
      o.stepTimeoutMs = 900_000;
    } else if (a === "--max-usd") o.maxUsd = Number(next());
    else if (a === "--cassettes") {
      const v = next();
      o.cassettes = isAbsolute(v) ? v : join(root, v);
    } else if (a === "--rep") o.rep = next();
    else if (a === "--help" || a === "-h") {
      process.stdout.write(
        "pnpm demo:check [--headed] [--slow-mo ms] [--mode fake|cassette] [--var dir] [--ports g,p,s]\n",
      );
      process.exit(0);
    } else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// ---------- results ----------

class CheckFailure extends Error {}

function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new CheckFailure(message);
}

function same(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(a === e, `${what}: expected ${e}, got ${a}`);
}

interface StepResult {
  name: string;
  ok: boolean;
  ms: number;
  error?: string;
}

// ---------- the dev process ----------

interface Dev {
  child: ChildProcess;
  logPath: string;
  stop(): Promise<void>;
}

async function startDev(o: Options): Promise<Dev> {
  const root = workspaceRoot();
  // A fresh var dir every run: the demo starts from no skills, no drafts, no jobs.
  for (const name of ["dockhand.sqlite", "dockhand.sqlite-wal", "dockhand.sqlite-shm"])
    rmSync(join(o.varDir, name), { force: true });
  for (const dir of ["artifacts", "browser-state", "tmp", "demo-check"])
    rmSync(join(o.varDir, dir), { recursive: true, force: true });
  mkdirSync(join(o.varDir, "demo-check"), { recursive: true });
  const logPath = join(o.varDir, "demo-check", "dev.log");
  const log = createWriteStream(logPath);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    META_MODE: o.mode,
    // Unset keys (empty counts as unset): only --record may call a paid API.
    MODEL_API_KEY: "",
    BASETEN_API_KEY: "",
    ...(o.mode === "fake" ? {} : { DOCKHAND_CASSETTE_DIR: o.cassettes }),
    HUBSPOT_TOKEN: "",
    WHATSAPP_MODE: "emulator",
    WHATSAPP_TOKEN: "",
    WHATSAPP_PHONE_NUMBER_ID: "",
    WHATSAPP_APP_SECRET: "",
    WHATSAPP_VERIFY_TOKEN: "",
    CRM_MODE: "fake",
    REP_ALLOWLIST: o.rep,
    GATEWAY_PORT: String(o.ports.gateway),
    PARTNER_PORTAL_PORT: String(o.ports.partner),
    SUPPLIER_PORTAL_PORT: String(o.ports.supplier),
    DOCKHAND_VAR_DIR: o.varDir,
    HEADLESS: "true",
    LOG_LEVEL: "info",
  };
  if (o.mode === "record") {
    // The child reads the keys from .env itself (a variable set to "" would block that).
    delete env.MODEL_API_KEY;
    delete env.BASETEN_API_KEY;
  }
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
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (m) => m === "ready" && resolve());
    void exited.then((code) => reject(new Error(`the dev process exited (code ${code}); see ${logPath}`)));
  });
  await withTimeout(ready, 90_000, `the dev process did not start within 90 s; see ${logPath}`);
  return {
    child,
    logPath,
    async stop() {
      if (child.exitCode !== null) return;
      if (child.connected) child.send("shutdown");
      const code = await Promise.race([exited, sleep(15_000).then(() => "timeout" as const)]);
      if (code === "timeout") child.kill();
      log.end();
    },
  };
}

// ---------- helpers ----------

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new CheckFailure(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new CheckFailure(`${init?.method ?? "GET"} ${url} answered ${res.status}`);
  return (await res.json()) as T;
}

const words = (e: ChatEntry) => [e.text, e.caption].filter(Boolean).join("\n");
const short = (e: ChatEntry) => `[${e.dir} ${e.type}] ${words(e).replace(/\n/g, " / ").slice(0, 140)}`;

interface Submission {
  id: string;
  version: string;
  tenant?: string;
  inviteCode?: string;
  fields: Record<string, unknown>;
  files?: { field: string; filename: string }[];
}

// ---------- the rep's side of the chat ----------

class Rep {
  /** Entries up to this seq were seen by an earlier wait. */
  private cursor = 0;
  private shots = 0;

  constructor(
    readonly page: Page,
    private readonly o: Options,
    private readonly base: string,
    private readonly shotsDir: string,
  ) {}

  async timeline(): Promise<ChatEntry[]> {
    return (await getJson<{ entries: ChatEntry[] }>(`${this.base}/dev/chat/timeline`)).entries;
  }

  /** Waits for the next outbound message (after the cursor) matching `pred`; moves the cursor past it. */
  async expect(what: string, pred: (e: ChatEntry) => boolean, timeoutMs?: number): Promise<ChatEntry> {
    const deadline = Date.now() + Math.max(timeoutMs ?? 0, this.o.stepTimeoutMs);
    for (;;) {
      const entries = await this.timeline();
      const fresh = entries.filter((e) => e.seq > this.cursor && e.dir === "out");
      const hit = fresh.find(pred);
      if (hit) {
        this.cursor = hit.seq;
        await this.rendered(hit);
        return hit;
      }
      if (Date.now() > deadline) {
        const seen = fresh.map(short).join("\n  ") || "(nothing new)";
        throw new CheckFailure(
          `no message ${what} within ${timeoutMs ?? this.o.stepTimeoutMs} ms. New since:\n  ${seen}`,
        );
      }
      await sleep(250);
    }
  }

  /** An interactive card whose body contains `text`, with exactly these button titles. */
  async card(text: string | RegExp, buttons: string[], timeoutMs?: number): Promise<ChatEntry> {
    const card = await this.expect(
      `card ${String(text)}`,
      (e) => e.type === "interactive" && matches(e.text ?? "", text),
      timeoutMs,
    );
    same(
      card.buttons?.map((b) => b.title),
      buttons,
      `buttons on "${(card.text ?? "").split("\n")[0]}"`,
    );
    return card;
  }

  async textMsg(text: string | RegExp, timeoutMs?: number): Promise<ChatEntry> {
    return this.expect(
      `text ${String(text)}`,
      (e) => e.type === "text" && matches(e.text ?? "", text),
      timeoutMs,
    );
  }

  async image(caption: string | RegExp, timeoutMs?: number): Promise<ChatEntry> {
    return this.expect(
      `image ${String(caption)}`,
      (e) => e.type === "image" && matches(e.caption ?? "", caption),
      timeoutMs,
    );
  }

  /** Nothing new from Dockhand for `ms` (a dedupe or a refusal that must stay silent). */
  async quiet(ms: number, what: string): Promise<void> {
    await sleep(ms);
    const fresh = (await this.timeline()).filter((e) => e.seq > this.cursor && e.dir === "out");
    check(fresh.length === 0, `${what}, but Dockhand sent:\n  ${fresh.map(short).join("\n  ")}`);
  }

  private async rendered(e: ChatEntry): Promise<void> {
    await this.page
      .locator(`[data-wa="${e.waId}"]`)
      .first()
      .waitFor({ state: "visible", timeout: 10_000 })
      .catch(() => {
        throw new CheckFailure(`/dev/chat did not render ${short(e)}`);
      });
  }

  private async markSent(): Promise<void> {
    const entries = await this.timeline();
    const last = entries.at(-1);
    if (last) this.cursor = Math.max(this.cursor, last.seq);
  }

  async sendText(text: string): Promise<void> {
    await this.markSent();
    await this.page.locator("#text").fill(text);
    await this.page.locator("#send").click();
    await this.waitInbound((e) => e.type === "text" && e.text === text, `the text "${text}"`);
  }

  async sendFile(path: string, opts: { asDocument?: boolean; caption?: string } = {}): Promise<void> {
    await this.markSent();
    await this.page.locator("#file").setInputFiles(path);
    if (opts.asDocument) await this.page.locator("#asdoc").check();
    if (opts.caption) await this.page.locator("#text").fill(opts.caption);
    await this.page.locator("#send").click();
    const name = path.split(/[\\/]/).pop() ?? path;
    await this.waitInbound((e) => e.media !== undefined, `the file ${name}`);
  }

  /** Taps a button on a card in the page, like the rep would. */
  async tap(card: ChatEntry, title: string): Promise<void> {
    await this.markSent();
    const button = this.page.locator(`[data-wa="${card.waId}"] button[data-button-id]`, { hasText: title });
    check((await button.count()) === 1, `no "${title}" button on ${short(card)}`);
    await button.click();
    await this.waitInbound((e) => e.type === "button_reply" && e.replyTo === card.waId, `the "${title}" tap`);
  }

  private async waitInbound(pred: (e: ChatEntry) => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const entries = await this.timeline();
      const hit = entries.find((e) => e.dir === "in" && e.seq > this.cursor && pred(e));
      if (hit) {
        check(!hit.failed, `${what} was not delivered: ${hit.failed}`);
        this.cursor = hit.seq;
        return;
      }
      const error = await this.page
        .locator("#error")
        .textContent()
        .catch(() => null);
      if (error?.trim()) throw new CheckFailure(`sending ${what} failed in /dev/chat: ${error.trim()}`);
      if (Date.now() > deadline) throw new CheckFailure(`${what} never reached the chat`);
      await sleep(150);
    }
  }

  async shot(name: string): Promise<string> {
    await sleep(150); // let the thread finish scrolling
    const file = join(this.shotsDir, `${String(++this.shots).padStart(2, "0")}-${name}.png`);
    await this.page.screenshot({ path: file });
    return file;
  }
}

function matches(text: string, want: string | RegExp): boolean {
  return typeof want === "string" ? text.includes(want) : want.test(text);
}

// ---------- message lint: what the rep sees must read cleanly on a phone ----------

const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/;

export function lintMessage(e: ChatEntry): string[] {
  const problems: string[] = [];
  const text = words(e);
  const say = (p: string) => problems.push(`${p}: ${short(e)}`);
  if (/\bundefined\b|\bnull\b|\bNaN\b|\[object Object\]/.test(text)) say("undefined/null/NaN in the text");
  if (/^\s*[[{]\s*"/m.test(text) || /"\w+":\s*["{[\d]/.test(text)) say("raw JSON");
  if (/^\s+at .+\(.+:\d+:\d+\)$/m.test(text) || /\bError: /.test(text)) say("stack trace or raw error");
  if (ULID.test(text) || /wamid\./.test(text)) say("internal ID");
  if (/\b(assistant|chatbot|chat bot)\b/i.test(text)) say("calls itself an assistant or chatbot");
  if (/\b\d+(\.\d+)?s\b/.test(text) || /\b\d+\.\d{2,} s\b/.test(text)) say('seconds not as "3.1 s"');
  if (/\$\d+\.\d{5,}/.test(text)) say("cost with too many decimals");
  if (/`[^`]+`/.test(text) && !/```/.test(text)) {
    for (const m of text.matchAll(/`([^`]+)`/g)) {
      if (!/^[A-Za-z0-9_./ -]+$/.test(m[1] ?? "")) say("monospace on something that is not an ID or command");
    }
  }
  for (const b of e.buttons ?? [])
    if ([...b.title].length > 20) say(`button "${b.title}" over 20 characters`);
  if (e.type === "interactive" && [...(e.text ?? "")].length > 1024) say("card body over 1024 characters");
  return problems;
}

// ---------- the demo ----------

const root = workspaceRoot();
const fixture = (...p: string[]) => join(root, "fixtures", ...p);
const expected = (name: string) =>
  JSON.parse(readFileSync(fixture("inbound", `${name}.expected.json`), "utf8")) as {
    partnerPortalSubmission: Record<string, unknown>;
  };

const REG_ID = /NW-REG-\d{5}/;
const SUPPLIER_SAMPLE = {
  legalName: "Tidewater Cloud Ltda.",
  taxId: "00-1234567",
  countryOfIncorporation: "Brazil",
  city: "São Paulo",
  primaryContactEmail: "ana.ribeiro@example.com",
  bankName: "Banco Exemplo S.A.",
  routingNumber: "999999999",
  currency: "BRL",
  signatoryName: "Renata Figueiredo",
};

interface World {
  o: Options;
  rep: Rep;
  base: string;
  partner: string;
  supplier: string;
  dbPath: string;
  /** The Caravela skill's name, learned from the teach step. */
  skill: string;
}

async function submissions(url: string): Promise<Submission[]> {
  return getJson<Submission[]>(`${url}/api/__test/submissions`);
}

/** The latest top-level run (canary and verification runs have "-" in their id). */
function latestRun(w: World): {
  id: string;
  mode: string;
  outcome: string;
  model_calls: number;
  skill_version: number;
} {
  const db = new DatabaseSync(w.dbPath, { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, mode, outcome, model_calls, skill_version FROM runs WHERE id NOT LIKE '%-%' ORDER BY started_at DESC, rowid DESC LIMIT 1",
      )
      .get() as never;
  } finally {
    db.close();
  }
}

/** Free-text fields the model may word differently between runs (the fixtures mark them ungraded). */
let freeText: readonly string[] = [];

function fieldsMatch(actual: Record<string, unknown>, want: Record<string, unknown>, what: string): void {
  for (const [k, v] of Object.entries(want)) if (!freeText.includes(k)) same(actual[k], v, `${what}.${k}`);
}

type Step = { name: string; run: (w: World) => Promise<void> };

const STEPS: Step[] = [
  {
    name: "teach",
    async run(w) {
      const { rep } = w;
      await rep.sendFile(fixture("teach", "caravela-register-deal.mp4"), { asDocument: true });
      await rep.textMsg("Watching your recording");
      const card = await rep.card(/^I learned \*/, ["Looks right", "Cancel"]);
      check(card.header?.type === "image", "the teach card has no image of what was learned");
      check(/\d+ steps, \d+ values/.test(card.text ?? ""), "the teach card does not count steps and values");
      await rep.shot("teach-card");
      await rep.tap(card, "Looks right");
      const saved = await rep.textMsg(/^Saved the draft "[a-z][a-z0-9_]*"/);
      // The model names the skill (the fixture says register_partner_deal; live Wonder said register_deal).
      w.skill = /"([a-z][a-z0-9_]*)"/.exec(saved.text ?? "")?.[1] ?? w.skill;
      await rep.shot("teach-saved");
    },
  },
  {
    name: "first run (computer use) compiles v1",
    async run(w) {
      const { rep } = w;
      const before = (await submissions(w.partner)).length;
      await rep.sendFile(fixture("inbound", "referral-cafe-aurora.jpg"));
      const plan = await rep.card("First time: computer use", ["Approve", "Cancel"]);
      check(
        // The label follows the param name the teach model chose ("Company name", "End customer company").
        /: Café Aurora Ltda.$/m.test(plan.text ?? ""),
        "the plan does not show the company",
      );
      await rep.shot("first-run-plan");
      await rep.tap(plan, "Approve");
      await rep.textMsg(/^First run on Caravela Partner Hub with computer use/);
      const commit = await rep.card(/^Ready to submit on Caravela Partner Hub/, ["Approve", "Cancel"]);
      check(commit.header?.type === "image", "the submit card has no screenshot of the filled form");
      check(
        (commit.text ?? "").includes("Café Aurora Ltda."),
        "the submit card does not read back the company",
      );
      same((await submissions(w.partner)).length, before, "partner submissions before the submit tap");
      await rep.shot("first-run-submit-card");
      await rep.tap(commit, "Approve");
      const receipt = await rep.image(/First run · computer use/);
      const id = REG_ID.exec(receipt.caption ?? "")?.[0];
      check(id, `the first-run receipt has no registration ID: ${receipt.caption}`);
      const skill = await rep.image(`New skill: ${w.skill} v1.`);
      check(skill.media, "the skill card has no image");
      await rep.shot("first-run-receipt");
      const subs = await submissions(w.partner);
      same(subs.length, before + 1, "partner submissions after the first run");
      const sub = subs.at(-1) as Submission;
      same(sub.id, id, "registration ID on the receipt vs the portal");
      fieldsMatch(
        sub.fields,
        expected("referral-cafe-aurora").partnerPortalSubmission,
        "Café Aurora submission",
      );
    },
  },
  {
    name: "replay with zero model calls",
    async run(w) {
      const { rep } = w;
      await rep.sendFile(fixture("inbound", "referral-vila-nova.jpg"));
      const plan = await rep.card(`${w.skill} v1`, ["Approve", "Cancel"]);
      await rep.shot("replay-plan");
      await rep.tap(plan, "Approve");
      const commit = await rep.card(/^Ready to submit on Caravela Partner Hub/, ["Approve", "Cancel"]);
      check((commit.text ?? "").includes("Vila Nova Logística Ltda."), "the submit card lacks the company");
      await rep.tap(commit, "Approve");
      const receipt = await rep.image(/Replay · compiled skill/);
      const caption = receipt.caption ?? "";
      check(/execution \$0\.00\b/.test(caption), `a replay must cost $0.00 to execute: ${caption}`);
      const verified = /(\d+)\/(\d+) fields verified/.exec(caption);
      check(verified && verified[1] === verified[2], `read-back must verify every field: ${caption}`);
      check(REG_ID.test(caption), "the replay receipt has no registration ID");
      await rep.shot("replay-receipt");
      const run = latestRun(w);
      same(
        [run.mode, run.outcome, run.model_calls],
        ["replay", "success", 0],
        "replay run (mode, outcome, model calls)",
      );
      const sub = (await submissions(w.partner)).at(-1) as Submission;
      fieldsMatch(sub.fields, expected("referral-vila-nova").partnerPortalSubmission, "Vila Nova submission");
    },
  },
  {
    name: "portal v2: heal, canary, skill v2",
    async run(w) {
      const { rep } = w;
      await getJson(`${w.partner}/api/__admin/version`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: "v2" }),
      });
      await rep.sendFile(fixture("inbound", "referral-cafe-aurora.jpg"));
      const plan = await rep.card(`${w.skill} v1`, ["Approve", "Cancel"]);
      await rep.tap(plan, "Approve");
      const commit = await rep.card(/^Ready to submit on Caravela Partner Hub/, ["Approve", "Cancel"]);
      await rep.shot("v2-submit-card");
      await rep.tap(commit, "Approve");
      const receipt = await rep.image(/Replay · repaired/);
      check(REG_ID.test(receipt.caption ?? ""), "the repaired receipt has no registration ID");
      const diff = await rep.image(/^Portal changed: Caravela Partner Hub\./);
      const caption = diff.caption ?? "";
      check(caption.includes(`Saved ${w.skill} v2 (`), `the diff does not save v2: ${caption}`);
      check(/\d+\/\d+ dry runs/.test(caption), `the diff does not report the canary: ${caption}`);
      check(caption.includes(`/rollback ${w.skill} 1`), "the diff does not offer the rollback");
      await rep.shot("v2-diff");
      const sub = (await submissions(w.partner)).at(-1) as Submission;
      same(sub.version, "v2", "the healed submission's portal version");
      fieldsMatch(sub.fields, expected("referral-cafe-aurora").partnerPortalSubmission, "healed submission");
    },
  },
  {
    name: "new required field: ask the rep once, add the param",
    async run(w) {
      const { rep } = w;
      await getJson(`${w.partner}/api/__admin/mutation`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ seed: 1, operators: ["insert_required_field"] }),
      });
      await rep.sendFile(fixture("inbound", "referral-vila-nova.jpg"));
      const plan = await rep.card(`${w.skill} v2`, ["Approve", "Cancel"]);
      await rep.tap(plan, "Approve");
      const question = await rep.card(/"Partner tier"/, ["Gold", "Silver", "Bronze"]);
      await rep.shot("ask-rep-question");
      await rep.tap(question, "Gold");
      const commit = await rep.card(/^Ready to submit on Caravela Partner Hub/, ["Approve", "Cancel"]);
      check((commit.text ?? "").includes("Partner tier: Gold"), "the submit card does not show the answer");
      await rep.tap(commit, "Approve");
      await rep.image(/^Register a partner deal|Replay ·/);
      const diff = await rep.image(/^Portal changed: Caravela Partner Hub\./);
      check((diff.caption ?? "").includes(`Saved ${w.skill} v3 (`), `no v3: ${diff.caption}`);
      await rep.shot("ask-rep-v3");
      const sub = (await submissions(w.partner)).at(-1) as Submission;
      same(sub.fields.partnerTier, "Gold", "partner tier on the portal");
      fieldsMatch(sub.fields, expected("referral-vila-nova").partnerPortalSubmission, "submission with tier");
    },
  },
  {
    name: "skills, rollback, history",
    async run(w) {
      const { rep } = w;
      await rep.sendText("/skills");
      await rep.textMsg(`${w.skill} v3`);
      await rep.sendText(`/rollback ${w.skill} 2`);
      await rep.textMsg(`Rolled back: ${w.skill} v2 is active`);
      await rep.sendText(`/skills ${w.skill}`);
      await rep.textMsg(`*${w.skill} v2* (active`);
      await rep.sendText(`/rollback ${w.skill} 3`);
      await rep.textMsg(/v3 is active/);
      await rep.sendText("/history");
      await rep.textMsg(/Recent requests/);
      await rep.shot("commands");
    },
  },
  {
    name: "supplier onboarding: acme zero-shot",
    async run(w) {
      const { rep } = w;
      const before = (await submissions(w.supplier)).length;
      await rep.sendFile(fixture("inbound", "acme-supplier-invitation.pdf"));
      const plan = await rep.card(
        "Register Tidewater Cloud as a supplier for Acme Group (invite ACME-7731)",
        ["Approve", "Cancel"],
      );
      await rep.shot("supplier-plan");
      await rep.tap(plan, "Approve");
      await rep.textMsg(/^First run on Supplier Portal with computer use/);
      const commit = await rep.card(/^Ready to submit on Supplier Portal/, ["Approve", "Cancel"], 300_000);
      same((await submissions(w.supplier)).length, before, "supplier submissions before the submit tap");
      await rep.shot("supplier-submit-card");
      await rep.tap(commit, "Approve");
      // A live model can miss the submit button after the approval; the gate then asks again (one approval
      // releases one click). Approve up to two retries in record/cassette mode; the stand-ins must not need any.
      let receipt = await rep.expect(
        "the first-run receipt",
        (e) =>
          (e.type === "image" && /First run · computer use/.test(e.caption ?? "")) ||
          (w.o.mode !== "fake" && e.type === "interactive" && /^Ready to submit/.test(e.text ?? "")),
        240_000,
      );
      for (let retry = 0; receipt.type === "interactive" && retry < 2; retry++) {
        await rep.tap(receipt, "Approve");
        receipt = await rep.expect(
          "the first-run receipt",
          (e) =>
            (e.type === "image" && /First run · computer use/.test(e.caption ?? "")) ||
            (e.type === "interactive" && /^Ready to submit/.test(e.text ?? "")),
          240_000,
        );
      }
      check(receipt.type === "image", "the supplier run kept asking to submit");
      check(/SG-ACME-\d{6}/.test(receipt.caption ?? ""), `no supplier ID on the receipt: ${receipt.caption}`);
      await rep.image(/^New skill: supplier_onboarding v1\b/, 240_000);
      await rep.shot("supplier-receipt");
      const sub = (await submissions(w.supplier)).at(-1) as Submission;
      same([sub.tenant, sub.inviteCode], ["acme", "ACME-7731"], "acme submission tenant and invite");
      fieldsMatch(sub.fields, SUPPLIER_SAMPLE, "acme submission");
      same(
        (sub.files ?? []).map((f) => f.filename).sort(),
        ["insurance-certificate-sample.pdf", "w9-sample.pdf"],
        "acme uploads",
      );
    },
  },
  {
    name: "supplier onboarding: globex replays",
    async run(w) {
      const { rep } = w;
      await rep.sendFile(fixture("inbound", "globex-supplier-invitation.pdf"));
      const plan = await rep.card("supplier_onboarding v1", ["Approve", "Cancel"]);
      check((plan.text ?? "").includes("GLOBEX-2048"), "the globex plan lacks the invite code");
      await rep.tap(plan, "Approve");
      const commit = await rep.card(/^Ready to submit on Supplier Portal/, ["Approve", "Cancel"]);
      await rep.tap(commit, "Approve");
      const receipt = await rep.image(/Replay · compiled skill/);
      check(/execution \$0\.00\b/.test(receipt.caption ?? ""), "the globex replay must cost $0.00");
      await rep.shot("globex-receipt");
      const run = latestRun(w);
      same([run.mode, run.model_calls], ["replay", 0], "globex run (mode, model calls)");
      const sub = (await submissions(w.supplier)).at(-1) as Submission;
      same([sub.tenant, sub.inviteCode], ["globex", "GLOBEX-2048"], "globex submission tenant and invite");
      fieldsMatch(sub.fields, SUPPLIER_SAMPLE, "globex submission");
    },
  },
  {
    name: "quote to CRM",
    async run(w) {
      const { rep } = w;
      const script = (
        JSON.parse(readFileSync(fixture("voice", "expected.json"), "utf8")) as {
          scripts: { id: string; script: string }[];
        }
      ).scripts.find((s) => s.id === "vn2-quote-cafe-aurora")?.script;
      check(script, "the quote voice script is missing from fixtures/voice/expected.json");
      await rep.sendText(script);
      const plan = await rep.card("Quote for Café Aurora: 25 seats of Tidewater Cloud Business", [
        "Approve",
        "Cancel",
      ]);
      check((plan.text ?? "").includes("R$ 32.130,00"), "the quote plan lacks the total");
      await rep.shot("quote-plan");
      await rep.tap(plan, "Approve");
      const pdf = await rep.expect("the quote PDF", (e) => e.type === "document");
      same(pdf.media?.mime, "application/pdf", "quote document type");
      await rep.textMsg(/^Draft reply for you to forward/);
      const receipt = await rep.image(/API · /);
      check(receipt.caption?.includes("Quote for Café Aurora"), "the quote receipt lacks its title");
      await rep.shot("quote-receipt");
      const crm = await getJson<{
        companies: { name: string }[];
        deals: { amountMinor: number; currency: string }[];
        notes: unknown[];
      }>(`${w.base}/__dev/crm`);
      same(
        crm.companies.map((c) => c.name),
        ["Café Aurora"],
        "CRM companies",
      );
      same(
        crm.deals.map((d) => [d.amountMinor, d.currency]),
        [[3_213_000, "BRL"]],
        "CRM deals",
      );
      same(crm.notes.length, 1, "CRM notes (the quote PDF on the deal)");
    },
  },
];

// ---------- cost cap (record mode) ----------

let costAbort: string | undefined;

function modelCost(dbPath: string): number {
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS c FROM model_calls").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

/** Polls the ledger; above the cap it stops the dev process, so no further call can be made. */
function watchCost(o: Options, dbPath: string, dev: Dev): void {
  const timer = setInterval(() => {
    let spent = 0;
    try {
      spent = modelCost(dbPath);
    } catch {
      return;
    }
    if (spent <= o.maxUsd) return;
    clearInterval(timer);
    costAbort = `model calls cost ${spent.toFixed(2)} USD, over the ${o.maxUsd} USD cap`;
    process.stdout.write(`  STOP  ${costAbort}
`);
    void dev.stop();
  }, 2_000);
  timer.unref();
}

// ---------- main ----------

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  // Real model output words free text its own way (notes); the stand-ins are exact.
  if (o.mode !== "fake") freeText = ["notes"];
  const shotsDir = join(o.varDir, "demo-check");
  const results: StepResult[] = [];
  const t0 = performance.now();
  process.stdout.write(
    `demo:check  mode=${o.mode}  ports=${o.ports.gateway},${o.ports.partner},${o.ports.supplier}  var=${relative(root, o.varDir) || "."}\n`,
  );
  let dev: Dev | undefined;
  let browser: Browser | undefined;
  try {
    if (o.mode === "record" && !(o.maxUsd > 0)) throw new Error("--record needs a positive --max-usd");
    dev = await startDev(o);
    if (o.mode === "record") watchCost(o, join(o.varDir, "dockhand.sqlite"), dev);
    const base = `http://127.0.0.1:${o.ports.gateway}`;
    browser = await chromium.launch({ headless: !o.headed, slowMo: o.slowMo });
    const context = await browser.newContext({ viewport: { width: 520, height: 940 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.addInitScript((rep) => localStorage.setItem("dockhand.from", rep), o.rep);
    await page.goto(`${base}/dev/chat`);
    await page.locator("#from").waitFor();
    const rep = new Rep(page, o, base, shotsDir);
    const w: World = {
      o,
      rep,
      base,
      partner: `http://127.0.0.1:${o.ports.partner}`,
      supplier: `http://127.0.0.1:${o.ports.supplier}`,
      dbPath: join(o.varDir, "dockhand.sqlite"),
      skill: "register_partner_deal",
    };
    for (const step of STEPS) {
      const s0 = performance.now();
      try {
        await step.run(w);
        results.push({ name: step.name, ok: true, ms: performance.now() - s0 });
        process.stdout.write(`  ok    ${step.name} (${((performance.now() - s0) / 1000).toFixed(1)} s)\n`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ name: step.name, ok: false, ms: performance.now() - s0, error: message });
        process.stdout.write(`  FAIL  ${step.name}\n        ${message.replace(/\n/g, "\n        ")}\n`);
        await rep.shot(`FAIL-${step.name.replace(/[^a-z0-9]+/gi, "-")}`).catch(() => {});
        break;
      }
    }
    // Every message the rep saw, linted (also after a failure: it shows what was on screen).
    const problems = (await rep.timeline()).filter((e) => e.dir === "out").flatMap(lintMessage);
    const lintOk = problems.length === 0;
    results.push({
      name: "every message reads cleanly",
      ok: lintOk,
      ms: 0,
      ...(lintOk ? {} : { error: problems.join("\n") }),
    });
    process.stdout.write(
      lintOk
        ? "  ok    every message reads cleanly\n"
        : `  FAIL  every message reads cleanly\n        ${problems.join("\n        ")}\n`,
    );
    writeFileSync(join(shotsDir, "timeline.json"), JSON.stringify(await rep.timeline(), null, 2));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name: "setup", ok: false, ms: 0, error: message });
    process.stdout.write(`  FAIL  setup: ${message}\n`);
  } finally {
    await browser?.close().catch(() => {});
    await dev?.stop().catch(() => {});
  }
  if (o.mode !== "fake") {
    const spent = modelCost(join(o.varDir, "dockhand.sqlite"));
    const what =
      o.mode === "record"
        ? `spent on live model calls: $${spent.toFixed(3)} at list price`
        : `replayed from tapes, nothing spent (the same calls live: $${spent.toFixed(3)} at list price)`;
    process.stdout.write(`${what}${costAbort ? ` - ABORTED: ${costAbort}` : ""}\n`);
    if (costAbort) results.push({ name: "cost cap", ok: false, ms: 0, error: costAbort });
  }
  const failed = results.filter((r) => !r.ok);
  const skipped = STEPS.length - results.filter((r) => STEPS.some((s) => s.name === r.name)).length;
  process.stdout.write(
    `${failed.length === 0 ? "PASS" : "FAIL"}  ${results.filter((r) => r.ok).length} passed, ${failed.length} failed${skipped > 0 ? `, ${skipped} not run` : ""}  in ${((performance.now() - t0) / 1000).toFixed(0)} s\n`,
  );
  process.stdout.write(`screenshots and dev.log: ${relative(root, shotsDir)}\n`);
  if (existsSync(join(shotsDir, "dev.log")) && failed.length > 0) {
    const tail = readFileSync(join(shotsDir, "dev.log"), "utf8").split("\n").slice(-15).join("\n");
    process.stdout.write(`--- dev.log (last lines) ---\n${tail}\n`);
  }
  return failed.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exit(2);
  },
);

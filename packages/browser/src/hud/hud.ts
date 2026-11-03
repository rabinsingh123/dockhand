// Node side of the demo overlay (DEMO_MODE only): a per-page observer that the pool attaches to every leased
// page, fed by small optional hooks in the skills runner and the computer-use loop. It only draws: it never
// changes what automation sees (see hud-page.js), every page call is best effort, and when pacing is on every
// second it waits is logged so the runner can leave it out of reported timings.
//
// What it shows (the video's design spec): a status strip with five facts (stage, model, elapsed, spend,
// verified) plus quiet notes; free fixes as a gray rule under the field and one counter; the model heals as a spotlight (the page
// dims, the ladder shows each rung tried and its result, then Muse Spark Open's pick with its reason, real latency
// and cost, then what code checked); the read-back before submit, field by field.

import { readFileSync } from "node:fs";
import type {
  BBox,
  CuAction,
  CuHooks,
  Decision,
  ElementDescriptor,
  HealRung,
  Repairer,
  RunHooks,
  Skill,
  Step,
  Target,
} from "@dockhand/core";
import type { ElementHandle, Locator, Page } from "playwright";
import { toLocator } from "../helpers/locators.ts";

const fontFile = (name: string) => readFileSync(new URL(`./fonts/${name}`, import.meta.url));
/**
 * Mona Sans and Geist Mono (SIL OFL 1.1, fonts/OFL.txt), variable: the HUD's type, and the flight recorder's (Geist
 * Mono only for its code). Mona Sans is the Google Fonts latin subset, weight 200 to 900, width 75% to 125%.
 */
export const HUD_FONTS: { sans: Uint8Array; mono: Uint8Array } = {
  sans: fontFile("MonaSans-Variable.woff2"),
  mono: fontFile("GeistMono-Variable.woff2"),
};

/** The in-page overlay, with Mona Sans inlined. Installed with addInitScript on every leased context when the HUD is on. */
export const HUD_SCRIPT: string = readFileSync(new URL("./hud-page.js", import.meta.url), "utf8").replace(
  "/*__DOCKHAND_FONTS__*/null",
  JSON.stringify({ sans: Buffer.from(HUD_FONTS.sans).toString("base64") }),
);
export const HUD_TAG = "dockhand-hud";
/** Added to every screenshot taken through a HUD page (Playwright's `style` option), so no image has it. */
export const HUD_HIDE_CSS = `${HUD_TAG}{visibility:hidden!important;opacity:0!important}`;

const HUD_KEY = Symbol.for("dockhand.hud");
const WRAPPED = Symbol.for("dockhand.hud.wrapped");

export interface HudOptions {
  /**
   * Extra milliseconds per replay step (cursor travel, dwell, holds) so a 3-second replay is followable at 1x.
   * Off when 0 or unset. Shown on screen as "Slowed for video" and excluded from every reported timing.
   */
  pacingMs?: number;
  /** META_MODE of the process: model phases carry a "Fake models"/"Cassette rehearsal" note unless live or record. */
  metaMode?: string;
  /**
   * Holds a finished replay's last state (submitted, verified, its time and spend) on screen this long before the
   * page closes, so a filmed run shows its result even at full speed. Excluded from timings like pacing.
   */
  endHoldMs?: number;
}

/** DEMO_MODE=1 turns the HUD on; DEMO_PACING_MS sets pacing. Null when DEMO_MODE is off. */
export function hudOptionsFromEnv(env: Record<string, string | undefined> = process.env): HudOptions | null {
  const on = ["1", "true", "yes", "on"].includes((env.DEMO_MODE ?? "").trim().toLowerCase());
  if (!on) return null;
  const pacing = Number(env.DEMO_PACING_MS ?? "");
  return {
    pacingMs: Number.isFinite(pacing) && pacing > 0 ? Math.min(pacing, 5000) : 0,
    metaMode: env.META_MODE ?? "fake",
  };
}

/** The HUD attached to `page` by the pool, if any. Callers use `hudOf(page)?.x()`: a no-op when it is off. */
export function hudOf(page: Page): Hud | undefined {
  return (page as unknown as Record<symbol, Hud | undefined>)[HUD_KEY];
}

/** Attaches a HUD to a page whose context runs HUD_SCRIPT: every screenshot of it leaves the overlay out. */
export function attachHud(page: Page, opts: HudOptions): Hud {
  const existing = hudOf(page);
  if (existing) return existing;
  const hud = new Hud(page, opts);
  Object.defineProperty(page, HUD_KEY, { value: hud, enumerable: false, configurable: true });
  const original = page.screenshot.bind(page);
  const screenshot = async (o: Parameters<Page["screenshot"]>[0] = {}) => {
    const style = o.style ? `${o.style}\n${HUD_HIDE_CSS}` : HUD_HIDE_CSS;
    try {
      return await original({ ...o, style });
    } finally {
      hud.shutter();
    }
  };
  page.screenshot = screenshot as Page["screenshot"];
  page.on("domcontentloaded", () => hud.resync());
  return hud;
}

// ---------- in-page API (hud-page.js) ----------

type Box = { x: number; y: number; w: number; h: number; space: "doc" | "view" };
interface OutlineOpts {
  tone?: "accent" | "ground" | "gray" | "error";
  dash?: boolean;
  label?: string;
  sub?: string;
  tagTone?: "plain" | "fail";
  below?: boolean;
  /** Cut out of the spotlight scrim. */
  hole?: boolean;
  pad?: number;
  delay?: number;
  ttl?: number;
}
interface RungView {
  name: string;
  status: "pending" | "trying" | "fail" | "ok" | "off" | "na";
  detail: string;
}
interface SpotView {
  title: string;
  sub?: string;
  rungs?: RungView[];
  pick?: { title: string; reason?: string; meta?: string };
  verified?: { ok: boolean; text: string };
}
interface ReadbackView {
  title: string;
  sub: string;
  rows: { label: string; value: string; ok: boolean }[];
  stepMs: number;
  instant: boolean;
}
interface HudPageApi {
  view(s: View): void;
  glide(x: number, y: number, ms?: number): Promise<void>;
  glideTo(target: Element | Box, ms?: number): Promise<boolean>;
  ripple(x: number, y: number): void;
  rippleOn(target: Element): void;
  glideClick(x: number, y: number, ms?: number): Promise<void>;
  activeOn(target: Element, o?: OutlineOpts): void;
  activeBox(box: Box, o?: OutlineOpts): void;
  activeOff(): void;
  markOn(target: Element, key: string, kind: "free" | "ok" | "bad", delay?: number): void;
  outlineOn(target: Element, key: string, o: OutlineOpts): void;
  outline(key: string, box: Box, o: OutlineOpts): void;
  acted(target: Element, o: { click: boolean }): void;
  unbox(key: string): void;
  scrim(on: boolean): void;
  spot(st: SpotView): void;
  spotOff(): void;
  readback(st: ReadbackView): void;
  readbackOff(): void;
  hint(text: string, x: number, y: number, ms?: number): void;
  hintBottom(text: string, ms?: number): void;
  shutter(): void;
  clear(all?: boolean): void;
  retire(prefix: string, ms?: number): void;
  hideCursor(): void;
}
type Method = keyof HudPageApi;

declare global {
  interface Window {
    __dockhandHud?: HudPageApi;
  }
}

/** The status strip: stage and model, then elapsed, spend and the verified count, then quiet notes. */
interface View {
  visible: boolean;
  stage: string;
  model: string;
  /** The model slot holds an ID (registration number): set like the stage, not like a model's name. */
  modelId?: boolean;
  /** A real failure: the stage is set in the error color. */
  fail?: boolean;
  clock: { startedAt: number; pausedMs: number; pausedAt: number | null; frozenAt?: number } | null;
  cost: number | null;
  facts: { text: string; bad?: boolean }[];
  notes: { text: string; tick?: boolean }[];
}

// ---------- labels ----------

const KNOWN_MODELS: Record<string, string> = {
  "muse-spark-1.3": "Muse Spark 1.3",
  "muse-wonder-1.0": "Muse Wonder 1.0",
};

/** "muse-spark-1.3" -> "Muse Spark 1.3"; scripted and fake models say so. */
export function modelLabel(model: string, provider?: string): string {
  if (provider === "scripted") return "scripted model";
  if (provider === "fake") return "fake model";
  const id = model.replace(/-contributor$/, "");
  const base = /muse-spark-open/.test(id)
    ? "Muse Spark Open"
    : (KNOWN_MODELS[id] ??
      id
        .replace(/^.*\//, "")
        .split("-")
        .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(" "));
  return provider === "cassette" ? `${base} (cassette)` : base;
}

function targetOf(step: Step | undefined): Target | undefined {
  if (!step) return undefined;
  switch (step.op) {
    case "click":
    case "fill":
    case "check":
    case "upload":
      return step.target;
    case "select":
      return step.trigger;
    case "press":
    case "waitFor":
      return step.target;
    default:
      return undefined;
  }
}

function nameOf(fp: ElementDescriptor | undefined): string {
  if (!fp) return "the control";
  const raw = fp.label || fp.name || fp.placeholder || fp.text || fp.testId || fp.tag;
  return raw.replace(/^[\s*]+|[\s*:]+$/g, "").slice(0, 48);
}

/**
 * Keeps a label to about `n` characters without an ellipsis: whole words, and never shorter than the first word
 * (labels this long are rare; the HUD wraps rather than truncating what the viewer reads).
 */
function clip(s: string, n: number): string {
  if (s.length <= n + 12) return s;
  const cut = s.slice(0, n + 1).replace(/\s+\S*$/, "");
  return cut.length > 0 ? cut : s.slice(0, n);
}

function secs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

/** A true zero reads $0.00; paid calls keep four decimals (they are fractions of a cent). */
function money(usd: number): string {
  return usd >= 1 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

/**
 * A model's reason, for the spotlight: parentheticals out, one paragraph, and only its first sentence when the
 * whole would run past three lines. Never an ellipsis: a shorter true sentence beats a cut one.
 */
export function spotlightReason(reason: string): string {
  const flat = reason
    .replace(/\s*\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= 150) return flat;
  const first = /^(.{20,}?[.;:])(\s|$)/.exec(flat)?.[1];
  return first && first.length <= 170 ? first.replace(/[;:]$/, ".") : flat;
}

/** The open-weights repairer's note ("now 'X' (reason)") split into the chosen element and the model's reason. */
export function parsePickNote(note: string): { chosen: string | null; reason: string } {
  const m = /^now '(.+?)' \(([\s\S]*)\)$/.exec(note.trim());
  return m ? { chosen: m[1] ?? null, reason: m[2] ?? "" } : { chosen: null, reason: note };
}

const WRITE_OPS = new Set(["fill", "select", "check", "upload"]);
const CLICKY_OPS = new Set(["click", "fill", "select", "check"]);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RungId = "free" | "open_weights" | "computer_use" | "ask_rep";
interface LadderRung extends RungView {
  id: RungId;
}
/** The heal ladder for one broken step: every rung, marked as it is tried. */
interface Ladder {
  stepIdx: number;
  name: string;
  why: string;
  rungs: LadderRung[];
  done: boolean;
}
/** The ladder row a heal rung belongs to (both free rungs share the first row). */
const rungRow = (r: HealRung): RungId => (r === "fallback" || r === "similarity" ? "free" : r);
const RUNG_NAME: Record<RungId, string> = {
  free: "Free fixes",
  open_weights: "Muse Spark Open",
  computer_use: "Computer use",
  ask_rep: "Ask the rep",
};

/**
 * Pure computer use on the same form, measured live (evals/results/live-headline.md §2: Caravela, 8/8 runs,
 * $0.1107 and 145.2 s per run): a finished replay shows its own time and spend next to it. Portals without such
 * a measurement show only their own numbers.
 */
const CU_MEASURED: Record<string, { s: number; usd: number }> = { caravela: { s: 145, usd: 0.11 } };

interface RunState {
  mode: "replay" | "dry_run" | "cu";
  /** The caller's name for the phase ("Drift watch · dry run"). */
  label?: string;
  /** The skill's portal (replays and dry runs). */
  portalId?: string;
  purpose: string;
  model: string;
  provider: string;
  total: number;
  original: Map<string, Step>;
  idx: number;
  actions: number;
  ended: { stage: string; model: string; modelId?: boolean; fail?: boolean; notes: View["notes"] } | null;
}

/**
 * One per leased page. Methods never throw and never block automation unless pacing is on; then they await
 * cursor travel and short holds, all logged in `pausedSince` so callers can subtract them.
 */
export class Hud {
  private readonly pacing: number;
  private readonly endHold: number;
  private readonly sim: string | null;
  private run: RunState | null = null;
  private heal: { idx: number; rung?: HealRung; model: string } | null = null;
  private waiting: { stage: string; model: string } | null = null;
  private clock: View["clock"] = null;
  private baseCost = 0;
  private liveCost = 0;
  private calls = 0;
  private verified: { matched: number; checked: number } | null = null;
  private readbackSig = "";
  private readonly pauses: { start: number; end: number }[] = [];
  private pushQueued = false;
  private lastCuModel = "Muse computer use";
  private readonly freeFixed = new Set<string>();
  private readonly paidFixed = new Map<string, HealRung>();
  private lastStep = -1;
  private clockHolds = 0;
  private clockHoldStart = 0;
  private readonly ladders = new Map<string, Ladder>();
  private avail = new Set<HealRung>();
  /** When the current step began (performance.now()): the free rungs' time when a step breaks. */
  private stepAt = 0;

  constructor(
    private readonly page: Page,
    opts: HudOptions,
  ) {
    this.pacing = Math.max(0, opts.pacingMs ?? 0);
    this.endHold = Math.max(0, opts.endHoldMs ?? 0);
    const mode = opts.metaMode ?? "live";
    this.sim = mode === "fake" ? "Fake models" : mode === "cassette" ? "Cassette rehearsal" : null;
  }

  // ---------- timing ----------

  /** Milliseconds this HUD spent holding the run (pacing) since `t0` (a performance.now() value). */
  pausedSince(t0: number): number {
    let ms = 0;
    for (const p of this.pauses) if (p.end > t0) ms += p.end - Math.max(p.start, t0);
    return ms;
  }

  private paced(): number {
    return this.run?.mode === "replay" ? this.pacing : 0;
  }

  /** Awaits `work` (or `ms`) as a pause: logged for timing exclusion; the on-screen clock stands still. */
  private async hold(ms: number, work?: Promise<unknown>): Promise<void> {
    if (ms <= 0 && !work) return;
    const start = performance.now();
    this.pauseClock();
    try {
      await Promise.all([work?.catch(() => {}), ms > 0 ? sleep(ms) : undefined]);
    } finally {
      this.pauses.push({ start, end: performance.now() });
      this.resumeClock();
    }
  }

  /**
   * The on-screen clock stands still (pacing holds, the rep deciding); nested pauses share one start. A frozen
   * clock (the run ended) is left alone: pausing it would make its final time shrink during the closing hold.
   */
  private pauseClock(): void {
    if (this.clockHolds++ === 0 && this.clock && this.clock.frozenAt === undefined) {
      this.clockHoldStart = Date.now();
      this.clock = { ...this.clock, pausedAt: this.clockHoldStart };
      this.push();
    }
  }

  private resumeClock(): void {
    if (this.clockHolds === 0) return;
    if (--this.clockHolds === 0 && this.clock && this.clock.pausedAt !== null) {
      this.clock = {
        ...this.clock,
        pausedMs: this.clock.pausedMs + (Date.now() - this.clockHoldStart),
        pausedAt: null,
      };
      this.push();
    }
  }

  /** A model call's time as shown: a cassette answers in milliseconds, so it says "replayed" instead. */
  private latency(ms: number): string {
    if (this.sim === "Cassette rehearsal") return "replayed";
    if (this.sim === "Fake models") return "fake model";
    return secs(ms);
  }

  // ---------- page calls ----------

  /** Calls an in-page HUD method by name (no closures cross into the page; nothing is eval'd there). */
  private call(method: Method, ...args: unknown[]): Promise<void> {
    if (this.page.isClosed()) return Promise.resolve();
    return this.page
      .evaluate(
        ([m, a]) => {
          const api = window.__dockhandHud as unknown as
            | Record<string, (...x: unknown[]) => unknown>
            | undefined;
          const f = api?.[m];
          return typeof f === "function" ? Promise.resolve(f(...a)).then(() => undefined) : undefined;
        },
        [method, args] as const,
      )
      .catch(() => {});
  }

  /** Same, with the element a locator or handle points at as the first argument. */
  private onElement(
    target: Locator | ElementHandle | null | undefined,
    method: Method,
    ...args: unknown[]
  ): Promise<void> {
    if (!target || this.page.isClosed()) return Promise.resolve();
    const fn = (el: Node, [m, a]: readonly [string, unknown[]]) => {
      const api = window.__dockhandHud as unknown as Record<string, (...x: unknown[]) => unknown> | undefined;
      const f = api?.[m];
      return typeof f === "function" ? Promise.resolve(f(el, ...a)).then(() => undefined) : undefined;
    };
    const arg = [method, args] as const;
    const p =
      "asElement" in target
        ? (target as ElementHandle).evaluate(fn, arg)
        : (target as Locator).evaluate(fn, arg, { timeout: 1500 });
    return Promise.resolve(p).then(
      () => {},
      () => {},
    );
  }

  /** The element a target's stored selectors find now (first one that matches exactly one), for drawing only. */
  private async locate(t: Target | undefined): Promise<Locator | null> {
    for (const c of t?.candidates ?? []) {
      if ("value" in c && c.value.includes("{{")) continue;
      if ("name" in c && c.name.includes("{{")) continue;
      const loc = toLocator(this.page, c);
      if ((await loc.count().catch(() => 0)) === 1) return loc;
    }
    return null;
  }

  /** Coalesces state pushes to one page call per tick. */
  private push(): void {
    if (this.pushQueued) return;
    this.pushQueued = true;
    setImmediate(() => {
      this.pushQueued = false;
      void this.call("view", this.compose());
    });
  }

  resync(): void {
    this.push();
  }

  shutter(): void {
    if (this.run && !this.run.ended) void this.call("shutter");
  }

  // ---------- view ----------

  /** Quiet notes under the facts: what was fixed for free, what a model fixed, and every honesty label. */
  private notes(modelPhase: boolean): View["notes"] {
    const run = this.run;
    const out: View["notes"] = [];
    if (this.freeFixed.size > 0) out.push({ text: `${this.freeFixed.size} fixed free`, tick: true });
    const paid = new Map<string, number>();
    for (const r of this.paidFixed.values()) {
      const who =
        r === "open_weights" ? "Muse Spark Open" : r === "computer_use" ? "computer use" : "the rep";
      paid.set(who, (paid.get(who) ?? 0) + 1);
    }
    for (const [who, n] of paid) out.push({ text: `${n} by ${who}` });
    if (this.paced() > 0) out.push({ text: "Slowed for video" });
    if (run?.mode === "cu" && run.provider === "scripted") out.push({ text: "Scripted model (CI)" });
    else if (modelPhase && this.sim) out.push({ text: this.sim });
    return out;
  }

  private compose(): View {
    const run = this.run;
    const facts: View["facts"] = [];
    const base: View = {
      visible: run !== null,
      stage: "",
      model: "",
      clock: this.clock,
      cost: run ? this.baseCost + this.liveCost : null,
      facts,
      notes: [],
    };
    if (!run) return base;
    if (this.verified) {
      const v = this.verified;
      facts.push({ text: `${v.matched}/${v.checked} verified`, bad: v.matched !== v.checked });
    } else if (run.mode === "cu") {
      facts.push({ text: `${run.actions} action${run.actions === 1 ? "" : "s"}` });
    }
    if (run.ended) {
      return {
        ...base,
        stage: run.ended.stage,
        model: run.ended.model,
        ...(run.ended.modelId ? { modelId: true } : {}),
        ...(run.ended.fail ? { fail: true } : {}),
        notes: [...run.ended.notes, ...this.notes(false).filter((n) => n.text !== "Slowed for video")],
      };
    }
    const modelPhase = run.mode === "cu" || this.heal !== null;
    const notes = this.notes(modelPhase);
    if (this.waiting) return { ...base, stage: this.waiting.stage, model: this.waiting.model, notes };
    if (this.heal) {
      // The spotlight panel says which step; the strip only says who is working.
      return { ...base, stage: "Replay", model: this.heal.model, notes };
    }
    if (run.mode === "cu") {
      const what = run.purpose === "cu_repair" ? "Computer use repair" : "Computer use";
      return { ...base, stage: what, model: run.model, notes };
    }
    if (run.mode === "dry_run") {
      return run.label
        ? { ...base, stage: run.label, model: "never submitted", notes }
        : { ...base, stage: "Dry run", model: "test values, never submitted", notes };
    }
    return {
      ...base,
      stage: "Replay",
      model: `${this.calls} model call${this.calls === 1 ? "" : "s"}`,
      notes,
    };
  }

  private startClock(): void {
    this.clock = { startedAt: Date.now(), pausedMs: 0, pausedAt: null };
    this.clockHolds = 0;
  }

  private freezeClock(): void {
    if (this.clock) this.clock = { ...this.clock, frozenAt: Date.now() };
  }

  private resetCounters(): void {
    this.heal = null;
    this.waiting = null;
    this.baseCost = 0;
    this.liveCost = 0;
    this.calls = 0;
    this.verified = null;
    this.readbackSig = "";
    this.freeFixed.clear();
    this.paidFixed.clear();
    this.ladders.clear();
    this.lastStep = -1;
  }

  // ---------- replay (skills runner) ----------

  /** A replay or a dry run starts on this page. */
  runStart(o: { skill: Skill; dryRun?: boolean; label?: string }): void {
    this.run = {
      mode: o.dryRun ? "dry_run" : "replay",
      ...(o.label ? { label: o.label } : {}),
      portalId: o.skill.portalId,
      purpose: o.dryRun ? "dry_run" : "replay",
      model: "",
      provider: "",
      total: o.skill.steps.length,
      original: new Map(o.skill.steps.map((s) => [s.id, s])),
      idx: 0,
      actions: 0,
      ended: null,
    };
    this.resetCounters();
    this.startClock();
    void this.call("clear", true);
    this.push();
  }

  /** A step begins. */
  step(idx: number, steps: readonly Step[]): void {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    if (idx !== this.lastStep) {
      this.stepAt = performance.now();
      if (this.lastStep >= 0) void this.call("retire", "heal:", this.paced() > 0 ? 300 : 0);
      this.lastStep = idx;
    }
    run.idx = idx;
    run.total = steps.length;
    this.push();
  }

  /**
   * The step's element was found; the action is about to run. A free heal (another stored selector or the
   * fingerprint found it at once) leaves a quiet gray rule under the field and counts; the step gets the accent; the cursor
   * travels there. Awaited only when pacing is on.
   */
  async before(
    idx: number,
    step: Step,
    locator: Locator,
    outcome: { status: string; rung?: HealRung },
    _started: number,
  ): Promise<void> {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    run.idx = idx;
    const P = this.paced();
    if (
      outcome.status === "healed" &&
      (outcome.rung === "fallback" || outcome.rung === "similarity") &&
      !this.paidFixed.has(step.id)
    ) {
      if (!this.freeFixed.has(step.id)) {
        this.freeFixed.add(step.id);
        this.push();
      }
      void this.onElement(locator, "markOn", step.id, "free");
    }
    void this.onElement(locator, "activeOn");
    const glide = this.onElement(locator, "glideTo", P > 0 ? Math.min(760, Math.max(240, P * 0.6)) : 240);
    if (P > 0) await this.hold(P * 0.25, glide);
  }

  /** The step's action ran: a click ripple. */
  async after(idx: number, step: Step, locator: Locator): Promise<void> {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    run.idx = idx;
    const p = this.onElement(locator, "acted", {
      click: CLICKY_OPS.has(step.op),
      write: WRITE_OPS.has(step.op),
    });
    const P = this.paced();
    if (P > 0) await this.hold(P * 0.35, p);
  }

  /**
   * Read-back before the commit: a card lists every written field as read from the page, one row at a time,
   * and each visible field gets a check (or the error cross). A repeat of the same read-back (the commit step
   * was healed in between) is shown at once.
   */
  async verify(
    items: {
      stepId: string;
      locator: Locator;
      ok: boolean;
      label: string;
      expected: string;
      actual: string;
    }[],
  ): Promise<void> {
    if (!this.run || this.run.mode === "cu") return;
    const matched = items.filter((i) => i.ok).length;
    const sig = items.map((i) => `${i.stepId}:${i.ok ? 1 : 0}`).join(",");
    const again = sig === this.readbackSig;
    this.readbackSig = sig;
    this.verified = { matched, checked: items.length };
    this.push();
    const P = this.paced();
    const stepMs = again ? 0 : P > 0 ? Math.min(240, Math.max(130, P / 3)) : 90;
    const bad = items.length - matched;
    void this.call("activeOff");
    void this.call("readback", {
      title: "Read back from the page",
      sub:
        bad === 0
          ? `${matched} of ${items.length} fields match what the skill wrote`
          : `${bad} field${bad === 1 ? "" : "s"} do not match: nothing is submitted`,
      rows: items.map((i) => ({
        label: i.label,
        value: i.ok ? i.actual : clip(`${i.actual || "(empty)"} · expected ${i.expected}`, 60),
        ok: i.ok,
      })),
      stepMs,
      instant: again,
    } satisfies ReadbackView);
    await Promise.all(
      items.map((i, n) =>
        this.onElement(i.locator, "markOn", `rb:${i.stepId}`, i.ok ? "ok" : "bad", n * stepMs),
      ),
    );
    if (P > 0 && !again) await this.hold(stepMs * items.length + P);
  }

  /** The replay ended. With pacing on, holds the final state on screen for a moment. */
  async end(r: {
    outcome: string;
    extracted?: Record<string, string>;
    error?: string;
    errorCode?: string;
  }): Promise<void> {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    const id = Object.values(r.extracted ?? {})[0];
    const ends: Record<string, { stage: string; fail?: boolean }> = {
      success: { stage: "Submitted" },
      dry_run_ok: { stage: "Dry run passed" },
      rejected: { stage: "Not submitted" },
      expired: { stage: "Approval expired" },
      needs_input: { stage: "Needs the rep" },
      unknown: { stage: "Outcome unknown", fail: true },
      failed: { stage: "Stopped safely", fail: true },
    };
    const e = ends[r.outcome] ?? { stage: r.outcome, fail: true };
    const notes: View["notes"] = [];
    if (run.mode === "replay" && r.outcome === "success") {
      // The on-screen clock's time: pacing holds and the rep's approval waits are left out.
      const cu = CU_MEASURED[run.portalId ?? ""];
      if (cu) notes.push({ text: `Computer use, measured mean: ${cu.s} s, $${cu.usd.toFixed(2)}` });
    }
    const detail =
      id ??
      (r.outcome === "dry_run_ok"
        ? "never submitted"
        : r.errorCode
          ? r.errorCode.toLowerCase().replace(/_/g, " ")
          : r.outcome === "success"
            ? ""
            : clip(r.error ?? "", 40));
    run.ended = {
      stage: e.stage,
      model: detail,
      ...(id ? { modelId: true } : {}),
      ...(e.fail ? { fail: true } : {}),
      notes,
    };
    this.heal = null;
    this.waiting = null;
    for (const lad of this.ladders.values()) {
      if (lad.done) continue;
      void this.call("scrim", false);
      this.drawLadder(lad, {
        verified: { ok: false, text: "No rung fixed it: stopped safely, nothing submitted" },
      });
    }
    this.freezeClock();
    void this.call("activeOff");
    void this.call("readbackOff");
    void this.call("hideCursor");
    this.push();
    const hold = Math.max(this.paced() * 3, run.mode === "replay" ? this.endHold : 0);
    if (hold > 0) await this.hold(hold);
  }

  /** What `end` would show, for tests: the strip as composed now. */
  view(): View {
    return this.compose();
  }

  // ---------- computer use (loop) ----------

  cuStart(o: { model: string; provider: string; purpose: string }): void {
    const model = modelLabel(o.model, o.provider);
    this.lastCuModel = model;
    if (this.heal && this.run && !this.run.ended) {
      this.heal.model = model; // rung 3 inside a replay: same clock, same counters
      this.push();
      return;
    }
    this.run = {
      mode: "cu",
      purpose: o.purpose,
      model,
      provider: o.provider,
      total: 0,
      original: new Map(),
      idx: 0,
      actions: 0,
      ended: null,
    };
    this.resetCounters();
    this.startClock();
    void this.call("clear", true);
    this.push();
  }

  /** A model turn is about to be sent (the screenshot was just taken). */
  cuThinking(): void {
    if (!this.run) return;
    this.push();
  }

  /** A model turn came back. `costSoFar` is the session's ledger total when the caller knows it. */
  cuTurn(costSoFar?: number): void {
    if (!this.run) return;
    this.calls++;
    if (costSoFar !== undefined && Number.isFinite(costSoFar)) this.liveCost = costSoFar;
    this.push();
  }

  /** An action is about to run: cursor travel (never awaited). */
  cuAction(a: CuAction, pt: { x: number; y: number } | null, _target?: Target): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === "cu" && a.type !== "screenshot") run.actions++;
    this.push();
    if (pt) void this.call("glide", pt.x, pt.y, a.type === "scroll" ? 200 : 300);
  }

  /** The action ran: ripple for clicks, the accent on the field typed into. */
  cuActed(a: CuAction, pt: { x: number; y: number } | null, handle?: ElementHandle | null): void {
    if (!this.run) return;
    const pointerClick =
      (a.type === "click" && a.button !== "back" && a.button !== "forward") || a.type === "double_click";
    if (pt && pointerClick) {
      void this.call("ripple", pt.x, pt.y);
    } else if (pt && a.type === "scroll") {
      void this.call("hint", a.scroll_y > 0 ? "Scrolling down" : "Scrolling up", pt.x, pt.y, 800);
    } else if (a.type === "keypress") {
      void this.call("hintBottom", `Key: ${a.keys.join("+")}`, 800);
    }
    if (a.type === "type" && handle) {
      void this.onElement(handle, "activeOn");
    }
  }

  /** The harness refused a submit control without approval. */
  cuBlocked(info: { name: string; box: { x: number; y: number; w: number; h: number } }): void {
    if (!this.run) return;
    void this.call("outline", "blocked", { ...info.box, space: "view" }, {
      tone: "ground",
      dash: true,
      label: `Blocked: ‘${clip(info.name, 40)}’ submits`,
      sub: "Nothing is submitted without the rep’s tap",
    } satisfies OutlineOpts);
  }

  cuEnd(outcome: string, message?: string): void {
    const run = this.run;
    if (!run) return;
    if (run.mode !== "cu") {
      this.push();
      return; // a repair inside a replay: the replay's state carries on
    }
    const ok = outcome === "done";
    run.ended = {
      stage: ok ? "Computer use done" : outcome === "rejected" ? "Not submitted" : "Stopped",
      model: `${run.actions} action${run.actions === 1 ? "" : "s"}`,
      ...(ok ? {} : { fail: outcome !== "rejected" }),
      notes: [
        {
          text: ok
            ? "The trace compiles into a skill: next time 0 model calls"
            : clip(message ?? outcome, 70),
        },
      ],
    };
    this.freezeClock();
    void this.call("activeOff");
    void this.call("hideCursor");
    this.push();
  }

  // ---------- hooks (approvals, questions, the heal ladder) ----------

  /** Wraps the computer-use hooks: approval phases on screen. Idempotent. */
  wrapCuHooks<H extends CuHooks>(hooks: H): H {
    if ((hooks as unknown as Record<symbol, unknown>)[WRAPPED] === this) return hooks;
    const wrapped: H = {
      ...hooks,
      approveCommit: (r) => this.approval(r, (x) => hooks.approveCommit(x)),
      approveSafety: async (r) => {
        this.waiting = { stage: "Safety check", model: "waiting for the rep on WhatsApp" };
        this.push();
        this.pauseClock();
        try {
          return await hooks.approveSafety(r);
        } finally {
          this.resumeClock();
          this.waiting = null;
          this.push();
        }
      },
    };
    Object.defineProperty(wrapped, WRAPPED, { value: this, enumerable: false });
    return wrapped;
  }

  /** Wraps the replay hooks: approvals, ask-the-rep and every heal-ladder rung. Idempotent. */
  wrapRunHooks(hooks: RunHooks): RunHooks {
    if ((hooks as unknown as Record<symbol, unknown>)[WRAPPED] === this) return hooks;
    const base = this.wrapCuHooks(hooks);
    // which paid rungs exist in this run (a ladder shows the others as "not configured")
    this.avail = new Set(
      (hooks.repairers ?? []).flatMap((r) => {
        const g = (r as Repairer & { rung?: HealRung }).rung;
        return g ? [g] : [];
      }),
    );
    const wrapped: RunHooks = {
      ...base,
      ...(hooks.repairers ? { repairers: hooks.repairers.map((r) => this.wrapRepairer(r)) } : {}),
      ...(hooks.askRep
        ? { askRep: (q) => this.askRep(q, hooks.askRep as NonNullable<RunHooks["askRep"]>) }
        : {}),
    };
    Object.defineProperty(wrapped, WRAPPED, { value: this, enumerable: false });
    return wrapped;
  }

  /** Rung 4: the page needs data the skill has no value for. The new field gets the accent; the ladder says why. */
  private async askRep(
    q: Parameters<NonNullable<RunHooks["askRep"]>>[0],
    ask: NonNullable<RunHooks["askRep"]>,
  ): Promise<string | null> {
    const P = this.paced();
    this.waiting = { stage: "Asking the rep", model: "on WhatsApp" };
    this.push();
    void this.call("readbackOff");
    void this.call("activeOff");
    const field = this.page
      .getByRole("combobox", { name: q.label })
      .or(this.page.getByRole("textbox", { name: q.label }))
      .or(this.page.getByLabel(q.label))
      .first();
    void this.onElement(field, "outlineOn", "ask", {
      tone: "accent",
      hole: true,
      label: `New required field: ‘${clip(q.label, 36)}’`,
    } satisfies OutlineOpts);
    // No selector to fix, so the free and model rungs do not apply: new data comes from the rep.
    const na = (id: RungId): LadderRung => ({
      id,
      name: RUNG_NAME[id],
      status: "na",
      detail: "no selector to fix",
    });
    const lad: Ladder = {
      stepIdx: this.run?.idx ?? 0,
      name: q.label,
      why: "is new and required",
      done: false,
      rungs: [
        na("free"),
        na("open_weights"),
        na("computer_use"),
        { id: "ask_rep", name: RUNG_NAME.ask_rep, status: "trying", detail: "on WhatsApp" },
      ],
    };
    const draw = (verified?: SpotView["verified"]) =>
      void this.call("spot", {
        title: "The form needs new data",
        sub: `‘${clip(q.label, 40)}’ is now required; the skill has no value for it`,
        rungs: lad.rungs,
        ...(verified ? { verified } : {}),
      } satisfies SpotView);
    draw();
    const askedAt = Date.now();
    let answer: string | null = null;
    this.pauseClock();
    try {
      answer = await ask(q);
      return answer;
    } finally {
      this.resumeClock();
      const waited = secs(Date.now() - askedAt);
      lad.rungs[3] = {
        id: "ask_rep",
        name: RUNG_NAME.ask_rep,
        status: answer === null ? "fail" : "ok",
        detail: answer === null ? `no answer · ${waited}` : `“${clip(answer, 14)}” · ${waited}`,
      };
      lad.done = answer !== null;
      if (answer !== null) this.paidFixed.set(`ask:${q.label}`, "ask_rep");
      draw(
        answer === null
          ? { ok: false, text: "No answer: stopped safely" }
          : { ok: true, text: "Saved as a new parameter of the skill" },
      );
      this.waiting = null;
      this.push();
      const shown = P > 0 ? P * 2.5 : 1700;
      if (P > 0) await this.hold(shown);
      setTimeout(
        () => {
          void this.call("spotOff");
          void this.call("unbox", "ask");
        },
        P > 0 ? 0 : shown,
      ).unref?.();
    }
  }

  private async approval(
    r: Parameters<CuHooks["approveCommit"]>[0],
    ask: (r: Parameters<CuHooks["approveCommit"]>[0]) => Promise<Decision>,
  ): Promise<Decision> {
    const box = r.highlight ? { ...r.highlight, space: "view" as const } : null;
    this.waiting = { stage: "Waiting for approval", model: "on WhatsApp" };
    void this.call("unbox", "blocked");
    void this.call("activeOff");
    if (box) {
      void this.call("outline", "commit", box, {
        tone: "accent",
        label: "Submit waits for the rep’s tap",
        below: true,
      } satisfies OutlineOpts);
    }
    this.push();
    let d: Decision = "rejected";
    this.pauseClock();
    try {
      d = await ask(r);
      return d;
    } finally {
      this.resumeClock();
      this.waiting = null;
      this.push();
      void this.call("readbackOff");
      if (box) {
        void this.call(
          "outline",
          "commit",
          box,
          d === "approved"
            ? ({
                tone: "accent",
                below: true,
                label: "Approved on WhatsApp",
              } satisfies OutlineOpts)
            : ({
                tone: "gray",
                below: true,
                label: d === "edit" ? "The rep asked for changes: not submitted" : "Not submitted",
              } satisfies OutlineOpts),
        );
        if (d === "approved" && this.run && this.run.mode !== "cu") {
          const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
          const P = this.paced();
          const travel = this.call("glideClick", c.x, c.y, 320);
          if (P > 0) await this.hold(P * 0.5, travel);
        }
      }
    }
  }

  // ---------- heal ladder ----------

  private ladderFor(stepKey: string, stepIdx: number, name: string, why: string): Ladder {
    const known = this.ladders.get(stepKey);
    if (known) return known;
    const freeMs = this.stepAt ? performance.now() - this.stepAt - this.pausedSince(this.stepAt) : 0;
    const has = (r: HealRung) => this.avail.size === 0 || this.avail.has(r);
    const paid = (id: "open_weights" | "computer_use"): LadderRung => ({
      id,
      name: RUNG_NAME[id],
      status: has(id) ? "pending" : "off",
      detail: has(id) ? "" : "not configured",
    });
    const lad: Ladder = {
      stepIdx,
      name,
      why,
      done: false,
      rungs: [
        { id: "free", name: RUNG_NAME.free, status: "fail", detail: `${secs(freeMs)} · $0` },
        paid("open_weights"),
        paid("computer_use"),
        { id: "ask_rep", name: RUNG_NAME.ask_rep, status: "na", detail: "only for new data" },
      ],
    };
    this.ladders.set(stepKey, lad);
    return lad;
  }

  private rungState(lad: Ladder, rung: HealRung, status: LadderRung["status"], detail: string): void {
    const r = lad.rungs.find((x) => x.id === rungRow(rung));
    if (r) {
      r.status = status;
      r.detail = detail;
    }
  }

  private drawLadder(lad: Ladder, extra: Pick<SpotView, "pick" | "verified"> = {}): void {
    void this.call("spot", {
      title: `Repairing step ${lad.stepIdx + 1}`,
      sub: `‘${lad.name}’ ${lad.why}`,
      // Once a pick lands, only the rungs that ran: the panel stays short enough to clear the status strip.
      rungs: lad.rungs
        .filter((r) => !extra.pick || r.status === "fail" || r.status === "ok")
        .map(({ name, status, detail }) => ({ name, status, detail })),
      ...extra,
    } satisfies SpotView);
  }

  private wrapRepairer(inner: Repairer): Repairer {
    const tagged = (inner as Repairer & { rung?: HealRung }).rung;
    const wrapped: Repairer = async (req, hooks, ctx) => {
      const step = req.skill.steps[req.stepIdx];
      const name = nameOf(targetOf(step)?.fingerprint);
      const P = this.paced();
      const how = tagged
        ? tagged === "computer_use"
          ? this.lastCuModel
          : tagged === "open_weights"
            ? "Muse Spark Open"
            : "the next rung"
        : "the next rung";
      const why =
        req.error.code === "STEP_NOT_FOUND" || req.error.code === "STEP_TIMEOUT"
          ? "is no longer on the page"
          : req.error.code === "STEP_AMBIGUOUS"
            ? "matches more than one element"
            : "failed";
      // The spotlight: the page dims while the ladder climbs (computer use acts on the page, so it stays lit).
      const lad = this.ladderFor(step?.id ?? String(req.stepIdx), req.stepIdx, name, why);
      if (tagged)
        this.rungState(lad, tagged, "trying", tagged === "computer_use" ? "at most 8 actions" : "text only");
      void this.call("readbackOff");
      void this.call("activeOff");
      void this.call("scrim", tagged !== "computer_use");
      this.drawLadder(lad);
      if (this.run) this.run.idx = req.stepIdx;
      this.heal = { idx: req.stepIdx, ...(tagged ? { rung: tagged } : {}), model: how };
      this.push();
      if (P > 0) await this.hold(P * 1.8);
      const t0 = performance.now();
      const live0 = this.liveCost;
      let res: Awaited<ReturnType<Repairer>> | undefined;
      try {
        res = await inner(req, hooks, ctx);
        return res;
      } finally {
        const ms = performance.now() - t0 - this.pausedSince(t0);
        this.liveCost = live0;
        if (res) {
          this.baseCost += res.costUsd;
          if (
            res.rung === "open_weights" &&
            (res.ok ||
              res.costUsd > 0 ||
              /^(no match|low confidence|index|picked|the picked|model call)/.test(res.reason))
          )
            this.calls++;
        }
        const rung = res?.rung ?? tagged;
        const spent = `${this.latency(ms)} · ${money(res?.costUsd ?? 0)}`;
        if (rung) {
          const short = res && !res.ok ? ` · ${clip(res.reason.replace(/:.*$/, ""), 20)}` : "";
          this.rungState(lad, rung, res?.ok ? "ok" : "fail", res?.ok ? spent : `${spent}${short}`);
        }
        const healModel = this.heal?.model;
        if (!res?.ok) this.heal = null;
        if (res?.ok && step) {
          lad.done = true;
          for (const r of lad.rungs)
            if (r.status === "pending") Object.assign(r, { status: "na", detail: "not needed" });
          this.paidFixed.set(step.id, res.rung);
          this.freeFixed.delete(step.id);
          const { chosen, reason } =
            res.rung === "open_weights" ? parsePickNote(res.note) : { chosen: null, reason: "" };
          const fresh = targetOf(res.steps.at(-1));
          const label = chosen ?? (fresh ? nameOf(fresh.fingerprint) : "the replacement");
          const who = res.rung === "computer_use" ? (healModel ?? this.lastCuModel) : "Muse Spark Open";
          // Reveal: the element it picked, lit through the scrim with the accent.
          const loc = await this.locate(fresh);
          if (loc) {
            void this.call("scrim", true);
            void this.onElement(loc, "outlineOn", "heal:hole", {
              tone: "accent",
              hole: true,
              pad: 6,
            } satisfies OutlineOpts);
          }
          this.drawLadder(lad, {
            pick: {
              title: `${who} picked ‘${clip(label, 34)}’`,
              ...(reason ? { reason: spotlightReason(reason) } : {}),
              meta: res.rung === "open_weights" ? `${spent} · text only, no screenshot` : spent,
            },
          });
          this.push();
          if (P > 0) await this.hold(P * 6);
          this.drawLadder(lad, {
            pick: {
              title: `${who} picked ‘${clip(label, 34)}’`,
              ...(reason ? { reason: spotlightReason(reason) } : {}),
              meta: res.rung === "open_weights" ? `${spent} · text only, no screenshot` : spent,
            },
            verified: {
              ok: true,
              text:
                res.rung === "open_weights"
                  ? "Checked by code: same kind of control, exactly one match"
                  : `Step ${req.stepIdx + 1} now uses ‘${clip(label, 30)}’`,
            },
          });
          if (P > 0) await this.hold(P * 2.2);
          this.heal = null;
          const lift = () => {
            void this.call("scrim", false);
            void this.call("spotOff");
            void this.call("unbox", "heal:hole");
          };
          if (P > 0) lift();
          else setTimeout(lift, 1800).unref?.();
          this.push();
        } else {
          this.drawLadder(lad);
          this.push();
          if (P > 0) await this.hold(P);
        }
      }
    };
    return tagged ? Object.assign(wrapped, { rung: tagged }) : wrapped;
  }
}

export type { BBox as HudBBox, Box as HudBox, View as HudView };

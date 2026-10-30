// Node side of the demo overlay (DEMO_MODE only): a per-page observer that the pool attaches to every leased
// page, fed by small optional hooks in the skills runner and the computer-use loop. It only draws: it never
// changes what automation sees (see hud-page.js), every page call is best effort, and when pacing is on every
// second it waits is logged so the runner can leave it out of reported timings.

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

/** The in-page overlay. Installed with addInitScript on every leased context when the HUD is on. */
export const HUD_SCRIPT: string = readFileSync(new URL("./hud-page.js", import.meta.url), "utf8");
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
  /** META_MODE of the process: model phases carry a "Fake models"/"Cassette" tag unless it is live or record. */
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
type BoxTarget = Element | Box;
interface BoxOpts {
  tone: string;
  dashed?: boolean;
  halo?: boolean;
  label?: string;
  sub?: string;
  dark?: boolean;
  below?: boolean;
  pulse?: boolean;
  /** Label at the box's left edge (default: right edge, away from field labels). */
  left?: boolean;
  /** Fade out after this many ms. */
  ttl?: number;
}
interface HudPageApi {
  view(s: View): void;
  glide(x: number, y: number, ms?: number): Promise<void>;
  glideTo(target: BoxTarget, ms?: number): Promise<boolean>;
  ripple(x: number, y: number): void;
  rippleOn(target: BoxTarget): void;
  badge(target: BoxTarget, key: string, kind: "filled" | "ok" | "bad", note?: string): void;
  glow(target: BoxTarget, color?: string, ms?: number): void;
  box(key: string, target: BoxTarget, o: BoxOpts): void;
  dim(key: string, on: boolean): void;
  link(key: string, from: string, to: string, tone?: string): void;
  hint(text: string, x: number, y: number, ms?: number): void;
  shutter(): void;
  clear(all?: boolean): void;
  unbox(key: string): void;
  hideCursor(): void;
  boxOn(target: Element, key: string, o: BoxOpts): void;
  acted(target: Element, o: { click: boolean; write: boolean; key: string }): void;
  glideClick(x: number, y: number, ms?: number): Promise<void>;
  hintBottom(text: string, ms?: number): void;
  pillOn(target: Element, key: string, text: string, tone: string): void;
  ladder(key: string, target: BoxTarget, st: unknown): void;
  ladderOn(target: Element, key: string, st: unknown): void;
  ladderCollapse(key: string, toKey: string, delay?: number): void;
  retire(prefix: string, ms?: number): void;
}
type Method = keyof HudPageApi;

declare global {
  interface Window {
    __dockhandHud?: HudPageApi;
  }
}

type Tone = "cu" | "replay" | "heal" | "dry" | "wait" | "done" | "fail" | "idle";
type TagKind = "slow" | "sim" | "ok" | "bad";
interface View {
  visible: boolean;
  tone: Tone;
  title: string;
  detail: string;
  step: string;
  ticker: string;
  clock: { startedAt: number; pausedMs: number; pausedAt: number | null; frozenAt?: number } | null;
  cost: number | null;
  calls: number | null;
  tags: { kind: TagKind; text: string }[];
  pulse: boolean;
}

// ---------- labels ----------

const RUNG_NO: Record<HealRung, number> = {
  fallback: 1,
  similarity: 1,
  open_weights: 2,
  computer_use: 3,
  ask_rep: 4,
};
const RUNG_HOW: Record<HealRung, string> = {
  fallback: "stored fallback selector",
  similarity: "fingerprint match",
  open_weights: "Muse Spark Open",
  computer_use: "Muse computer use",
  ask_rep: "asked the rep",
};
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

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function secs(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;
}

function money(usd: number): string {
  return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function docBox(b: BBox | undefined): Box | null {
  return b && (b.w > 0 || b.h > 0) ? { x: b.x, y: b.y, w: b.w, h: b.h, space: "doc" } : null;
}

const WRITE_OPS = new Set(["fill", "select", "check", "upload"]);
const CLICKY_OPS = new Set(["click", "fill", "select", "check"]);

function stepVerb(step: Step): string {
  const name = nameOf(targetOf(step)?.fingerprint);
  switch (step.op) {
    case "goto":
      return `Open ${step.url.replace(/^https?:\/\/[^/]+/, "") || "/"}`;
    case "click":
      return `Click '${name}'`;
    case "fill":
      return `Fill '${name}'`;
    case "select":
      return `Choose in '${name}'`;
    case "check":
      return `${step.checked ? "Tick" : "Untick"} '${name}'`;
    case "upload":
      return `Attach a file to '${name}'`;
    case "press":
      return `Press ${step.key}`;
    case "waitFor":
      return "Wait for the page";
    case "extract":
      return `Read ${step.name} from the page`;
  }
}

function describeCuAction(a: CuAction, target?: Target): string {
  const name = target ? `'${nameOf(target.fingerprint)}'` : "";
  switch (a.type) {
    case "click":
      return a.button === "back"
        ? "Go back"
        : a.button === "forward"
          ? "Go forward"
          : `Click ${name || `(${a.x}, ${a.y})`}`;
    case "double_click":
      return `Double-click ${name || `(${a.x}, ${a.y})`}`;
    case "type":
      return `Type “${clip(a.text.replace(/\s+/g, " "), 42)}”${name ? ` into ${name}` : ""}`;
    case "keypress":
      return `Press ${a.keys.join("+")}`;
    case "scroll":
      return `Scroll ${a.scroll_y > 0 ? "down" : a.scroll_y < 0 ? "up" : "sideways"}`;
    case "move":
      return `Point at ${name || `(${a.x}, ${a.y})`}`;
    case "drag":
      return "Drag";
    case "wait":
      return "Wait for the page";
    case "screenshot":
      return "Look at the screen";
    default:
      return "Act";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type RungId = "free" | "open_weights" | "computer_use" | "ask_rep";
interface LadderRung {
  id: RungId;
  name: string;
  status: "pending" | "trying" | "fail" | "ok" | "off" | "na";
  detail: string;
}
/** The heal ladder drawn next to a broken step: every rung, lit as it is tried. */
interface Ladder {
  key: string;
  stepIdx: number;
  anchor: Box | null;
  rungs: LadderRung[];
  done: boolean;
  foot?: string;
}
/** The ladder row a heal rung belongs to (both free rungs share the first row). */
const rungRow = (r: HealRung): RungId => (r === "fallback" || r === "similarity" ? "free" : r);
const RUNG_ROW: Record<RungId, string> = {
  free: "Free · stored selectors, similarity",
  open_weights: "Muse Spark Open",
  computer_use: "Muse computer use",
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
  ended: { tone: Tone; title: string; detail: string; ticker: string } | null;
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
  private heal: { idx: number; rung?: HealRung; model: string; stepId?: string } | null = null;
  private waiting: { title: string; ticker: string } | null = null;
  private clock: View["clock"] = null;
  private baseCost = 0;
  private liveCost = 0;
  private calls = 0;
  private verified: { matched: number; checked: number } | null = null;
  private ticker = "";
  private readonly pauses: { start: number; end: number }[] = [];
  private pushQueued = false;
  private lastCuModel = "Muse computer use";
  private readonly fixes = new Map<string, { label: string; sub?: string; rung?: HealRung }>();
  private lastStep = -1;
  private clockHolds = 0;
  private clockHoldStart = 0;
  private typed = 0;
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
    this.sim = mode === "fake" ? "Fake models" : mode === "cassette" ? "Cassette replay" : null;
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

  private compose(): View {
    const run = this.run;
    const tags: View["tags"] = [];
    const base: View = {
      visible: run !== null,
      tone: "idle",
      title: "",
      detail: "",
      step: "",
      ticker: this.ticker,
      clock: this.clock,
      cost: run ? this.baseCost + this.liveCost : null,
      calls: null,
      tags,
      pulse: false,
    };
    if (!run) return base;
    if (run.mode === "cu") base.step = `Action ${run.actions}`;
    else base.step = `Step ${Math.min(run.idx + 1, run.total)}/${run.total}`;
    if (this.paced() > 0) tags.push({ kind: "slow", text: "Slowed for video" });
    if (this.verified) {
      const v = this.verified;
      tags.push({ kind: v.matched === v.checked ? "ok" : "bad", text: `${v.matched}/${v.checked} verified` });
    }
    if (run.ended) {
      return {
        ...base,
        tone: run.ended.tone,
        title: run.ended.title,
        detail: run.ended.detail,
        ticker: run.ended.ticker,
        calls: run.mode === "cu" || this.calls > 0 ? this.calls : null,
      };
    }
    const modelPhase = run.mode === "cu" || this.heal !== null;
    if (modelPhase && this.sim && !(run.mode === "cu" && run.provider === "scripted")) {
      tags.push({ kind: "sim", text: this.sim });
    }
    if (run.mode === "cu" && run.provider === "scripted") tags.push({ kind: "sim", text: "Scripted (CI)" });
    if (this.waiting) {
      return { ...base, tone: "wait", title: this.waiting.title, ticker: this.waiting.ticker, pulse: true };
    }
    if (this.heal) {
      const rung = this.heal.rung ? `rung ${RUNG_NO[this.heal.rung]} · ` : "";
      return {
        ...base,
        tone: "heal",
        title: "Healing",
        detail: `${rung}${this.heal.model}`,
        calls: this.calls,
      };
    }
    if (run.mode === "cu") {
      const what = run.purpose === "cu_repair" ? "repair" : "first run";
      return {
        ...base,
        tone: "cu",
        title: "Computer use",
        detail: `${what} · ${run.model}`,
        calls: this.calls,
      };
    }
    if (run.mode === "dry_run") {
      return { ...base, tone: "dry", title: run.label ?? "Dry run", detail: "canary, stops before submit" };
    }
    return {
      ...base,
      tone: "replay",
      title: "Replay",
      detail: `${this.calls} model call${this.calls === 1 ? "" : "s"}`,
    };
  }

  private startClock(): void {
    this.clock = { startedAt: Date.now(), pausedMs: 0, pausedAt: null };
    this.clockHolds = 0;
  }

  private freezeClock(): void {
    if (this.clock) this.clock = { ...this.clock, frozenAt: Date.now() };
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
    this.heal = null;
    this.waiting = null;
    this.baseCost = 0;
    this.liveCost = 0;
    this.calls = 0;
    this.verified = null;
    this.fixes.clear();
    this.ladders.clear();
    this.lastStep = -1;
    this.ticker = `${o.skill.title} · v${o.skill.version}`;
    this.startClock();
    void this.call("clear", true);
    this.push();
  }

  /** A step begins: counter and ticker. */
  step(idx: number, steps: readonly Step[]): void {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    const step = steps[idx];
    if (idx !== this.lastStep) {
      this.stepAt = performance.now();
      if (this.lastStep >= 0) void this.call("retire", "heal:", this.paced() > 0 ? 500 : 900);
      this.lastStep = idx;
    }
    run.idx = idx;
    run.total = steps.length;
    if (step) this.ticker = clip(step.intent || stepVerb(step), 90);
    this.push();
  }

  /**
   * The step's element was found; the action is about to run. Shows free heals (another stored selector or a
   * fingerprint match) and travels the cursor there. Awaited only when pacing is on.
   */
  async before(
    idx: number,
    step: Step,
    locator: Locator,
    outcome: { status: string; rung?: HealRung },
    started: number,
  ): Promise<void> {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    const P = this.paced();
    let heldForHeal = 0;
    if (outcome.status === "healed" && outcome.rung && !this.fixes.has(step.id)) {
      // A free rung: the recorded selector missed, another stored one (or the fingerprint) found it at once.
      const rung = outcome.rung;
      const ms = performance.now() - started - this.pausedSince(started);
      const label = `Healed · rung ${RUNG_NO[rung]} · ${RUNG_HOW[rung]} · ${secs(ms)} · $0`;
      this.fixes.set(step.id, { label });
      this.ticker = `Step ${idx + 1}: the recorded selector for '${nameOf(targetOf(run.original.get(step.id))?.fingerprint)}' missed. ${label}`;
      this.push();
      await this.onElement(locator, "boxOn", `heal:fix:${step.id}`, {
        tone: "heal",
        halo: true,
        label,
        sub: "the recorded selector no longer matched",
      });
      void this.onElement(locator, "pillOn", step.id, `rung ${RUNG_NO[rung]}`, "heal");
      heldForHeal = P * 1.6;
    } else if (this.fixes.has(step.id)) {
      // A paid rung fixed this step: anchor its label on the element the replacement step really uses.
      const fix = this.fixes.get(step.id);
      void this.onElement(locator, "boxOn", `heal:fix:${step.id}`, {
        tone: "done",
        halo: true,
        label: fix?.label ?? "Fixed",
        ...(fix?.sub ? { sub: fix.sub } : {}),
      });
      if (fix?.rung) void this.onElement(locator, "pillOn", step.id, `rung ${RUNG_NO[fix.rung]}`, "heal");
    }
    if (heldForHeal > 0) await this.hold(heldForHeal);
    const glide = this.onElement(locator, "glideTo", P > 0 ? Math.min(760, Math.max(240, P * 0.6)) : 240);
    if (P > 0) await this.hold(P * 0.25, glide);
  }

  /** The step's action ran: click ripple, "filled" badge on written fields. */
  async after(idx: number, step: Step, locator: Locator): Promise<void> {
    const run = this.run;
    if (!run || run.mode === "cu") return;
    run.idx = idx;
    const write = WRITE_OPS.has(step.op);
    const p = this.onElement(locator, "acted", { click: CLICKY_OPS.has(step.op), write, key: step.id });
    const P = this.paced();
    if (P > 0) await this.hold(P * 0.35, p);
  }

  /** Read-back before the commit: every written field gets a green check, or red with what was found. */
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
    this.verified = { matched, checked: items.length };
    this.ticker = `Read-back before submit: ${matched}/${items.length} fields match`;
    this.push();
    const P = this.paced();
    const gap = P > 0 ? Math.min(140, Math.max(60, P / 6)) : 0;
    for (const i of items) {
      const note = i.ok ? "" : clip(`Expected “${i.expected}” · read back “${i.actual}”`, 80);
      const p = this.onElement(i.locator, "badge", i.stepId, i.ok ? "ok" : "bad", note);
      if (gap > 0) await this.hold(gap, p);
    }
    if (P > 0) await this.hold(P);
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
    const v = this.verified;
    const verified = v ? `${v.matched}/${v.checked} fields verified` : "";
    const ends: Record<string, { tone: Tone; title: string }> = {
      success: { tone: "done", title: "Submitted" },
      dry_run_ok: { tone: "done", title: "Dry run passed" },
      rejected: { tone: "fail", title: "Not submitted" },
      expired: { tone: "fail", title: "Approval expired" },
      needs_input: { tone: "wait", title: "Needs the rep" },
      unknown: { tone: "fail", title: "Outcome unknown" },
      failed: { tone: "fail", title: "Stopped safely" },
    };
    const e = ends[r.outcome] ?? { tone: "fail" as Tone, title: r.outcome };
    let ticker =
      r.outcome === "success" || r.outcome === "dry_run_ok"
        ? verified || "Every step matched"
        : clip(r.error ?? "", 110);
    if (run.mode === "replay" && r.outcome === "success" && this.clock) {
      // The on-screen clock's time: pacing holds and the rep's approval waits are left out.
      const c = this.clock;
      const ms = Date.now() - c.startedAt - c.pausedMs - (c.pausedAt !== null ? Date.now() - c.pausedAt : 0);
      const spent = this.baseCost + this.liveCost;
      const cu = CU_MEASURED[run.portalId ?? ""];
      // The verified count is already on the tag beside it; the line keeps to what fits the overlay.
      ticker = [
        `This run: ${secs(ms)}, ${spent > 0 ? money(spent) : "$0"} in model calls`,
        cu ? `computer use, measured mean: ${cu.s} s, $${cu.usd.toFixed(2)}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
    }
    run.ended = {
      ...e,
      detail: id ?? (r.errorCode ? r.errorCode.toLowerCase().replace(/_/g, " ") : verified),
      ticker,
    };
    this.heal = null;
    this.waiting = null;
    for (const lad of this.ladders.values()) {
      if (lad.done) continue;
      lad.foot = "No rung fixed it: stopped safely, nothing submitted";
      this.drawLadder(lad);
    }
    this.freezeClock();
    void this.call("hideCursor");
    this.push();
    const hold = Math.max(this.paced() * 3, run.mode === "replay" ? this.endHold : 0);
    if (hold > 0) await this.hold(hold);
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
    this.waiting = null;
    this.baseCost = 0;
    this.liveCost = 0;
    this.calls = 0;
    this.verified = null;
    this.ticker = "";
    this.startClock();
    void this.call("clear", true);
    this.push();
  }

  /** A model turn is about to be sent (the screenshot was just taken). */
  cuThinking(): void {
    if (!this.run) return;
    const who = this.run.mode === "cu" ? this.run.model : (this.heal?.model ?? this.lastCuModel);
    this.ticker = `${who} is looking at the screen…`;
    this.push();
  }

  /** A model turn came back. `costSoFar` is the session's ledger total when the caller knows it. */
  cuTurn(costSoFar?: number): void {
    if (!this.run) return;
    this.calls++;
    if (costSoFar !== undefined && Number.isFinite(costSoFar)) this.liveCost = costSoFar;
    this.push();
  }

  /** An action is about to run: ticker and cursor travel (never awaited). */
  cuAction(a: CuAction, pt: { x: number; y: number } | null, target?: Target): void {
    const run = this.run;
    if (!run) return;
    if (run.mode === "cu" && a.type !== "screenshot") run.actions++;
    this.ticker = describeCuAction(a, target);
    this.push();
    if (pt) void this.call("glide", pt.x, pt.y, a.type === "scroll" ? 200 : 300);
  }

  /** The action ran: ripple for clicks, "filled" badge on the field typed into. */
  cuActed(a: CuAction, pt: { x: number; y: number } | null, handle?: ElementHandle | null): void {
    if (!this.run) return;
    const pointerClick =
      (a.type === "click" && a.button !== "back" && a.button !== "forward") || a.type === "double_click";
    if (pt && pointerClick) {
      void this.call("ripple", pt.x, pt.y);
    } else if (pt && a.type === "scroll") {
      void this.call("hint", a.scroll_y > 0 ? "Scroll ↓" : "Scroll ↑", pt.x, pt.y, 900);
    } else if (a.type === "keypress") {
      void this.call("hintBottom", `Key: ${a.keys.join("+")}`, 900);
    }
    if (a.type === "type" && handle) {
      void this.onElement(handle, "acted", { click: false, write: true, key: `cu${++this.typed}` });
    }
  }

  /** The harness refused a submit control without approval. */
  cuBlocked(info: { name: string; box: { x: number; y: number; w: number; h: number } }): void {
    if (!this.run) return;
    void this.call(
      "box",
      "blocked",
      { ...info.box, space: "view" },
      {
        tone: "fail",
        dark: true,
        label: `Blocked: '${clip(info.name, 40)}' submits`,
        sub: "Nothing is submitted without the rep's tap",
      },
    );
  }

  cuEnd(outcome: string, message?: string): void {
    const run = this.run;
    if (!run) return;
    if (run.mode !== "cu") {
      this.ticker = "";
      this.push();
      return; // a repair inside a replay: the replay's state carries on
    }
    const ok = outcome === "done";
    run.ended = {
      tone: ok ? "done" : "fail",
      title: ok ? "Computer use done" : outcome === "rejected" ? "Not submitted" : "Stopped",
      detail: `${run.actions} action${run.actions === 1 ? "" : "s"}`,
      ticker: ok
        ? "The trace compiles into a skill: next time replays with 0 model calls"
        : clip(message ?? outcome, 110),
    };
    this.freezeClock();
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
        this.waiting = {
          title: "Safety check · waiting for approval on WhatsApp",
          ticker: clip(r.checks.map((c) => c.message).join(" · "), 110),
        };
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
        ? {
            askRep: async (q) => {
              const ask = hooks.askRep as NonNullable<RunHooks["askRep"]>;
              this.waiting = {
                title: "Asking the rep on WhatsApp",
                ticker: `The page now requires '${q.label}', which the skill has no value for`,
              };
              this.push();
              const field = this.page
                .getByRole("combobox", { name: q.label })
                .or(this.page.getByRole("textbox", { name: q.label }))
                .or(this.page.getByLabel(q.label))
                .first();
              void this.onElement(field, "boxOn", "ask", {
                tone: "wait",
                label: `New required field · '${clip(q.label, 40)}'`,
                sub: "Rung 4: asked the rep on WhatsApp",
                pulse: true,
              });
              // The ladder for new data: no selector to fix, so the free and model rungs do not apply.
              const na = "n/a · new field";
              const askLadder: Ladder = {
                key: `heal:ladder:ask:${q.label}`,
                stepIdx: this.run?.idx ?? 0,
                anchor: null,
                done: false,
                rungs: [
                  { id: "free", name: RUNG_ROW.free, status: "na", detail: na },
                  { id: "open_weights", name: RUNG_ROW.open_weights, status: "na", detail: na },
                  { id: "computer_use", name: RUNG_ROW.computer_use, status: "na", detail: na },
                  { id: "ask_rep", name: RUNG_ROW.ask_rep, status: "trying", detail: "asking on WhatsApp…" },
                ],
              };
              const drawAsk = () =>
                void this.onElement(field, "ladderOn", askLadder.key, this.ladderView(askLadder));
              drawAsk();
              const askedAt = Date.now();
              let answer: string | null = null;
              this.pauseClock();
              try {
                answer = await ask(q);
                return answer;
              } finally {
                this.resumeClock();
                const waited = secs(Date.now() - askedAt);
                askLadder.rungs[3] = {
                  id: "ask_rep",
                  name: RUNG_ROW.ask_rep,
                  status: answer === null ? "fail" : "ok",
                  detail: answer === null ? `no answer · ${waited}` : `“${clip(answer, 14)}” · ${waited}`,
                };
                askLadder.done = answer !== null;
                drawAsk();
                if (answer !== null) void this.call("ladderCollapse", askLadder.key, "ask", 1700);
                this.waiting = null;
                this.push();
                void this.onElement(field, "boxOn", "ask", {
                  tone: answer === null ? "fail" : "done",
                  halo: true,
                  label:
                    answer === null
                      ? `No answer for '${clip(q.label, 40)}'`
                      : `Rep answered “${clip(answer, 30)}”`,
                  sub:
                    answer === null
                      ? "Stopped safely"
                      : "Fixed · rung 4 · asked the rep · saved as a new param",
                });
              }
            },
          }
        : {}),
    };
    Object.defineProperty(wrapped, WRAPPED, { value: this, enumerable: false });
    return wrapped;
  }

  private async approval(
    r: Parameters<CuHooks["approveCommit"]>[0],
    ask: (r: Parameters<CuHooks["approveCommit"]>[0]) => Promise<Decision>,
  ): Promise<Decision> {
    const box = r.highlight ? { ...r.highlight, space: "view" as const } : null;
    const v = this.verified;
    this.waiting = {
      title: "Waiting for approval on WhatsApp",
      ticker: clip(
        [
          v ? `${v.matched}/${v.checked} fields verified` : "",
          r.summary,
          "clock paused while the rep decides",
        ]
          .filter(Boolean)
          .join(" · "),
        110,
      ),
    };
    void this.call("unbox", "blocked");
    if (box) {
      void this.call("box", "commit", box, {
        tone: "wait",
        label: "Submit waits for the rep's tap on WhatsApp",
        pulse: true,
        below: true,
      });
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
      if (box) {
        void this.call(
          "box",
          "commit",
          box,
          d === "approved"
            ? { tone: "done", halo: true, below: true, label: "Approved on WhatsApp · submitting" }
            : {
                tone: "fail",
                below: true,
                label: d === "edit" ? "The rep asked for changes · not submitted" : `Not submitted (${d})`,
              },
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

  private ladderFor(stepKey: string, stepIdx: number, anchor: Box | null): Ladder {
    const known = this.ladders.get(stepKey);
    if (known) return known;
    const freeMs = this.stepAt ? performance.now() - this.stepAt - this.pausedSince(this.stepAt) : 0;
    const has = (r: HealRung) => this.avail.size === 0 || this.avail.has(r);
    const paid = (id: "open_weights" | "computer_use"): LadderRung => ({
      id,
      name: RUNG_ROW[id],
      status: has(id) ? "pending" : "off",
      detail: has(id) ? "" : "not configured",
    });
    const lad: Ladder = {
      key: `heal:ladder:${stepKey}`,
      stepIdx,
      anchor,
      done: false,
      rungs: [
        { id: "free", name: RUNG_ROW.free, status: "fail", detail: `${secs(freeMs)} · $0` },
        paid("open_weights"),
        paid("computer_use"),
        { id: "ask_rep", name: RUNG_ROW.ask_rep, status: "na", detail: "only for new data" },
      ],
    };
    this.ladders.set(stepKey, lad);
    return lad;
  }

  private rungState(lad: Ladder, rung: HealRung, status: LadderRung["status"], detail: string): void {
    const id = rungRow(rung);
    const r = lad.rungs.find((x) => x.id === id);
    if (r) {
      r.status = status;
      r.detail = detail;
    }
  }

  private rungName(lad: Ladder, rung: HealRung, name: string): void {
    const id = rungRow(rung);
    const r = lad.rungs.find((x) => x.id === id);
    if (r) r.name = name;
  }

  private ladderView(lad: Ladder): { title: string; rungs: LadderRung[]; foot?: string; footOk: boolean } {
    return {
      title: `Heal ladder · step ${lad.stepIdx + 1}`,
      rungs: lad.rungs,
      ...(lad.foot ? { foot: lad.foot } : {}),
      footOk: lad.done,
    };
  }

  private drawLadder(lad: Ladder): void {
    const anchor = lad.anchor ?? { x: 24, y: 330, w: 1, h: 1, space: "view" as const };
    void this.call("ladder", lad.key, anchor, this.ladderView(lad));
  }

  private wrapRepairer(inner: Repairer): Repairer {
    const tagged = (inner as Repairer & { rung?: HealRung }).rung;
    const wrapped: Repairer = async (req, hooks, ctx) => {
      const step = req.skill.steps[req.stepIdx];
      const old = targetOf(step);
      const name = nameOf(old?.fingerprint);
      const P = this.paced();
      const brokenKey = `heal:broken:${step?.id ?? req.stepIdx}`;
      const how = tagged
        ? tagged === "computer_use"
          ? this.lastCuModel
          : RUNG_HOW[tagged]
        : "the next rung";
      const rungText = tagged ? `rung ${RUNG_NO[tagged]} · ${how}` : how;
      const why =
        req.error.code === "STEP_NOT_FOUND" || req.error.code === "STEP_TIMEOUT"
          ? "not found"
          : req.error.code === "STEP_AMBIGUOUS"
            ? "is ambiguous"
            : "failed";
      const oldBox = docBox(old?.fingerprint.bbox);
      if (oldBox) {
        void this.call("box", brokenKey, oldBox, {
          tone: "fail",
          dashed: true,
          dark: true,
          label: `Step ${req.stepIdx + 1} · '${name}' ${why}`,
        });
      }
      // The ladder: free rungs already failed (that is why we are here); this rung lights up as it runs.
      const lad = this.ladderFor(step?.id ?? String(req.stepIdx), req.stepIdx, oldBox);
      if (tagged) this.rungState(lad, tagged, "trying", "trying…");
      this.drawLadder(lad);
      void rungText;
      if (this.run) this.run.idx = req.stepIdx;
      this.heal = {
        idx: req.stepIdx,
        ...(tagged ? { rung: tagged } : {}),
        model: how,
        ...(step ? { stepId: step.id } : {}),
      };
      this.ticker = `'${name}' ${why}: ${tagged === "open_weights" ? "Muse Spark Open picks the element from the page's accessibility list (text only)" : tagged === "computer_use" ? "computer use with a narrow goal, at most 8 actions" : "trying the next rung"}`;
      this.push();
      if (P > 0) await this.hold(P * 1.6);
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
        const label = rung
          ? `rung ${RUNG_NO[rung]} · ${rung === "computer_use" ? (this.heal?.model ?? how) : RUNG_HOW[rung]}`
          : how;
        if (rung) {
          const spent = `${secs(ms)} · ${money(res?.costUsd ?? 0)}`;
          const why2 = res && !res.ok ? ` · ${clip(res.reason.replace(/:.*$/, ""), 18)}` : "";
          this.rungState(lad, rung, res?.ok ? "ok" : "fail", res?.ok ? spent : `${spent}${why2}`);
          if (rung === "computer_use" && this.heal?.model)
            this.rungName(lad, rung, `${this.heal.model} · computer use`);
        }
        if (res?.ok) lad.done = true;
        this.drawLadder(lad);
        if (res?.ok && step) {
          // collapse into the "Fixed · rung N" label once the viewer has read the ladder
          void this.call("ladderCollapse", lad.key, `heal:fix:${step.id}`, P > 0 ? P * 1.3 : 1700);
        }
        this.heal = null;
        if (res?.ok && step) {
          const fixLabel = `Fixed · ${label} · ${secs(ms)} · ${money(res.costUsd)}`;
          this.fixes.set(step.id, {
            label: fixLabel,
            sub: res.note ? clip(res.note, 70) : "",
            rung: res.rung,
          });
          const fresh = targetOf(res.steps.at(-1));
          const freshBox = docBox(fresh?.fingerprint.bbox);
          if (oldBox) {
            void this.call("box", brokenKey, oldBox, {
              tone: "fail",
              dashed: true,
              dark: true,
              label: `Step ${req.stepIdx + 1} · '${name}' ${why}`,
            });
          }
          const near =
            oldBox &&
            freshBox &&
            Math.hypot(
              oldBox.x + oldBox.w / 2 - freshBox.x - freshBox.w / 2,
              oldBox.y + oldBox.h / 2 - freshBox.y - freshBox.h / 2,
            ) < 40;
          if (near) void this.call("unbox", brokenKey);
          if (freshBox) {
            void this.call("box", `heal:fix:${step.id}`, freshBox, {
              tone: "done",
              halo: true,
              label: fixLabel,
              ...(res.note ? { sub: clip(res.note, 70) } : {}),
            });
            if (oldBox)
              void this.call("link", `heal:link:${step.id}`, brokenKey, `heal:fix:${step.id}`, "heal");
          }
          this.ticker = `${fixLabel}. Continuing the replay`;
          this.push();
          if (P > 0) await this.hold(P * 2);
        } else {
          const reason = res && !res.ok ? res.reason : "the rung failed";
          if (oldBox) {
            void this.call("box", brokenKey, oldBox, {
              tone: "fail",
              dashed: true,
              dark: true,
              label: `Step ${req.stepIdx + 1} · '${name}' ${why}`,
              sub: clip(`${label}: ${reason}`, 80),
            });
          }
          this.ticker = clip(`${label}: ${reason}`, 110);
          this.push();
          if (P > 0) await this.hold(P);
        }
      }
    };
    return tagged ? Object.assign(wrapped, { rung: tagged }) : wrapped;
  }
}

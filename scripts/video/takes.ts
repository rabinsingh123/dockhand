// The recording session, take by take. Each take sets the stage (portal version or UI change, pacing,
// EspoCRM), then waits for Rabin on his phone (live) or plays him through the emulator (rehearsal), and is done
// when Dockhand's last message for it has arrived. The order follows demo:check's, so a cassette rehearsal sends
// exactly the model requests the tapes were recorded from. Phone steps here are the source for the cue screen
// and the session PDF: keep them literal (button titles as they appear on the cards).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { World } from "../../apps/gateway/src/demo-check.ts";
import { workspaceRoot } from "../../packages/core/src/index.ts";
import type { ChatEntry } from "../../packages/whatsapp/src/index.ts";
import type { Msg } from "./lib/events.ts";

export type Mode = "live" | "cassette" | "fake";

export type TakeId =
  | "check"
  | "teach"
  | "use"
  | "hero"
  | "ask"
  | "overnight"
  | "supplier"
  | "supplier2"
  | "quote"
  | "espocrm"
  | "vn1"
  | "vn3";

export interface TakeCtx {
  mode: Mode;
  base: string;
  partner: string;
  dbPath: string;
  log(line: string): void;
  /** POST JSON to a local URL; throws on a non-2xx answer. */
  post(url: string, body?: unknown): Promise<unknown>;
  /** Rehearsal only: the emulator rep and demo:check's world. */
  world?: World;
  /** EspoCRM: started, drifts applied, the compiled lead skill active, the gateway knows ESPOCRM_URL. */
  prepareEspo(): Promise<void>;
  /** Runs demo:check steps by name (rehearsal). */
  steps(...names: string[]): Promise<void>;
}

export interface CameraShot {
  view: "code" | "pick";
  /** Path under the gateway, e.g. /recorder/skills/x/code?v=1 */
  path: string;
  label: string;
}

/** Speed-up for the cut: from the first event matching `from` to the first after it matching `to`. */
export interface SpeedRule {
  from: { kind: "run_start"; mode: string } | { kind: "out"; text: RegExp };
  to: { kind: "gate"; gateKind: string } | { kind: "out"; text: RegExp };
  factor: number;
}

export interface Take {
  id: TakeId;
  title: string;
  shot: string;
  /** Live extras: unrehearsed, footage optional. */
  optional?: boolean;
  modes: Mode[];
  pacingMs: number;
  /** One line on what the director changes before Rabin acts (shown on the cue screen). */
  director: string;
  /** Rabin's steps on the phone, literal. */
  phone: string[];
  /** The answer to a question card, if any (cue screen: "tap Gold"). */
  answer?: string;
  /** Live: about this long, minutes (cue screen and PDF). */
  approxMin: number;
  setup(c: TakeCtx): Promise<void>;
  /** Rehearsal: the emulator plays Rabin. */
  rehearse(c: TakeCtx): Promise<void>;
  /** Done once Dockhand's last message for the take has arrived (messages since the take was ready). */
  done(msgs: Msg[], now: number): boolean;
  camera?(
    c: TakeCtx,
    ctx: { since: number; skills: Record<string, number>; pick: string | null },
  ): CameraShot[];
  speed?: SpeedRule[];
}

const root = workspaceRoot();
const fixture = (...p: string[]) => join(root, "fixtures", ...p);

const OVERNIGHT = { seed: 1, operators: ["insert_required_field", "label_synonym", "button_rename"] };

async function portal(c: TakeCtx, version: "v1" | "v2", mutation: unknown | null): Promise<void> {
  await c.post(`${c.partner}/api/__admin/version`, { version });
  if (mutation) await c.post(`${c.partner}/api/__admin/mutation`, mutation);
  else await fetch(`${c.partner}/api/__admin/mutation`, { method: "DELETE" });
}

const out = (msgs: Msg[], kind: string, re: RegExp) =>
  msgs.find((m) => m.dir === "out" && m.kind === kind && re.test(m.text));
const after = (msgs: Msg[], first: Msg | undefined, kind: string, re: RegExp) =>
  first
    ? msgs.find(
        (m) => m.at >= first.at && m !== first && m.dir === "out" && m.kind === kind && re.test(m.text),
      )
    : undefined;

/** The Caravela skill the teach take compiled (the model names it). */
export function caravelaSkill(skills: Record<string, number>): string | undefined {
  return Object.keys(skills).find((n) => n !== "supplier_onboarding" && !n.startsWith("espocrm"));
}

const ESPO_REQUEST = JSON.parse(readFileSync(fixture("oss", "espocrm-lead-request.json"), "utf8")) as {
  text: string;
};
export const ESPO_TEXT = ESPO_REQUEST.text;

/** Dockhand's ways of saying a run stopped without submitting. */
const STOPPED = /^Stopped|Nothing was (submitted|sent)|went wrong/;

/** Rehearsal of a take with no demo:check step: answer every card like the rep until the receipt. */
async function converse(w: World, receipt: RegExp, answer?: string): Promise<ChatEntry> {
  for (;;) {
    const e = await w.rep.expect(
      `a card or the receipt (${receipt})`,
      (x) =>
        (x.type === "image" && receipt.test(x.caption ?? "")) ||
        (x.type === "interactive" && (x.buttons?.length ?? 0) > 0) ||
        (x.type === "text" && STOPPED.test(x.text ?? "")),
      300_000,
    );
    if (e.type === "text") throw new Error(`the run stopped: ${(e.text ?? "").split("\n")[0]}`);
    if (e.type === "image") return e;
    const titles = e.buttons?.map((b) => b.title) ?? [];
    const pick = titles.includes("Approve")
      ? "Approve"
      : answer && titles.includes(answer)
        ? answer
        : titles[0];
    if (pick) await w.rep.tap(e, pick);
  }
}

export const TAKES: Take[] = [
  {
    id: "check",
    title: "Check the line",
    shot: "not filmed",
    modes: ["live"],
    pacingMs: 0,
    director: "Gateway and tunnel are up.",
    phone: ['Send "hi" to Dockhand.', "Wait for the reply."],
    approxMin: 1,
    async setup(c) {
      await portal(c, "v1", null);
    },
    async rehearse() {},
    done: (msgs) => {
      const hi = msgs.find((m) => m.dir === "in" && m.kind === "text");
      return !!hi && msgs.some((m) => m.dir === "out" && m.at >= hi.at);
    },
  },
  {
    id: "teach",
    title: "Teach from a screen recording",
    shot: "shot 3",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director: "Portal on v1, no changes.",
    phone: [
      "Forward caravela-register-deal.mp4 (it is a Document).",
      'Card "I learned …" → tap Looks right.',
      "Forward referral-cafe-aurora.jpg.",
      'Card "First time: computer use" → tap Approve.',
      "Wait about 2.5 min while computer use fills the form.",
      'Card "Ready to submit on Caravela Partner Hub" → tap Approve (again if it asks again).',
      'Receipt, then "New skill: … v1" arrive.',
    ],
    approxMin: 5,
    async setup(c) {
      await portal(c, "v1", null);
    },
    rehearse: (c) => c.steps("teach", "first run (computer use) compiles v1"),
    done: (msgs) => !!out(msgs, "image", /^New skill: \S+ v1\b/),
    camera: (_c, { skills }) => {
      const name = caravelaSkill(skills);
      return name ? [{ view: "code", path: `/recorder/skills/${name}/code?v=1`, label: "code-v1" }] : [];
    },
    speed: [
      { from: { kind: "run_start", mode: "agentic" }, to: { kind: "gate", gateKind: "commit" }, factor: 8 },
    ],
  },
  {
    id: "use",
    title: "Use: replay with zero model calls",
    shot: "shot 4",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director: "Portal on v1. Real speed (no pacing): the replay takes about 4 s.",
    phone: [
      "Forward referral-vila-nova.jpg.",
      'Plan card "… v1" → tap Approve.',
      'Card "Ready to submit" → tap Approve.',
      'Receipt "Replay · compiled skill … 13/13 fields verified".',
    ],
    approxMin: 2,
    async setup(c) {
      await portal(c, "v1", null);
    },
    rehearse: (c) => c.steps("replay with zero model calls"),
    done: (msgs) => !!out(msgs, "image", /Replay · compiled skill/),
  },
  {
    id: "hero",
    title: "Hero: the portal changes, the replay repairs itself",
    shot: "shot 1 (one unbroken take)",
    modes: ["live", "cassette", "fake"],
    pacingMs: 650,
    director:
      'Portal switched to v2 (renamed button, moved field). Pacing on: the HUD says "Slowed for video".',
    phone: [
      "Forward referral-cafe-aurora.jpg.",
      "Plan card → tap Approve.",
      'Card "Ready to submit" → tap Approve.',
      'Receipt "Replay · repaired", then "Portal changed: Caravela Partner Hub … Saved … v2".',
    ],
    approxMin: 3,
    async setup(c) {
      await portal(c, "v2", null);
    },
    rehearse: (c) => c.steps("portal v2: heal, canary, skill v2"),
    done: (msgs) => !!out(msgs, "image", /^Portal changed: Caravela Partner Hub\./),
    camera: (_c, { skills, pick }) => {
      const name = caravelaSkill(skills);
      return [
        ...(pick ? [{ view: "pick" as const, path: `/recorder/picks/${pick}`, label: "pick-hero" }] : []),
        ...(name
          ? [{ view: "code" as const, path: `/recorder/skills/${name}/code?v=2`, label: "code-v2" }]
          : []),
      ];
    },
  },
  {
    id: "ask",
    title: "Ask the rep once: a new required field",
    shot: "shot 6",
    modes: ["live", "cassette", "fake"],
    pacingMs: 450,
    director: 'Portal v2 now requires "Partner tier".',
    phone: [
      "Forward referral-vila-nova.jpg.",
      "Plan card → tap Approve.",
      'Card asking for "Partner tier" → tap Gold.',
      'Card "Ready to submit" → tap Approve.',
      'Receipt, then "Portal changed … Saved … v3".',
    ],
    answer: "Gold",
    approxMin: 3,
    async setup(c) {
      await portal(c, "v2", { seed: 1, operators: ["insert_required_field"] });
    },
    rehearse: (c) => c.steps("new required field: ask the rep once, add the param"),
    done: (msgs) => !!out(msgs, "image", /^Portal changed: Caravela Partner Hub\.[\s\S]* v3 \(/),
    camera: (_c, { skills }) => {
      const name = caravelaSkill(skills);
      return name ? [{ view: "code", path: `/recorder/skills/${name}/code?v=3`, label: "code-v3" }] : [];
    },
  },
  {
    id: "overnight",
    title: "Overnight: it repairs itself before anyone notices",
    shot: "shot 7",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director:
      "Portal relabels its fields and renames the submit button; the overnight check runs (the video labels the time skip).",
    phone: [
      'Wait for "Caravela Partner Hub changed overnight … Nothing to do."',
      "On that card tap Details.",
      "Forward referral-vila-nova.jpg.",
      "Plan card → tap Approve.",
      'Card "Ready to submit" → tap Approve.',
      'Receipt "Replay · compiled skill" with execution $0.00.',
    ],
    approxMin: 3,
    async setup(c) {
      await portal(c, "v2", OVERNIGHT);
      // The "3 AM" run; its card is the take's first message. Not awaited: it takes a minute.
      void c
        .post(`${c.base}/__dev/watch`)
        .then((r) => c.log(`overnight check: ${JSON.stringify(r).slice(0, 200)}`))
        .catch((e) => c.log(`overnight check failed: ${(e as Error).message}`));
    },
    async rehearse(c) {
      const w = c.world as World;
      const card = await w.rep.card(
        /^Caravela Partner Hub changed overnight\. I repaired \d+ steps? \(/,
        ["Roll back", "Details"],
        300_000,
      );
      if (!/Nothing to do\.$/.test(card.text ?? "")) throw new Error(`overnight card: ${card.text}`);
      await w.rep.tap(card, "Details");
      await w.rep.image(/steps? repaired:/);
      await w.rep.sendFile(fixture("inbound", "referral-vila-nova.jpg"));
      const plan = await w.rep.card(`${w.skill} v4`, ["Approve", "Cancel"]);
      await w.rep.tap(plan, "Approve");
      const commit = await w.rep.card(/^Ready to submit on Caravela Partner Hub/, ["Approve", "Cancel"]);
      await w.rep.tap(commit, "Approve");
      const receipt = await w.rep.image(/Replay · compiled skill/);
      if (!/execution \$0\.00\b/.test(receipt.caption ?? ""))
        throw new Error(`overnight replay cost: ${receipt.caption}`);
    },
    done: (msgs) =>
      !!after(msgs, out(msgs, "interactive", /changed overnight/), "image", /Replay · compiled skill/),
  },
  {
    id: "supplier",
    title: "Supplier onboarding, zero-shot (about 40 fields)",
    shot: "montage",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director: "Nothing: the supplier portal has never been seen.",
    phone: [
      "Forward acme-supplier-invitation.pdf.",
      'Plan card "Register Tidewater Cloud as a supplier for Acme Group" → tap Approve.',
      "Wait 4 to 5 min while computer use fills about 40 fields and uploads two files.",
      'Card "Ready to submit on Supplier Portal" → tap Approve (again if it asks again).',
      'Receipt, then "New skill: supplier_onboarding v1".',
    ],
    approxMin: 7,
    async setup() {},
    rehearse: (c) => c.steps("supplier onboarding: acme zero-shot"),
    done: (msgs) => !!out(msgs, "image", /^New skill: supplier_onboarding v1\b/),
    speed: [
      { from: { kind: "run_start", mode: "agentic" }, to: { kind: "gate", gateKind: "commit" }, factor: 16 },
    ],
  },
  {
    id: "supplier2",
    title: "Second buyer replays in seconds",
    shot: "montage",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director: "Nothing.",
    phone: [
      "Forward globex-supplier-invitation.pdf.",
      "Plan card → tap Approve.",
      'Card "Ready to submit" → tap Approve.',
      'Receipt "Replay · compiled skill".',
    ],
    approxMin: 2,
    async setup() {},
    rehearse: (c) => c.steps("supplier onboarding: globex replays"),
    done: (msgs) => !!out(msgs, "image", /Replay · compiled skill/),
  },
  {
    id: "quote",
    title: "Voice note to quote and HubSpot",
    shot: "montage",
    modes: ["live", "cassette", "fake"],
    pacingMs: 0,
    director: "Nothing.",
    phone: [
      "Forward voice note VN2 (pricing for 25 people).",
      'Plan card "Quote for Café Aurora …" → tap Approve.',
      "Quote PDF, the draft reply and the receipt arrive.",
    ],
    approxMin: 2,
    async setup() {},
    // The tapes hold the typed script (demo:check), not a recording: the rehearsal sends the text.
    rehearse: (c) => c.steps("quote to CRM"),
    done: (msgs) => !!out(msgs, "image", /API · /),
  },
  {
    id: "espocrm",
    title: "Real software: EspoCRM changed through its own admin",
    shot: "shot 5",
    // No tapes for EspoCRM (demo:check never runs it): rehearsed with the stand-ins only.
    modes: ["live", "fake"],
    pacingMs: 650,
    director:
      "EspoCRM's admin renames a label and reorders the lead layout; the compiled lead skill is active.",
    phone: [
      "Paste the EspoCRM message (page 3) into the Dockhand chat and send it.",
      "Plan card → tap Approve.",
      'Card "Ready to submit on EspoCRM" → tap Approve.',
      'Receipt, then possibly "Portal changed: EspoCRM … Saved … v2".',
    ],
    approxMin: 3,
    setup: (c) => c.prepareEspo(),
    async rehearse(c) {
      const w = c.world as World;
      await w.rep.sendText(ESPO_TEXT);
      await converse(w, /Cost: execution/);
    },
    done: (msgs, now) => {
      const receipt = out(msgs, "image", /Cost: execution/);
      if (!receipt) return false;
      return !!after(msgs, receipt, "image", /^Portal changed: EspoCRM/) || now - receipt.at > 20_000;
    },
    camera: (_c, { pick }) =>
      pick ? [{ view: "pick", path: `/recorder/picks/${pick}`, label: "pick-espocrm" }] : [],
  },
  {
    id: "vn1",
    title: "Extra: register a deal from a voice note",
    shot: "optional",
    optional: true,
    modes: ["live"],
    pacingMs: 0,
    director: "Portal as after the overnight take. Unrehearsed: keep it only if it reads well.",
    phone: [
      "Forward voice note VN1 (register Café Aurora).",
      "Answer any question it asks; tap Approve on each card.",
      "Receipt.",
    ],
    approxMin: 3,
    async setup(c) {
      await portal(c, "v2", OVERNIGHT);
    },
    async rehearse() {},
    done: (msgs) => !!out(msgs, "image", /Cost: execution/),
  },
  {
    id: "vn3",
    title: "Extra: a voice note with the seat count missing",
    shot: "optional",
    optional: true,
    modes: ["live"],
    pacingMs: 0,
    director: "Unrehearsed: keep it only if it reads well.",
    phone: [
      "Forward voice note VN3 (Vila Nova, no seat count).",
      'When it asks how many seats, reply "Quarenta."',
      "Tap Approve on each card.",
      "Receipt.",
    ],
    approxMin: 3,
    async setup(c) {
      await portal(c, "v2", OVERNIGHT);
    },
    async rehearse() {},
    done: (msgs) => !!out(msgs, "image", /Cost: execution/),
  },
];

/** Takes for a mode, in session order (EspoCRM after the montage: its gateway restart touches nothing later). */
export function takesFor(mode: Mode, withOptional: boolean): Take[] {
  return TAKES.filter((t) => t.modes.includes(mode) && (withOptional || !t.optional));
}

import type { Page } from "playwright";
import { z } from "zod";
import type { ArtifactRef, Id } from "./base.ts";
import type { CallCtx, ComputerUseModel, CuAction, SafetyCheck } from "./models.ts";

/** Fixed for every run so coordinates and screenshots stay meaningful. Device scale factor is always 1. */
export const VIEWPORT = { w: 1280, h: 800 } as const;

export const BBox = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
export type BBox = z.infer<typeof BBox>;

/** What the recorder knows about the element under a click (captured BEFORE the action). */
export const ElementDescriptor = z.object({
  tag: z.string(),
  inputType: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(), // accessible name, from ariaSnapshot where possible
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testId: z.string().optional(),
  domId: z.string().optional(),
  nameAttr: z.string().optional(),
  text: z.string().optional(), // trimmed innerText, <= 80 chars
  value: z.string().optional(), // fields: value after the batch
  section: z.string().optional(), // nearest fieldset legend / heading, for similarity matching
  bbox: BBox,
  formSubmit: z.boolean().optional(), // type=submit or the form's default button
});
export type ElementDescriptor = z.infer<typeof ElementDescriptor>;

/** Ranked; the runner maps each to a Playwright locator. Names are stored without required-asterisks or trailing colons. */
export const Candidate = z.discriminatedUnion("by", [
  z.object({ by: z.literal("testid"), value: z.string() }),
  z.object({ by: z.literal("role"), role: z.string(), name: z.string(), exact: z.boolean() }),
  z.object({ by: z.literal("label"), value: z.string(), exact: z.boolean() }),
  z.object({ by: z.literal("placeholder"), value: z.string() }),
  z.object({ by: z.literal("text"), value: z.string(), exact: z.boolean() }),
  z.object({ by: z.literal("css"), value: z.string() }),
]);
export type Candidate = z.infer<typeof Candidate>;

export const Target = z.object({ candidates: z.array(Candidate), fingerprint: ElementDescriptor });
export type Target = z.infer<typeof Target>;

export type ParamValue = string | number | boolean | { file: ArtifactRef; filename: string };

export type FnName = "request_commit" | "attach_file" | "propose_target";

export interface TraceStep {
  i: number;
  ts: number;
  action: CuAction | { type: "fn"; name: FnName; args: unknown };
  target?: Target; // click: element at (x,y) BEFORE the action; type: activeElement before typing
  fieldValueAfter?: string; // final value of the touched field after the batch (models retype to fix typos)
  formSnapshotBefore?: Record<string, string>; // visible field values keyed by label, before the action
  urlBefore: string;
  urlAfter: string;
  tags: ("commit" | "upload" | "navigation" | "blocked" | "option" | "noise")[];
  upload?: { slot: string; target: Target };
  screenshot?: ArtifactRef; // after the batch containing this step
}

export interface Trace {
  runId: Id;
  portalId: string;
  startUrl: string;
  viewport: { w: number; h: number };
  params: Record<string, ParamValue>; // values the run was told to use (drives templating)
  steps: TraceStep[];
  final: { url: string; text: string; screenshot: ArtifactRef }; // visible text <= 4 KB
  outcome: "done" | "failed" | "rejected" | "expired" | "budget_exceeded";
}

export interface Lease {
  page: Page;
  readonly expiresAt: number;
  extend(ms: number): void;
  release(): Promise<void>;
}

export interface CookieSpec {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface BrowserPool {
  /** Fresh context per lease, viewport 1280x800, deviceScaleFactor 1, reduced motion. */
  lease(o: { portalId: string; runId: Id; cookies?: CookieSpec[]; ttlMs: number }): Promise<Lease>;
  closeAll(): Promise<void>;
}

export type Decision = "approved" | "rejected" | "edit" | "expired";

export interface CuHooks {
  /** Commit gate. `readback` lists the field values on screen right now, for the approval card. */
  approveCommit(r: {
    summary: string;
    screenshot: ArtifactRef;
    highlight?: BBox;
    readback?: { label: string; value: string }[];
  }): Promise<Decision>;
  approveSafety(r: { checks: SafetyCheck[]; screenshot: ArtifactRef }): Promise<Decision>;
  progress?(r: { action: number; note: string }): void;
}

/** Network backstop: mutating requests (POST/PUT/PATCH/DELETE) to these origins are held until approved. */
export interface WriteGuardConfig {
  origins: string[];
  /** URL substrings that never need approval (e.g. "/api/__config"). */
  allow: string[];
}

export interface CuRunInput {
  page: Page;
  portalId: string;
  runId: Id;
  goal: string;
  guidance: string[]; // teach-draft steps (param names only, never values seen in the video), or the repair intent
  params: Record<string, ParamValue>;
  attachments: Record<string, ArtifactRef>; // slot -> file, e.g. { w9, coi }
  commitPolicy: "gate" | "propose_only";
  commitHints: string[]; // accessible names that count as commit
  writeGuard: WriteGuardConfig;
  limits: { maxActions: number; maxWallMs: number; maxCostUsd: number; rolloverAfterImages: number };
  /** Ledger total for this run so far (checked against maxCostUsd after every turn). */
  costSoFar?: () => number;
}

/** Every interactive element currently on the page, described like a trace target (for similarity and rung 2). */
export interface InteractiveElement {
  index: number;
  descriptor: ElementDescriptor;
  candidates: Candidate[];
}

export interface CuRunResult {
  trace: Trace;
  outcome: Trace["outcome"];
  message?: string;
  proposed?: Target; // propose_only mode: the element the model chose
}

/** Runs the loop. Implemented in packages/browser. */
export type RunComputerUse = (
  model: ComputerUseModel,
  input: CuRunInput,
  hooks: CuHooks,
  ctx: CallCtx,
) => Promise<CuRunResult>;

// ---- Scripted model (CI only): semantic script -> real pixel computer_calls through the same loop ----

export type SemanticTarget = { role?: string; name?: string; label?: string; testId?: string; text?: string };

export type ScriptStep =
  | { do: "click"; target: SemanticTarget }
  | { do: "fill"; target: SemanticTarget; text: string } // click at bbox centre, select-all, type
  | { do: "select"; trigger: SemanticTarget; option: string }
  | { do: "check"; target: SemanticTarget }
  | { do: "press"; keys: string[] }
  | { do: "scroll"; dy: number }
  | { do: "call"; name: FnName; args: Record<string, unknown> }
  | { do: "misclick"; x: number; y: number } // exercises compiler cleanup and the commit guard
  | { do: "typo"; target: SemanticTarget; wrong: string; right: string } // types wrong, selects all, retypes
  | { do: "done"; text: string };

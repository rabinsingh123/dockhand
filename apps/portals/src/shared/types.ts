// Types shared by the portal servers, the client bundles, and external harnesses.

export type PortalKind = "partner" | "supplier";
export type PortalVersion = "v1" | "v2";

export const MUTATION_OPERATOR_IDS = [
  "label_synonym",
  "testid_churn",
  "button_rename",
  "reorder_fields",
  "wrapper_divs",
  "class_churn",
  "id_churn",
  "placeholder_change",
  "insert_optional_field",
  "insert_required_field",
  "move_field_to_step",
  "combobox_to_radio",
] as const;

export type MutationOperator = (typeof MUTATION_OPERATOR_IDS)[number];

/** What a self-healing replay is expected to need when this operator is applied. */
export type HealCategory =
  | "heal_deterministic"
  | "heal_deterministic_or_model"
  | "heal_model"
  | "must_fail_safe";

export interface MutationConfig {
  seed: number;
  /** Explicit operators. Omitted = 1-3 operators picked deterministically from the seed. */
  operators?: MutationOperator[];
}

/** A mutation config with the operator list resolved (what was actually applied). */
export interface ResolvedMutation {
  seed: number;
  operators: MutationOperator[];
}

export type FieldValue = string | number | boolean | string[];

export interface SubmittedFile {
  field: string;
  filename: string;
  size: number;
  sha256: string;
}

/**
 * Ground truth for evals. `fields` uses canonical keys that are stable across versions and
 * mutations. Empty optional fields are omitted; booleans are always present.
 * Dates are ISO `YYYY-MM-DD`; integers and amounts are numbers; checkbox groups are string[].
 */
export interface Submission {
  id: string;
  portal: PortalKind;
  /** runId of the browser context's test session; null for contexts without one (manual / login). */
  runId: string | null;
  tenant?: string;
  inviteCode?: string;
  version: PortalVersion;
  mutation?: ResolvedMutation;
  fields: Record<string, FieldValue>;
  files?: SubmittedFile[];
  createdAt: string;
}

/**
 * Response of `GET /api/__config`: the EFFECTIVE config for the requesting browser context.
 * A context with a test-session cookie gets its pinned ui / mutation / runId; anything not pinned
 * falls back to the portal defaults (set by setVersion / setMutation or the admin endpoints).
 */
export interface PortalConfig {
  portal: PortalKind;
  version: PortalVersion;
  mutation: MutationConfig | null;
  /** Operators actually applied (resolved from the seed when `mutation.operators` is omitted). */
  operators: MutationOperator[];
  /** Server's local calendar date, ISO `YYYY-MM-DD`. "Future" dates are compared against this. */
  serverDate: string;
  /** Server clock, full ISO timestamp. */
  serverTime: string;
  /** runId pinned by the context's test session, null otherwise. */
  runId: string | null;
}

/**
 * Options for a per-context session. With `ui` given, ui AND mutation are pinned (an omitted mutation
 * means none), so eval workers never see a default flipped for the live demo. With neither `ui` nor
 * `mutation`, the context follows the portal defaults (what the live-demo context wants).
 */
export interface SessionOptions {
  /** Pins the UI version. The supplier portal has a single UI and ignores it for rendering. */
  ui?: PortalVersion;
  /** A config pins that mutation; null pins "none"; omitted = none if `ui` is given, else the default. */
  mutation?: MutationConfig | null;
  runId: string;
  username?: string;
}

/** Cookie shape accepted by Playwright's `context.addCookies([...])`. */
export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

/** Inlined into every HTML shell so the first render happens before the `load` event. */
export interface BootPayload extends PortalConfig {
  path: string;
  user: { username: string } | null;
  data: Record<string, unknown> | null;
}

export type DealStatus = "Pending review" | "Approved" | "Declined" | "Expired";

export interface DealRecord {
  id: string;
  status: DealStatus;
  submittedAt: string;
  /** Pre-populated demo rows (not part of `submissions()`). */
  seeded: boolean;
  fields: Record<string, FieldValue>;
}

export interface SupplierRecord {
  id: string;
  tenant: string;
  status: "Pending buyer approval";
  submittedAt: string;
  legalName: string;
  primaryContactEmail: string;
}

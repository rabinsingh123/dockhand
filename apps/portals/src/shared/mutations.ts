// Seeded, deterministic UI mutation engine. Pure functions: the server and the client compute the
// same plan from (portal, MutationConfig), so server validation always matches what was rendered.

import type { FieldDef, SectionDef } from "./fields.ts";
import { pick, type Rng, randInt, rngFor, shuffle, token } from "./rng.ts";
import {
  type HealCategory,
  MUTATION_OPERATOR_IDS,
  type MutationConfig,
  type MutationOperator,
  type PortalKind,
  type ResolvedMutation,
} from "./types.ts";

export interface MutationOperatorInfo {
  id: MutationOperator;
  /** Expected self-heal outcome, for honest eval reporting. */
  category: HealCategory;
  description: string;
  portals: readonly PortalKind[];
}

const BOTH: readonly PortalKind[] = ["partner", "supplier"];

export const MUTATION_OPERATORS: readonly MutationOperatorInfo[] = [
  {
    id: "label_synonym",
    category: "heal_deterministic_or_model",
    description: 'Field labels change to synonyms (e.g. "End customer company" -> "Customer account name").',
    portals: BOTH,
  },
  {
    id: "testid_churn",
    category: "heal_deterministic",
    description: "Every data-testid is renamed to a new scheme or removed.",
    portals: BOTH,
  },
  {
    id: "button_rename",
    category: "heal_model",
    description: "Primary action buttons get a synonym label and lose their data-testid (as in a redesign).",
    portals: BOTH,
  },
  {
    id: "reorder_fields",
    category: "heal_deterministic",
    description: "Fields are shuffled within each form section.",
    portals: BOTH,
  },
  {
    id: "wrapper_divs",
    category: "heal_deterministic",
    description: "1-3 extra nested wrapper elements around fields, sections and actions (breaks CSS paths).",
    portals: BOTH,
  },
  {
    id: "class_churn",
    category: "heal_deterministic",
    description:
      "Every CSS class name becomes a random token (the stylesheet follows, so styling is intact).",
    portals: BOTH,
  },
  {
    id: "id_churn",
    category: "heal_deterministic",
    description: "Element ids change; label for=, aria-controls, aria-describedby etc. follow.",
    portals: BOTH,
  },
  {
    id: "placeholder_change",
    category: "heal_deterministic",
    description: "Input placeholders change.",
    portals: BOTH,
  },
  {
    id: "insert_optional_field",
    category: "heal_deterministic",
    description: "A new optional field appears. No change needed.",
    portals: BOTH,
  },
  {
    id: "insert_required_field",
    category: "must_fail_safe",
    description:
      'A new required field appears (partner: "Partner tier*" combobox Gold/Silver/Bronze, right after Product; supplier: "Supplier category*"). A replay must stop and ask a human, never guess.',
    portals: BOTH,
  },
  {
    id: "move_field_to_step",
    category: "heal_model",
    description: "One field moves to a different wizard step.",
    portals: ["supplier"],
  },
  {
    id: "combobox_to_radio",
    category: "heal_model",
    description:
      "A short-list combobox becomes a radio group (partner: Product; supplier: Payment currency).",
    portals: BOTH,
  },
];

export function isMutationOperator(x: unknown): x is MutationOperator {
  return typeof x === "string" && (MUTATION_OPERATOR_IDS as readonly string[]).includes(x);
}

export function operatorsFor(portal: PortalKind): MutationOperator[] {
  return MUTATION_OPERATORS.filter((o) => o.portals.includes(portal)).map((o) => o.id);
}

export function operatorInfo(id: MutationOperator): MutationOperatorInfo {
  const info = MUTATION_OPERATORS.find((o) => o.id === id);
  if (!info) throw new Error(`Unknown mutation operator: ${id}`);
  return info;
}

/** Operators applied for this portal. Explicit lists are filtered to applicable operators. */
export function resolveOperators(
  portal: PortalKind,
  config: MutationConfig | null | undefined,
): MutationOperator[] {
  if (!config) return [];
  const applicable = operatorsFor(portal);
  let chosen: MutationOperator[];
  if (config.operators) {
    chosen = config.operators.filter((op) => applicable.includes(op));
  } else {
    const rng = rngFor(config.seed, "operators");
    const count = 1 + randInt(rng, 3);
    chosen = shuffle(applicable, rng).slice(0, count);
  }
  return MUTATION_OPERATOR_IDS.filter((op) => chosen.includes(op));
}

export function resolveMutation(
  portal: PortalKind,
  config: MutationConfig | null | undefined,
): ResolvedMutation | undefined {
  if (!config) return undefined;
  return { seed: config.seed, operators: resolveOperators(portal, config) };
}

export interface Mutator {
  /** null when no mutation is configured. */
  readonly seed: number | null;
  readonly operators: readonly MutationOperator[];
  has(op: MutationOperator): boolean;
  /** Final data-testid for a base testid; undefined = attribute removed. */
  testid(base: string | undefined): string | undefined;
  /** Final class name for a base class name. */
  cls(name: string): string;
  /** Final DOM id for a base id. */
  id(base: string): string;
  /** Number of extra wrapper elements around the element identified by `key`. */
  wrapDepth(key: string): number;
  /** Text and testid policy for a primary action button. */
  action(key: string, text: string, synonyms: readonly string[]): { text: string; keepTestid: boolean };
}

const TESTID_PREFIXES = ["qa", "ctl", "field", "el", "cmp"] as const;
const CLASS_PREFIXES = ["css-", "sc-", "x", "c"] as const;
const ID_PREFIXES = ["fld-", "el-", "input-", "f"] as const;

export function createMutator(portal: PortalKind, config: MutationConfig | null | undefined): Mutator {
  const operators = resolveOperators(portal, config);
  const seed = config ? config.seed : null;
  const s = seed ?? 0;
  const has = (op: MutationOperator) => operators.includes(op);
  const cache = new Map<string, string | undefined>();
  const memo = (key: string, make: () => string | undefined) => {
    if (cache.has(key)) return cache.get(key);
    const v = make();
    cache.set(key, v);
    return v;
  };
  return {
    seed,
    operators,
    has,
    testid(base) {
      if (base === undefined) return undefined;
      if (!has("testid_churn")) return base;
      return memo(`tid:${base}`, () => {
        const r = rngFor(s, `tid:${base}`);
        if (r() < 0.35) return undefined;
        return `${pick(TESTID_PREFIXES, r)}-${token(r, 6)}`;
      });
    },
    cls(name) {
      if (!has("class_churn")) return name;
      return memo(`cls:${name}`, () => {
        const r = rngFor(s, `cls:${name}`);
        return `${pick(CLASS_PREFIXES, r)}${token(r, 6)}`;
      }) as string;
    },
    id(base) {
      if (!has("id_churn")) return base;
      return memo(`id:${base}`, () => {
        const r = rngFor(s, `id:${base}`);
        return `${pick(ID_PREFIXES, r)}${token(r, 7)}`;
      }) as string;
    },
    wrapDepth(key) {
      if (!has("wrapper_divs")) return 0;
      return 1 + randInt(rngFor(s, `wrap:${key}`), 3);
    },
    action(key, text, synonyms) {
      if (!has("button_rename")) return { text, keepTestid: true };
      const options = synonyms.filter((x) => x !== text);
      if (options.length === 0) return { text, keepTestid: false };
      return { text: pick(options, rngFor(s, `button:${key}`)), keepTestid: false };
    },
  };
}

export const IDENTITY_MUTATOR: Mutator = createMutator("partner", null);

export interface SchemaMutationOptions {
  /** insert_optional_field picks one of these (seeded) and inserts it at a seeded position. */
  optionalCandidates: readonly FieldDef[];
  /** insert_required_field always inserts this field. */
  requiredField: FieldDef;
  /** Fixed position for the required field: right after this key. Seeded position when absent. */
  requiredAfter?: string;
  /** combobox_to_radio converts these comboboxes. */
  radioEligible: readonly string[];
  /** move_field_to_step picks one of these keys (supplier). */
  movable?: readonly string[];
}

function cloneSections(sections: readonly SectionDef[]): SectionDef[] {
  return sections.map((s) => ({ ...s, fields: s.fields.map((f) => ({ ...f })) }));
}

function canReceive(s: SectionDef): boolean {
  return s.insertable !== false && !s.showWhen;
}

function insertAtRandom(sections: SectionDef[], field: FieldDef, r: Rng): void {
  const eligible = sections.filter(canReceive);
  if (eligible.length === 0) return;
  const target = pick(eligible, r);
  target.fields.splice(randInt(r, target.fields.length + 1), 0, field);
}

function insertAfter(sections: SectionDef[], field: FieldDef, afterKey: string): boolean {
  for (const s of sections) {
    const idx = s.fields.findIndex((f) => f.key === afterKey);
    if (idx >= 0) {
      s.fields.splice(idx + 1, 0, field);
      return true;
    }
  }
  return false;
}

function moveFieldToOtherStep(sections: SectionDef[], movable: readonly string[], r: Rng): void {
  const present = movable.filter((k) => sections.some((s) => s.fields.some((f) => f.key === k)));
  if (present.length === 0) return;
  const key = pick(present, r);
  const from = sections.find((s) => s.fields.some((f) => f.key === key));
  if (!from) return;
  const targets = sections.filter((s) => s.step !== from.step && canReceive(s));
  const steps = [...new Set(targets.map((s) => s.step))];
  if (steps.length === 0) return;
  const step = pick(steps, r);
  const target = targets.find((s) => s.step === step);
  if (!target) return;
  const idx = from.fields.findIndex((f) => f.key === key);
  const [field] = from.fields.splice(idx, 1);
  if (field) target.fields.push(field);
}

function shuffleChanged<T>(items: readonly T[], r: Rng): T[] {
  if (items.length < 2) return items.slice();
  const out = shuffle(items, r);
  if (out.every((x, i) => x === items[i])) return [...items.slice(1), items[0] as T];
  return out;
}

/** Applies the schema-level operators. DOM-level operators are applied by the renderer via Mutator. */
export function mutateSections(
  base: readonly SectionDef[],
  m: Mutator,
  opts: SchemaMutationOptions,
): SectionDef[] {
  const sections = cloneSections(base);
  if (m.operators.length === 0) return sections;
  const seed = m.seed ?? 0;

  if (m.has("label_synonym")) {
    for (const s of sections)
      for (const f of s.fields)
        if (f.synonyms?.length) f.label = pick(f.synonyms, rngFor(seed, `label:${f.key}`));
  }
  if (m.has("placeholder_change")) {
    for (const s of sections)
      for (const f of s.fields)
        if (f.altPlaceholders?.length)
          f.placeholder = pick(f.altPlaceholders, rngFor(seed, `placeholder:${f.key}`));
  }
  if (m.has("combobox_to_radio")) {
    for (const s of sections)
      for (const f of s.fields)
        if (f.kind === "combobox" && opts.radioEligible.includes(f.key)) {
          f.kind = "radio";
          f.placeholder = undefined;
          f.span = 2;
        }
  }
  if (m.has("insert_optional_field") && opts.optionalCandidates.length > 0) {
    const r = rngFor(seed, "insert_optional");
    insertAtRandom(sections, { ...pick(opts.optionalCandidates, r) }, r);
  }
  if (m.has("insert_required_field")) {
    const field = { ...opts.requiredField };
    const placed = opts.requiredAfter ? insertAfter(sections, field, opts.requiredAfter) : false;
    if (!placed) insertAtRandom(sections, field, rngFor(seed, "insert_required"));
  }
  if (m.has("move_field_to_step") && opts.movable?.length) {
    moveFieldToOtherStep(sections, opts.movable, rngFor(seed, "move_field"));
  }
  if (m.has("reorder_fields")) {
    for (const s of sections) s.fields = shuffleChanged(s.fields, rngFor(seed, `order:${s.key}`));
  }
  return sections;
}

// Bootstrap skills for evals without any Meta model: the scripted computer-use model plays a semantic script
// through the real runComputerUse loop (real screenshots, commit gates, file picker), and the trace is
// compiled without annotation. The result is cached under var/evals/skills/<skill name>.json.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createBrowserPool,
  createScriptedModel,
  type DockhandBrowserPool,
  runComputerUse,
} from "@dockhand/browser";
import {
  type ArtifactRef,
  type CuHooks,
  type CuRunInput,
  createMemoryArtifactStore,
  type ParamSpec,
  type ParamValue,
  type ScriptStep,
  Skill,
  ulid,
} from "@dockhand/core";
import { addDaysIso, type CanonicalField, isoToDmy, type PortalHandle } from "@dockhand/portals";
import { compile } from "@dockhand/skills";
import type { Page } from "playwright";
import { fieldBindings } from "./bindings.ts";
import { fixtureFile, isFileParam, materializeFiles } from "./files.ts";
import { evalsVarDir, repoPath, skillCacheDir } from "./paths.ts";
import {
  type EvalPortal,
  isLocalUrl,
  type PortalDef,
  paramNameFor,
  paramSpecFor,
  portalDef,
  writeGuardFor,
} from "./portals.ts";

export interface BootstrapDeps {
  /** A running portal of the right kind; one is started (and closed) when absent. */
  portal?: PortalHandle;
  /** Browser pool to lease the context from; a headless one is created (and closed) when absent. */
  pool?: DockhandBrowserPool;
  /** Default var/evals/skills. */
  cacheDir?: string;
  /** Ignore the cache and record a fresh run. */
  refresh?: boolean;
  log?: (msg: string) => void;
}

/** Bootstrap values: the Caravela deal from the teach fixture's world (unique values, so templating is unambiguous). */
function partnerValues(today: string): Record<string, string> {
  return {
    companyName: "Sabiá Foods Ltda.",
    companyWebsite: "sabiafoods.example",
    country: "Brazil",
    city: "São Paulo",
    contactName: "Mariana Costa",
    contactEmail: "mariana.costa@sabiafoods.example",
    contactPhone: "+55 11 91234 5678",
    product: "Tidewater Cloud Business",
    seats: "25",
    estimatedValue: "18000",
    expectedCloseDate: addDaysIso(today, 60),
    referralPartner: "Agência Ponte Digital",
    notes: "Pilot with the finance team first",
    consent: "true",
  };
}

/** The Tidewater Cloud supplier profile, keyed by canonical field (file paths become fixture params). */
function supplierValues(): Record<string, string> {
  const profile = JSON.parse(readFileSync(repoPath("fixtures/profile/tidewater.json"), "utf8")) as Record<
    string,
    string
  >;
  return profile;
}

const NUMERIC_TYPES = new Set<CanonicalField["type"]>(["integer", "money", "year"]);

function paramValueFor(field: CanonicalField, raw: string): ParamValue {
  return NUMERIC_TYPES.has(field.type) ? Number(raw) : raw;
}

function conditionHolds(field: CanonicalField, values: Record<string, string>): boolean {
  if (!field.showWhen) return true;
  const actual = values[field.showWhen.key] ?? String(field.defaultValue ?? "");
  return actual === String(field.showWhen.equals);
}

interface Plan {
  params: Record<string, ParamValue>;
  specs: ParamSpec[];
  script: ScriptStep[];
  /** canonical key -> param the compiled skill must bind it to. */
  expectedBindings: Record<string, string>;
}

/** Script steps that write one field the way a person would (by label, combobox by role, radios by option). */
function writeField(field: CanonicalField, raw: string, slot: string): ScriptStep[] {
  switch (field.type) {
    case "combobox":
      return [{ do: "select", trigger: { role: "combobox", name: field.label }, option: raw }];
    case "checkbox":
      // Default-checked boxes are left alone; a click would clear them.
      return raw === "true" && field.defaultValue !== true
        ? [{ do: "check", target: { role: "checkbox", name: field.label } }]
        : [];
    case "radio":
      return [{ do: "check", target: { role: "radio", name: raw } }];
    case "checkboxGroup":
      return raw
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean)
        .map((o): ScriptStep => ({ do: "check", target: { role: "checkbox", name: o } }));
    case "file":
      return [
        { do: "click", target: { role: "button", name: `Choose file for ${field.label}` } },
        { do: "call", name: "attach_file", args: { slot } },
      ];
    case "date":
      return [{ do: "fill", target: { label: field.label }, text: isoToDmy(raw) }];
    default:
      return [{ do: "fill", target: { label: field.label }, text: raw }];
  }
}

/** Fields that carry a param (values the replay must take from the case); radios and boxes stay literal. */
function isParamField(field: CanonicalField): boolean {
  return !["checkbox", "radio", "checkboxGroup"].includes(field.type);
}

function buildPlan(def: PortalDef, today: string): Plan {
  const values = def.key === "caravela" ? partnerValues(today) : supplierValues();
  const params: Record<string, ParamValue> = {};
  const specs: ParamSpec[] = [];
  const expectedBindings: Record<string, string> = {};
  if (def.key === "supplier") {
    params.tenant = "acme";
    params.invite_code = "ACME-7731";
    specs.push(
      { name: "tenant", type: "string", required: true, description: "Buyer tenant slug in the invite URL" },
      { name: "invite_code", type: "string", required: true, description: "Supplier invitation code" },
    );
    // compile breaks ties between equal values by label overlap, then by param order: "Country" overlaps
    // country and country_of_incorporation equally (both "Brazil" in the profile), so country goes first.
    params.country = "";
  }
  const byStep = new Map<string, ScriptStep[]>();
  for (const field of def.fields) {
    const raw = values[field.key];
    if (raw === undefined || raw === "") continue;
    if (!conditionHolds(field, values)) continue;
    const name = paramNameFor(field.key);
    const steps = writeField(field, raw, name);
    if (field.type === "file") params[name] = fixtureFile(raw);
    else if (isParamField(field)) params[name] = paramValueFor(field, raw);
    if (params[name] !== undefined) {
      specs.push(paramSpecFor(field, name));
      expectedBindings[field.key] = name;
    }
    const stepKey = field.step ?? "form";
    byStep.set(stepKey, [...(byStep.get(stepKey) ?? []), ...steps]);
  }

  const script: ScriptStep[] = [];
  if (def.key === "caravela") {
    script.push(...(byStep.get("form") ?? []));
    script.push(
      { do: "call", name: "request_commit", args: { summary: `Register ${values.companyName}` } },
      { do: "click", target: { role: "button", name: "Submit registration" } },
      { do: "done", text: "Registration submitted." },
    );
  } else {
    // "Start registration" reads as a commit to the harness (COMMIT_NAME matches "register"), so it is gated.
    script.push(
      { do: "call", name: "request_commit", args: { summary: "Start the Acme Group supplier registration" } },
      { do: "click", target: { role: "button", name: "Start registration" } },
    );
    for (const step of ["company", "address", "contacts", "banking", "compliance"]) {
      script.push(...(byStep.get(step) ?? []), { do: "click", target: { role: "button", name: "Next" } });
    }
    script.push(
      { do: "call", name: "request_commit", args: { summary: `Submit ${values.legalName} for approval` } },
      { do: "click", target: { role: "button", name: "Submit for approval" } },
      { do: "done", text: "Supplier registration submitted." },
    );
  }
  return { params, specs, script, expectedBindings };
}

function autoApproveLocal(page: Page): CuHooks {
  return {
    approveCommit: async () => (isLocalUrl(page.url()) ? "approved" : "rejected"),
    approveSafety: async () => "rejected",
  };
}

export function skillCachePath(portal: EvalPortal, cacheDir = skillCacheDir()): string {
  return join(cacheDir, `${portalDef(portal).skillName}.json`);
}

/** Loads the cached bootstrap skill, or records and compiles a fresh one. */
export async function bootstrapSkill(portal: EvalPortal, deps: BootstrapDeps = {}): Promise<Skill> {
  const def = portalDef(portal);
  const cachePath = skillCachePath(portal, deps.cacheDir);
  if (!deps.refresh && existsSync(cachePath)) {
    return Skill.parse(JSON.parse(readFileSync(cachePath, "utf8")));
  }
  const log = deps.log ?? (() => {});
  const handle = deps.portal ?? (await def.start({ latencyMs: [20, 60] }));
  const pool =
    deps.pool ??
    createBrowserPool({ headless: true, maxContexts: 1, storageStateDir: join(evalsVarDir(), "state") });
  try {
    const skill = await recordAndCompile(def, handle, pool, log);
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(cachePath, `${JSON.stringify(skill, null, 2)}\n`);
    log(`bootstrap: cached ${def.skillName} v1 (${skill.steps.length} steps) at ${cachePath}`);
    return skill;
  } finally {
    if (!deps.pool) await pool.closeAll();
    if (!deps.portal) await handle.close();
  }
}

async function recordAndCompile(
  def: PortalDef,
  handle: PortalHandle,
  pool: DockhandBrowserPool,
  log: (msg: string) => void,
): Promise<Skill> {
  const runId = `bootstrap-${def.key}-${ulid()}`;
  const plan = buildPlan(def, handle.config().serverDate);
  const lease = await pool.lease({
    portalId: def.portalId,
    runId,
    cookies: await handle.session({ ui: "v1", mutation: null, runId }),
    ttlMs: 300_000,
  });
  try {
    const { page } = lease;
    const artifacts = createMemoryArtifactStore();
    const { params } = await materializeFiles(plan.params, artifacts);
    const attachments: Record<string, ArtifactRef> = {};
    for (const [name, v] of Object.entries(params)) if (isFileParam(v)) attachments[name] = v.file;
    await page.goto(`${handle.url}${def.startPath}`, { waitUntil: "load" });
    const input: CuRunInput = {
      page,
      portalId: def.portalId,
      runId,
      goal: def.title,
      guidance: [],
      params,
      attachments,
      commitPolicy: "gate",
      commitHints: [],
      writeGuard: writeGuardFor(def, handle.url),
      limits: { maxActions: 250, maxWallMs: 300_000, maxCostUsd: 1, rolloverAfterImages: 50 },
      artifacts,
    };
    const model = createScriptedModel(plan.script, page, { targetTimeoutMs: 10_000 });
    const run = await runComputerUse(model, input, autoApproveLocal(page), {
      purpose: "cu_first_run",
      runId,
      timeoutMs: 60_000,
    });
    const submissions = handle.submissions({ runId });
    if (run.outcome !== "done" || submissions.length !== 1) {
      throw new Error(
        `bootstrap ${def.key}: scripted run ended "${run.outcome}" (${run.message ?? "no message"}) with ${submissions.length} submissions`,
      );
    }
    const compiled = compile(run.trace, {
      name: def.skillName,
      title: def.title,
      params: plan.specs,
      createdFrom: { kind: "goal", traceRunId: runId },
    });
    for (const w of compiled.warnings) log(`bootstrap: compile ${w.code} at step ${w.stepIdx}: ${w.detail}`);
    const skill = Skill.parse({ ...compiled.skill, version: 1, parentVersion: null });
    assertBindings(skill, def, plan.expectedBindings);
    return skill;
  } finally {
    await lease.release();
  }
}

/** Fails loudly when compile bound a field to the wrong param: every case built on it would be wrong. */
function assertBindings(skill: Skill, def: PortalDef, expected: Record<string, string>): void {
  const { bindings, unmapped } = fieldBindings(skill, def);
  const problems: string[] = unmapped.map(
    (u) => `step ${u.stepId} writes an element no field matches (${u.label})`,
  );
  for (const [key, param] of Object.entries(expected)) {
    const b = bindings.find((x) => x.key === key);
    if (!b) problems.push(`${key}: no step writes it`);
    else if (b.params.length !== 1 || b.params[0] !== param)
      problems.push(
        `${key}: bound to ${b.params.join(", ") || `literal "${b.template}"`}, expected {{${param}}}`,
      );
  }
  if (problems.length > 0)
    throw new Error(`bootstrap ${def.key}: compiled skill is wrong:\n  ${problems.join("\n  ")}`);
}

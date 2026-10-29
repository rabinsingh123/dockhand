// The two mock portals as eval targets: ids, start paths, write-guard allow lists and the canonical field
// catalog each skill is graded against.

import type { ParamSpec, ParamType, WriteGuardConfig } from "@dockhand/core";
import {
  type CanonicalField,
  PARTNER_FIELDS,
  PARTNER_INSERTABLE_FIELDS,
  type PortalHandle,
  type PortalKind,
  type StartOptions,
  SUPPLIER_FIELDS,
  SUPPLIER_INSERTABLE_FIELDS,
  startPartnerPortal,
  startSupplierPortal,
} from "@dockhand/portals";

export type EvalPortal = "caravela" | "supplier";
export const EVAL_PORTALS: readonly EvalPortal[] = ["caravela", "supplier"];

export interface PortalDef {
  key: EvalPortal;
  /** portalId used by skills, leases and the orchestrator. */
  portalId: string;
  kind: PortalKind;
  skillName: string;
  title: string;
  /** Where the bootstrap run starts (the compiled skill's first goto). */
  startPath: string;
  /** Mutating requests that are navigation, not submissions (same lists as the orchestrator). */
  writeGuardAllow: string[];
  /** Canonical fields of the unmutated form (supplier: acme tenant only). */
  fields: readonly CanonicalField[];
  /** Fields that only exist under an insert_* mutation. */
  insertable: readonly CanonicalField[];
  /** The portal has a v2 UI (supplier is single-version). */
  hasV2: boolean;
  start(opts?: StartOptions): Promise<PortalHandle>;
}

export const PORTALS: Record<EvalPortal, PortalDef> = {
  caravela: {
    key: "caravela",
    portalId: "caravela",
    kind: "partner",
    skillName: "caravela_register_deal",
    title: "Register a deal on Caravela Partner Hub",
    startPath: "/deals/new",
    writeGuardAllow: ["/api/login", "/api/logout", "/api/__config"],
    fields: PARTNER_FIELDS,
    insertable: PARTNER_INSERTABLE_FIELDS,
    hasV2: true,
    start: (opts) => startPartnerPortal({ port: 0, ...opts }),
  },
  supplier: {
    key: "supplier",
    portalId: "supplier",
    kind: "supplier",
    skillName: "acme_supplier_registration",
    title: "Register Tidewater Cloud as a supplier on the Acme Group portal",
    startPath: "/t/acme/invite/ACME-7731",
    writeGuardAllow: ["/api/login", "/api/logout", "/api/__config", "/api/t/*/invite/*/start"],
    fields: SUPPLIER_FIELDS.filter((f) => !f.tenants || f.tenants.includes("acme")),
    insertable: SUPPLIER_INSERTABLE_FIELDS,
    hasV2: false,
    start: (opts) => startSupplierPortal({ port: 0, ...opts }),
  },
};

export function portalDef(key: string): PortalDef {
  const def = PORTALS[key as EvalPortal];
  if (!def) throw new Error(`unknown portal "${key}" (expected ${EVAL_PORTALS.join(" | ")})`);
  return def;
}

/** The portal a skill was compiled for. */
export function portalOfSkill(skill: { portalId: string }): PortalDef {
  const def = Object.values(PORTALS).find((p) => p.portalId === skill.portalId);
  if (!def) throw new Error(`no eval portal for portalId "${skill.portalId}"`);
  return def;
}

export function writeGuardFor(def: PortalDef, portalUrl: string): WriteGuardConfig {
  return { origins: [new URL(portalUrl).origin], allow: def.writeGuardAllow, allowOrigins: [] };
}

/** Eval contexts approve commits only against local portals. */
export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  } catch {
    return false;
  }
}

/** camelCase canonical key -> snake_case param name ("primaryContactEmail" -> "primary_contact_email"). */
export function paramNameFor(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

const PARAM_TYPES: Partial<Record<CanonicalField["type"], ParamType>> = {
  email: "email",
  tel: "phone",
  integer: "number",
  money: "number",
  year: "number",
  date: "date",
  combobox: "enum",
  radio: "enum",
  file: "file",
};

export function paramSpecFor(field: CanonicalField, name = paramNameFor(field.key)): ParamSpec {
  return {
    name,
    type: PARAM_TYPES[field.type] ?? "string",
    required: field.required,
    description: field.label,
    ...(field.options && (field.type === "combobox" || field.type === "radio")
      ? { enumValues: [...field.options] }
      : {}),
  };
}

/** Label as the skill's fingerprints carry it: no required asterisk or trailing colon, trimmed. */
export function bareLabel(label: string): string {
  return label
    .replace(/\s*[*:]+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

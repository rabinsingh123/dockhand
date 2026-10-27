import { DockhandError } from "@dockhand/core";
import { type ZodType, z } from "zod";

export type JsonSchema = Record<string, unknown>;

export interface WireSchema {
  /** Sent as `text.format.schema` (Meta) or `response_format.json_schema.schema` (Baseten). */
  schema: JsonSchema;
  /**
   * The wire schema lists every property as required and makes optional ones nullable. This turns the
   * model's nulls for fields that are optional in the zod schema back into absent keys (in place).
   */
  restoreOptional(value: unknown): unknown;
}

/**
 * Keywords kept as they are. `pattern` and `format` move into `description` (the model still reads them,
 * the constrained decoder never has to support them); `oneOf` becomes `anyOf`; everything else
 * (`$schema`, `default`, `propertyNames`, safe-integer bounds, ...) is dropped. zod still validates the
 * full schema afterwards, so nothing is lost. See https://dev.meta.ai/docs/structured-output for limits.
 */
const KEPT_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "prefixItems",
  "enum",
  "const",
  "anyOf",
  "description",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
]);

/** Documented limit: nesting depth 10 levels. */
const MAX_DEPTH = 10;
const MAX_PATTERN_NOTE_CHARS = 200;
const NULL_SCHEMA: JsonSchema = { type: "null" };

export function toWireSchema(schema: ZodType): WireSchema {
  let generated: JsonSchema;
  try {
    // cycles: "throw" rejects recursive schemas (HTTP 400 at Meta); reused: "inline" avoids $defs/$ref.
    generated = z.toJSONSchema(schema, {
      io: "output",
      reused: "inline",
      cycles: "throw",
      unrepresentable: "throw",
    }) as JsonSchema;
  } catch (err) {
    throw new DockhandError(
      "MODEL_ERROR",
      `schema cannot be sent as structured output: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const { node, plan } = convert(generated, 0);
  return { schema: node, restoreOptional: (value) => applyPlan(plan, value) };
}

// ---- conversion ------------------------------------------------------------------------------------

interface NullPlan {
  /** Keys whose null means "absent" (optional in zod, nullable only on the wire). */
  optional?: string[];
  properties?: Record<string, NullPlan>;
  /** Declared keys, so additionalProperties' plan is applied to the other keys only. */
  knownKeys?: string[];
  additional?: NullPlan;
  items?: NullPlan;
  tuple?: (NullPlan | undefined)[];
  branches?: { match: (v: unknown) => boolean; plan: NullPlan }[];
}

interface Converted {
  node: JsonSchema;
  plan?: NullPlan;
}

function convert(src: JsonSchema, depth: number): Converted {
  if (depth > MAX_DEPTH) {
    throw new DockhandError(
      "MODEL_ERROR",
      `schema nests deeper than ${MAX_DEPTH} levels (structured-output limit)`,
    );
  }
  const out: JsonSchema = {};
  const plan: NullPlan = {};
  const notes: string[] = [];

  for (const [key, value] of Object.entries(src)) {
    switch (key) {
      case "properties": {
        const required = new Set(Array.isArray(src.required) ? (src.required as string[]) : []);
        const props: Record<string, JsonSchema> = {};
        const optional: string[] = [];
        const propPlans: Record<string, NullPlan> = {};
        for (const [name, sub] of Object.entries(value as Record<string, JsonSchema>)) {
          const c = convert(sub, depth + 1);
          if (c.plan) propPlans[name] = c.plan;
          if (required.has(name) || acceptsNull(c.node)) {
            props[name] = c.node;
          } else {
            props[name] = nullable(c.node);
            optional.push(name);
          }
        }
        out.properties = props;
        out.required = Object.keys(props);
        if (optional.length > 0) plan.optional = optional;
        if (Object.keys(propPlans).length > 0) plan.properties = propPlans;
        break;
      }
      case "required":
        // Rebuilt with the properties; kept as is on objects without declared properties (enum-keyed records).
        if (src.properties === undefined) out.required = value;
        break;
      case "additionalProperties":
      case "items": {
        if (isSchemaObject(value)) {
          const c = convert(value, depth + 1);
          out[key] = c.node;
          if (c.plan) {
            if (key === "items") plan.items = c.plan;
            else plan.additional = c.plan;
          }
        } else {
          out[key] = value;
        }
        break;
      }
      case "prefixItems": {
        const converted = (value as JsonSchema[]).map((s) => convert(s, depth + 1));
        out.prefixItems = converted.map((c) => c.node);
        if (converted.some((c) => c.plan)) plan.tuple = converted.map((c) => c.plan);
        break;
      }
      case "anyOf":
      case "oneOf": {
        const branches = value as JsonSchema[];
        const converted = branches.map((b) => convert(b, depth));
        out.anyOf = [...((out.anyOf as JsonSchema[] | undefined) ?? []), ...converted.map((c) => c.node)];
        const withPlans = converted.flatMap((c, i) =>
          c.plan ? [{ match: branchMatcher(branches[i] as JsonSchema), plan: c.plan }] : [],
        );
        if (withPlans.length > 0) plan.branches = [...(plan.branches ?? []), ...withPlans];
        break;
      }
      case "allOf":
        // zod 4 merges object intersections itself; anything left here cannot be flattened safely.
        throw new DockhandError(
          "MODEL_ERROR",
          "schema uses allOf: flatten it before sending it as structured output",
        );
      case "pattern":
        if (src.format === undefined && typeof value === "string" && value.length <= MAX_PATTERN_NOTE_CHARS) {
          notes.push(`must match the regular expression ${value}`);
        }
        break;
      case "format":
        notes.push(`format: ${String(value)}`);
        break;
      case "propertyNames":
        if (isSchemaObject(value) && Array.isArray(value.enum)) notes.push(`keys: ${value.enum.join(", ")}`);
        break;
      case "minimum":
      case "maximum":
        // zod adds +/-MAX_SAFE_INTEGER bounds to every int; they carry no information.
        if (typeof value === "number" && Math.abs(value) < Number.MAX_SAFE_INTEGER) out[key] = value;
        break;
      default:
        if (KEPT_KEYWORDS.has(key)) out[key] = value;
    }
  }

  if (isSchemaObject(out.properties) && plan.additional !== undefined)
    plan.knownKeys = Object.keys(out.properties);
  if (notes.length > 0) {
    const description = typeof out.description === "string" ? `${out.description} ` : "";
    out.description = `${description}(${notes.join("; ")})`;
  }
  return Object.keys(plan).length > 0 ? { node: out, plan } : { node: out };
}

function acceptsNull(node: JsonSchema): boolean {
  if (Object.keys(node).length === 0 || (Object.keys(node).length === 1 && "description" in node))
    return true;
  if (node.type === "null") return true;
  if (Array.isArray(node.type) && node.type.includes("null")) return true;
  if (Array.isArray(node.enum) && node.enum.includes(null)) return true;
  if ("const" in node && node.const === null) return true;
  return Array.isArray(node.anyOf) && (node.anyOf as JsonSchema[]).some(acceptsNull);
}

/** Same shapes zod uses for `.nullable()`: a type array for plain primitives, otherwise an anyOf with null. */
function nullable(node: JsonSchema): JsonSchema {
  const plain = node.enum === undefined && !("const" in node);
  if (typeof node.type === "string" && plain && node.type !== "object" && node.type !== "array") {
    return { ...node, type: [node.type, "null"] };
  }
  if (Array.isArray(node.type) && plain) return { ...node, type: [...node.type, "null"] };
  if (Array.isArray(node.anyOf)) return { ...node, anyOf: [...(node.anyOf as JsonSchema[]), NULL_SCHEMA] };
  const { description, ...rest } = node;
  return description === undefined
    ? { anyOf: [rest, NULL_SCHEMA] }
    : { description, anyOf: [rest, NULL_SCHEMA] };
}

/** Picks the union branch a value belongs to: discriminator consts first, then the JSON type. */
function branchMatcher(branch: JsonSchema): (v: unknown) => boolean {
  if (isSchemaObject(branch.properties)) {
    const consts = Object.entries(branch.properties as Record<string, JsonSchema>).flatMap(([k, p]) =>
      isSchemaObject(p) && "const" in p ? [[k, p.const] as const] : [],
    );
    return (v) => isPlainObject(v) && consts.every(([k, c]) => v[k] === c);
  }
  switch (branch.type) {
    case "object":
      return isPlainObject;
    case "array":
      return Array.isArray;
    case "null":
      return (v) => v === null;
    default:
      return () => false;
  }
}

function applyPlan(plan: NullPlan | undefined, value: unknown): unknown {
  if (!plan) return value;
  if (plan.branches) {
    const branch = plan.branches.find((b) => b.match(value));
    if (branch) applyPlan(branch.plan, value);
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      const itemPlan = plan.tuple ? plan.tuple[i] : plan.items;
      if (itemPlan) value[i] = applyPlan(itemPlan, item);
    });
    return value;
  }
  if (isPlainObject(value)) {
    for (const key of plan.optional ?? []) if (value[key] === null) delete value[key];
    for (const [key, child] of Object.entries(value)) {
      const declared = plan.properties?.[key];
      if (declared) value[key] = applyPlan(declared, child);
      else if (plan.additional && !(plan.knownKeys ?? []).includes(key))
        value[key] = applyPlan(plan.additional, child);
    }
  }
  return value;
}

function isSchemaObject(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

import { DockhandError, SkillDraft, Understanding } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type JsonSchema, toWireSchema } from "./schema.ts";

function walk(node: unknown, visit: (n: JsonSchema) => void): void {
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
  } else if (node !== null && typeof node === "object") {
    visit(node as JsonSchema);
    for (const v of Object.values(node)) walk(v, visit);
  }
}

describe("toWireSchema", () => {
  it("lists every property as required, makes optional ones nullable, and keeps real nullables as they are", () => {
    const wire = toWireSchema(
      z.object({
        a: z.string(),
        b: z.string().optional(),
        c: z.number().nullable(),
        d: z.boolean().nullable().optional(),
      }),
    );
    expect(wire.schema).toEqual({
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: ["string", "null"] },
        c: { type: ["number", "null"] },
        d: { type: ["boolean", "null"] },
      },
      required: ["a", "b", "c", "d"],
      additionalProperties: false,
    });
  });

  it("drops $schema, defaults and safe-integer bounds; moves pattern and format into the description", () => {
    const wire = toWireSchema(
      z.object({
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .describe("snake_case name"),
        email: z.email(),
        count: z.number().int().default(1),
      }),
    );
    expect(wire.schema).toEqual({
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "snake_case name (must match the regular expression ^[a-z][a-z0-9_]*$)",
        },
        email: { type: "string", description: "(format: email)" },
        count: { type: "integer" },
      },
      required: ["name", "email", "count"],
      additionalProperties: false,
    });
  });

  it("turns oneOf (discriminated unions) into anyOf and wraps optional enums, consts and objects with a null branch", () => {
    const wire = toWireSchema(
      z.object({
        target: z.discriminatedUnion("by", [
          z.object({ by: z.literal("testid"), value: z.string() }),
          z.object({ by: z.literal("label"), value: z.string(), exact: z.boolean().optional() }),
        ]),
        kind: z.enum(["a", "b"]).optional(),
        commit: z.literal(true).optional(),
        box: z.object({ x: z.number() }).optional(),
      }),
    );
    const props = wire.schema.properties as Record<string, JsonSchema>;
    expect(props.target?.oneOf).toBeUndefined();
    expect(props.target?.anyOf).toHaveLength(2);
    expect(props.kind).toEqual({ anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] });
    expect(props.commit).toEqual({ anyOf: [{ type: "boolean", const: true }, { type: "null" }] });
    expect(props.box).toEqual({
      anyOf: [
        {
          type: "object",
          properties: { x: { type: "number" } },
          required: ["x"],
          additionalProperties: false,
        },
        { type: "null" },
      ],
    });
  });

  it("restores optional fields the model sent as null, in nested objects, arrays, records and union branches", () => {
    const Schema = z.object({
      top: z.string().optional(),
      keep: z.string().nullable(),
      items: z.array(z.object({ label: z.string(), hint: z.string().optional() })),
      meta: z.record(z.string(), z.object({ note: z.string().optional() })).optional(),
      target: z.discriminatedUnion("by", [
        z.object({ by: z.literal("testid"), value: z.string() }),
        z.object({ by: z.literal("label"), value: z.string(), exact: z.boolean().optional() }),
      ]),
    });
    const wire = toWireSchema(Schema);
    const fromModel = {
      top: null,
      keep: null,
      items: [
        { label: "Company", hint: null },
        { label: "Seats", hint: "number" },
      ],
      meta: { a: { note: null } },
      target: { by: "label", value: "Company name", exact: null },
    };

    const restored = wire.restoreOptional(structuredClone(fromModel));

    expect(restored).toEqual({
      keep: null,
      items: [{ label: "Company" }, { label: "Seats", hint: "number" }],
      meta: { a: {} },
      target: { by: "label", value: "Company name" },
    });
    expect(Schema.safeParse(restored).success).toBe(true);
    expect(Schema.safeParse(fromModel).success).toBe(false);
  });

  it("keeps the Understanding contract as is: flat, every field present, nullables unchanged", () => {
    const wire = toWireSchema(Understanding);
    const props = wire.schema.properties as Record<string, JsonSchema>;
    expect(wire.schema.required).toEqual(Object.keys(Understanding.shape));
    expect(props.company).toEqual({ type: ["string", "null"] });
    expect(props.intent?.enum).toEqual(Intent());
    expect(wire.schema.$schema).toBeUndefined();
  });

  it("handles the SkillDraft contract: optional record and ParamSpec fields round-trip through nulls", () => {
    const wire = toWireSchema(SkillDraft);
    const draft = {
      name: "register_partner_deal",
      title: "Register a partner deal",
      portalId: "caravela",
      startUrl: "http://localhost:5101/deals/new",
      goal: "Register the deal",
      steps: ["Open the form", "Fill {{company}}"],
      params: [
        {
          name: "company",
          type: "string",
          required: true,
          description: "Buyer company",
          example: null,
          enumValues: null,
        },
        {
          name: "tier",
          type: "enum",
          required: true,
          description: "Tier",
          example: "Gold",
          enumValues: ["Gold", "Silver"],
        },
      ],
      commitStep: "Submit registration",
      success: "A registration ID is shown",
      observedValues: null,
    };
    const restored = wire.restoreOptional(structuredClone(draft));
    const parsed = SkillDraft.safeParse(restored);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.params[0]).not.toHaveProperty("example");
    expect(parsed.data).not.toHaveProperty("observedValues");
    expect(parsed.data?.params[1]?.enumValues).toEqual(["Gold", "Silver"]);
  });

  it("only uses keywords from the kept list (no propertyNames, $schema, default, oneOf)", () => {
    const wire = toWireSchema(SkillDraft);
    const seen = new Set<string>();
    walk(wire.schema, (n) => {
      for (const k of Object.keys(n)) seen.add(k);
    });
    for (const banned of [
      "$schema",
      "propertyNames",
      "default",
      "oneOf",
      "pattern",
      "format",
      "$ref",
      "$defs",
    ]) {
      expect(seen.has(banned)).toBe(false);
    }
  });

  it("rejects recursive schemas and unrepresentable types with MODEL_ERROR", () => {
    const Node = z.object({
      name: z.string(),
      get children() {
        return z.array(Node);
      },
    });
    expect(() => toWireSchema(Node)).toThrow(DockhandError);
    expect(() => toWireSchema(z.object({ at: z.date() }))).toThrow(/cannot be sent as structured output/);
  });

  it("rejects schemas nested deeper than 10 levels", () => {
    let deep: z.ZodType = z.string();
    for (let i = 0; i < 11; i++) deep = z.object({ next: deep });
    expect(() => toWireSchema(deep)).toThrow(/deeper than 10/);
  });
});

function Intent(): string[] {
  return ["quote", "register_deal", "supplier_onboarding", "teach", "command", "question", "unknown"];
}

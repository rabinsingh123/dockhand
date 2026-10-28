// Every response recorded from the live APIs (fixtures/cassettes, META_MODE=record) still goes through the
// same parsing code: a change to the wire parsers that breaks a real response fails here, without network.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SkillDraft, Understanding, workspaceRoot } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import type { CassetteFile } from "./cassette.ts";
import { incompleteReason, outputText, parseCuTurns, parseResponseBody } from "./responses.ts";
import { toWireSchema } from "./schema.ts";
import { parseJsonReply } from "./structured.ts";

const DIR = join(workspaceRoot(), "fixtures", "cassettes");
const SCHEMAS: Record<string, { safeParse(v: unknown): { success: boolean } } | undefined> = {
  understand: Understanding,
  teach: SkillDraft,
};

function cassettes(): { purpose: string; file: string; data: CassetteFile }[] {
  let purposes: string[] = [];
  try {
    purposes = readdirSync(DIR);
  } catch {
    return [];
  }
  return purposes.flatMap((purpose) =>
    readdirSync(join(DIR, purpose))
      .filter((f) => f.endsWith(".json"))
      .map((file) => ({
        purpose,
        file,
        data: JSON.parse(readFileSync(join(DIR, purpose, file), "utf8")) as CassetteFile,
      })),
  );
}

const all = cassettes();

describe("recorded live responses (fixtures/cassettes)", () => {
  it("exist for the structured and computer-use purposes", () => {
    const purposes = new Set(all.map((c) => c.purpose));
    for (const p of ["extract", "understand", "teach", "cu_first_run", "cu_repair", "heal_match"]) {
      expect(purposes.has(p), `no cassette for ${p}`).toBe(true);
    }
  });

  for (const { purpose, file, data } of all) {
    it(`${purpose}/${file} parses with today's wire code`, () => {
      expect(data.key).toBe(file.replace(/\.json$/, ""));
      expect(data.exchanges.length).toBeGreaterThan(0);
      for (const { response } of data.exchanges) {
        if (purpose === "cu_first_run" || purpose === "cu_repair") {
          const turns = parseCuTurns(parseResponseBody(response));
          expect(turns.length).toBeGreaterThan(0);
          continue;
        }
        if (typeof response === "object" && response !== null && "choices" in response) {
          // Baseten chat completion (heal_match): JSON we validate ourselves.
          const content = (response as { choices: { message?: { content?: string } }[] }).choices[0]?.message
            ?.content;
          expect(parseJsonReply(content ?? "")).toBeTypeOf("object");
          continue;
        }
        const body = parseResponseBody(response);
        if (incompleteReason(body) !== undefined) continue; // recorded budget retries
        const value = parseJsonReply(outputText(body).text);
        const schema = SCHEMAS[purpose];
        if (schema) {
          const restored = toWireSchema(schema as never).restoreOptional(value);
          expect(schema.safeParse(restored).success).toBe(true);
        }
      }
    });
  }
});

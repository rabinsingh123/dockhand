// Live structured-output checks: one understand call (text), image extraction (referral photo) and PDF
// extraction (supplier invitation), each built with the orchestrator's own request builders and compared
// with the fixture's expected JSON.
//
// Usage: META_MODE=live tsx scripts/live/structured.ts [understand|image|pdf|all] [--effort low] [--model m]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Effort, StructuredRequest } from "../../packages/core/src/index.ts";
import {
  type Extraction,
  extractionRequest,
  understandingRequest,
} from "../../packages/orchestrator/src/understand.ts";
import { fixturePath } from "../lib/files.ts";
import { openLive } from "./lib.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { effort: { type: "string" }, model: { type: "string" }, max: { type: "string" } },
});
const which = positionals[0] ?? "all";
const live = openLive(`structured-${which}`);
const NOW = Date.parse("2026-10-27T15:00:00Z");

function tune<T>(req: StructuredRequest<T>): StructuredRequest<T> {
  return {
    ...req,
    ...(values.effort ? { effort: values.effort as Effort } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values.max ? { maxOutputTokens: Number(values.max) } : {}),
  };
}

function norm(s: unknown): string {
  return String(s ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase();
}

/** Every expected value must appear as some extracted field value (field names are the model's choice). */
function gradeFields(extraction: Extraction, expected: Record<string, string>): string[] {
  const got = extraction.fields.map((f) => norm(f.value));
  const misses: string[] = [];
  for (const [k, v] of Object.entries(expected)) {
    if (["consent", "signature"].includes(k)) continue;
    if (!got.some((g) => g === norm(v) || g.includes(norm(v)))) misses.push(`${k}: "${v}"`);
  }
  return misses;
}

function gradeUnderstanding(got: Record<string, unknown>, want: Record<string, unknown>, keys: string[]) {
  return keys
    .filter((k) => norm(got[k]) !== norm(want[k]))
    .map((k) => `${k}: got ${JSON.stringify(got[k])}, want ${JSON.stringify(want[k])}`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    console.log(`\n== ${label}: ok in ${Date.now() - t0} ms`);
    return out;
  } catch (err) {
    console.log(`\n== ${label}: FAILED in ${Date.now() - t0} ms: ${(err as Error).message}`);
    throw err;
  }
}

const UNDERSTAND_KEYS = [
  "intent",
  "language",
  "company",
  "city",
  "country",
  "seats",
  "startDate",
  "contactName",
  "contactEmail",
  "product",
  "closeDate",
  "referralPartner",
  "portalUrl",
  "tenant",
  "inviteCode",
  "buyerName",
];

async function understandText() {
  const voice = JSON.parse(readFileSync(fixturePath("voice/expected.json"), "utf8")) as {
    scripts: { id: string; script: string; expected: Record<string, unknown> }[];
  };
  const vn = voice.scripts.find((s) => s.id === "vn1-register-cafe-aurora");
  if (!vn) throw new Error("voice script vn1 missing");
  const req = tune(
    understandingRequest({
      rep: { tz: "America/Sao_Paulo" },
      nowMs: NOW,
      inputs: [{ kind: "voice", text: vn.script }],
      skills: [],
    }),
  );
  const u = await timed(`understand (${req.model}, effort ${req.effort})`, () =>
    live.models.structured(req, { purpose: "understand", jobId: "live-structured", timeoutMs: 120_000 }),
  );
  console.log(JSON.stringify(u, null, 1));
  const misses = gradeUnderstanding(u as Record<string, unknown>, vn.expected, UNDERSTAND_KEYS);
  console.log(misses.length === 0 ? "graded fields: all match" : `mismatches:\n  ${misses.join("\n  ")}`);
}

async function extract(kind: "image" | "pdf") {
  const file = kind === "image" ? "inbound/referral-cafe-aurora.jpg" : "inbound/acme-supplier-invitation.pdf";
  const expected = JSON.parse(
    readFileSync(fixturePath(file.replace(/\.(jpg|pdf)$/, ".expected.json")), "utf8"),
  ) as Record<string, unknown>;
  const bytes = new Uint8Array(readFileSync(fixturePath(file)));
  const ref = await live.artifacts.put(bytes, kind === "image" ? "image/jpeg" : "application/pdf", {
    kind: "inbound_media",
    jobId: "live-structured",
  });
  const req = tune(extractionRequest({ type: kind, ref }, undefined));
  const ex = await timed(`extract ${kind} (${req.model}, effort ${req.effort})`, () =>
    live.models.structured(req, { purpose: "extract", jobId: "live-structured", timeoutMs: 120_000 }),
  );
  console.log(JSON.stringify(ex, null, 1));
  const want =
    kind === "image"
      ? (expected.asWritten as Record<string, string>)
      : {
          tenantUrl: String(expected.portalUrl),
          inviteCode: String(expected.inviteCode),
          deadline: String(expected.deadlineAsWritten),
          reference: String(expected.reference),
          buyer: String(expected.buyer),
        };
  const misses = gradeFields(ex, want);
  console.log(
    `documentType ${ex.documentType} (want ${expected.kind}), language ${ex.language}; ${
      misses.length === 0 ? "every expected value found" : `values not found:\n  ${misses.join("\n  ")}`
    }`,
  );
  if (kind === "image" || kind === "pdf") {
    // The same path the orchestrator takes next: extraction -> understanding.
    const req2 = tune(
      understandingRequest({
        rep: { tz: "America/Sao_Paulo" },
        nowMs: NOW,
        inputs: [{ kind: "document", source: kind === "image" ? "photo" : "pdf", extraction: ex }],
        skills: [],
      }),
    );
    const u = await timed(`understand from ${kind} extraction`, () =>
      live.models.structured(req2, { purpose: "understand", jobId: "live-structured", timeoutMs: 120_000 }),
    );
    const keys =
      kind === "pdf"
        ? (expected.gradedUnderstandingFields as string[])
        : UNDERSTAND_KEYS.filter((k) => !["startDate"].includes(k));
    const um = gradeUnderstanding(
      u as Record<string, unknown>,
      expected.understanding as Record<string, unknown>,
      keys,
    );
    console.log(
      um.length === 0
        ? "understanding: graded fields match"
        : `understanding mismatches:\n  ${um.join("\n  ")}`,
    );
  }
}

try {
  if (which === "understand" || which === "all") await understandText().catch(() => undefined);
  if (which === "image" || which === "all") await extract("image").catch(() => undefined);
  if (which === "pdf" || which === "all") await extract("pdf").catch(() => undefined);
} finally {
  console.log(`\n${live.report()}`);
  live.close();
}

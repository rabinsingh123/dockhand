// The submit message: every value read back from the page, in a WhatsApp button body (1024 characters at most),
// and the ask at the end always whole.

import type { ArtifactRef } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import { type FlowEnv, gateHooks } from "./env.ts";

const REF: ArtifactRef = { id: "a1", sha256: "0", mime: "image/png", bytes: 1, relPath: "a/1.png" };

/** The body approveCommit hands to the approval broker (before any clipping). */
async function submitBody(readback: { label: string; value: string }[]): Promise<string> {
  let body = "";
  const env = {
    gateTtlMs: 60_000,
    park: <T>(p: Promise<T>) => p,
    log: { warn() {}, info() {}, error() {} },
    artifacts: { read: async () => Promise.reject(new Error("no bytes in this test")) },
    phoneCards: { render: async () => REF },
    approvals: {
      async open(g: { body: string }) {
        body = g.body;
        return { gateId: "g1", decision: Promise.resolve("approved" as const) };
      },
    },
  } as unknown as FlowEnv;
  const hooks = gateHooks(
    env,
    { id: "j1", rep: { phone: "5511999990000" } as never },
    { runId: "r1", origin: "http://127.0.0.1", portalName: "Supplier Portal", extendLease() {} },
  );
  await hooks.approveCommit({ summary: "Submit", screenshot: REF, readback });
  return body;
}

const chars = (s: string) => [...s].length;
const ASK = /\nApprove to submit\. Nothing is (sent|submitted) until you tap\.$/;

describe("the submit message", () => {
  it("keeps the ask whole when the read-back fills the list right up to its old budget", async () => {
    // Ten 87-character lines filled the old 880-character list exactly; with the head, the "more" line and the
    // ask, the body came to 1030 characters and the ask was clipped.
    const lines = Array.from({ length: 37 }, (_, i) => ({
      label: `Field ${String(i + 1).padStart(2, "0")}`,
      value: "x".repeat(87 - `Field 01: `.length),
    }));
    const body = await submitBody(lines);
    expect(chars(body)).toBeLessThanOrEqual(1024);
    expect(body).toMatch(ASK);
    expect(body).toMatch(/\n\d+ more on the form above\.\n/);
  });

  it("fits 37 long values, accents and emoji included", async () => {
    const lines = Array.from({ length: 37 }, (_, i) => ({
      label: `Campo ${i + 1} — endereço de cobrança`,
      value: `Rua das Marés, ${400 + i}, Conjunto 81, 8º andar, São Paulo 🌊 ${"ç".repeat(i * 3)}`,
    }));
    const body = await submitBody(lines);
    expect(chars(body)).toBeLessThanOrEqual(1024);
    expect(body).toMatch(ASK);
    expect(body.startsWith("Ready to submit on Supplier Portal. 37 fields, read back from the page:\n")).toBe(
      true,
    );
  });

  it("keeps the ask when a single value is longer than the whole body", async () => {
    const body = await submitBody([
      { label: "Legal name", value: "Tidewater Cloud Ltda." },
      { label: "Notes", value: "Seis lojas, decisão dos sócios em janeiro. ".repeat(40) },
    ]);
    expect(chars(body)).toBeLessThanOrEqual(1024);
    expect(body).toMatch(ASK);
    expect(body).toContain("Legal name: Tidewater Cloud Ltda.");
  });

  it("lists every value when they fit", async () => {
    const body = await submitBody([
      { label: "Legal name", value: "Tidewater Cloud Ltda." },
      { label: "Tax ID", value: "00-1234567" },
    ]);
    expect(body.split("\n")).toEqual([
      "Ready to submit on Supplier Portal. 2 fields, read back from the page:",
      "Legal name: Tidewater Cloud Ltda.",
      "Tax ID: 00-1234567",
      expect.stringMatching(/^Approve to submit\./),
    ]);
  });
});

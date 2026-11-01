// A repair card says only what the job's ledger recorded: the cost, and the open-weights credit only for a
// real Baseten heal (never fake, cassette or scripted).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLedger, type Db, openDb, type Step } from "@dockhand/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { diffCardLedger, diffPhoneCardHtml } from "./phone-cards.ts";

let dir: string;
let db: Db;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockhand-cards-"));
  db = openDb(join(dir, "dockhand.sqlite"));
});

afterAll(async () => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(runId: string, provider: string, costUsd: number): void {
  db.raw
    .prepare(
      `INSERT INTO model_calls (ts, purpose, provider, model, run_id, input_tokens, output_tokens, latency_ms, cost_usd, status)
       VALUES (?, 'heal_match', ?, 'meta-models/muse-spark-open', ?, 800, 40, 1200, ?, 'ok')`,
    )
    .run(Date.now(), provider, runId, costUsd);
}

const field = (id: string, label: string): Step => ({
  id,
  op: "fill",
  intent: `Fill ${label}`,
  value: "{{x}}",
  target: {
    candidates: [{ by: "testid", value: label.toLowerCase().replace(/\W+/g, "-") }],
    fingerprint: { tag: "input", role: "textbox", label, name: label, bbox: { x: 0, y: 0, w: 10, h: 10 } },
  },
});

function card(costUsd: number, usedOpenWeights: boolean, changes = 1, newParams = 0): string {
  const before = Array.from({ length: changes }, (_, i) => field(`s${i + 1}`, `Old field ${i + 1}`));
  const after = Array.from({ length: changes }, (_, i) => field(`s${i + 1}`, `New field name ${i + 1}`));
  const params = [{ name: "company_name", type: "string" as const, required: true, description: "Company" }];
  return diffPhoneCardHtml({
    portalName: "Caravela Partner Hub",
    parent: { name: "register_partner_deal", version: 1, steps: before, params },
    saved: {
      name: "register_partner_deal",
      version: 2,
      title: "Register a deal",
      steps: after,
      params: [
        ...params,
        ...Array.from({ length: newParams }, (_, i) => ({
          name: `new_value_${i + 1}`,
          type: "enum" as const,
          required: true,
          description: `New ${i + 1}`,
        })),
      ],
    },
    steps: after.map((s, idx) => ({
      idx,
      stepId: s.id,
      status: "repaired" as const,
      rung: "open_weights" as const,
      ms: 900,
    })),
    canary: { passed: 3, total: 3 },
    costUsd,
    usedOpenWeights,
  });
}

describe("repair card numbers come from the ledger", () => {
  it('fake and scripted heals record no cost: no cost figure (never "$0" for a paid rung), no credit', () => {
    for (const provider of ["fake", "cassette", "scripted"]) {
      const runId = `R-${provider}`;
      call(runId, provider, 0);
      const facts = diffCardLedger({ db, ledger: createLedger(db) }, "J1", runId);
      expect(facts).toEqual({ costUsd: 0, usedOpenWeights: false });
      const html = card(facts.costUsd, facts.usedOpenWeights);
      expect(html).not.toContain("to repair");
      expect(html).not.toContain("Built with Muse Spark Open");
    }
  });

  it("a real Baseten heal: its recorded cost and the credit", () => {
    call("R-live", "baseten", 0.0031);
    const facts = diffCardLedger({ db, ledger: createLedger(db) }, "J1", "R-live");
    expect(facts.usedOpenWeights).toBe(true);
    expect(facts.costUsd).toBeCloseTo(0.0031, 6);
    const html = card(facts.costUsd, facts.usedOpenWeights);
    expect(html).toContain("$0.0031");
    expect(html).toContain("Built with Muse Spark Open");
  });
});

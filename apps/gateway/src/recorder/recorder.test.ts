// Flight recorder: pages render from the ledger, artifacts stream with ranges, unknown ids are 404s, and
// everything that came from the ledger is escaped.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ArtifactStore,
  createArtifactStore,
  type Db,
  openDb,
  type SkillBody,
  type Step,
  systemClock,
} from "@dockhand/core";
import { createSkillStore } from "@dockhand/skills";
import type { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRecorder } from "./index.ts";

let dir: string;
let db: Db;
let artifacts: ArtifactStore;
let app: Hono;
let shotId = "";

const fp = (label: string, testId: string) => ({
  tag: "input",
  role: "textbox",
  name: label,
  label,
  testId,
  bbox: { x: 163, y: 290, w: 634, h: 38 },
});

function body(label: string, testId: string): SkillBody {
  const steps: Step[] = [
    { id: "s1", op: "goto", intent: "Open the form", url: "http://127.0.0.1:5101/deals/new" },
    {
      id: "s2",
      op: "fill",
      intent: "Enter the end customer's company",
      target: { candidates: [{ by: "testid", value: testId }], fingerprint: fp(label, testId) },
      value: "{{company_name}}",
    },
    {
      id: "s3",
      op: "click",
      intent: "Submit the registration",
      commit: true,
      target: {
        candidates: [{ by: "role", role: "button", name: "Submit registration", exact: true }],
        fingerprint: {
          tag: "button",
          role: "button",
          name: "Submit registration",
          bbox: { x: 600, y: 700, w: 160, h: 38 },
        },
      },
    },
  ];
  return {
    name: "register_partner_deal",
    title: "Register a <b>deal</b>",
    portalId: "caravela",
    params: [{ name: "company_name", type: "string", required: true, description: "End customer company" }],
    steps,
    success: { textPattern: "NW-REG-\\d+", extract: [{ name: "registration_id", regex: "NW-REG-\\d+" }] },
    createdFrom: { kind: "video", draftId: "D1", traceRunId: "R1" },
    changelog: "",
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "dockhand-recorder-"));
  db = openDb(join(dir, "dockhand.sqlite"));
  artifacts = createArtifactStore(db, dir, systemClock);
  const png = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    ),
  );
  shotId = (await artifacts.put(png, "image/png", { kind: "screenshot", runId: "R2" })).id;
  const skills = createSkillStore(db, systemClock);
  skills.saveVersion(body("End customer company", "company"), null, true, "compile", "R1");
  skills.saveVersion(body("Customer account name", "account-name"), 1, true, "heal", "R2");
  const now = Date.now();
  db.raw
    .prepare(
      "INSERT INTO skill_drafts (id, name, json, job_id, status, created_at) VALUES ('D1', 'register_partner_deal', ?, NULL, 'compiled', ?)",
    )
    .run(
      JSON.stringify({
        name: "register_partner_deal",
        title: "Register a partner deal",
        portalId: "caravela",
        startUrl: "http://127.0.0.1:5101/deals/new",
        goal: "Register the referral",
        steps: ["Type {{company_name}} into End customer company", "Click Submit registration"],
        params: [{ name: "company_name", type: "string", required: true, description: "Company" }],
        commitStep: "Submit registration",
        success: "A registration ID like NW-REG-12345",
        observedValues: { company_name: "Padaria Estrela Ltda." },
      }),
      now,
    );
  db.raw
    .prepare(
      "INSERT INTO jobs (id, rep, status, created_at, updated_at) VALUES ('J1', '5511999990000', 'succeeded', ?, ?)",
    )
    .run(now, now);
  db.raw
    .prepare(
      `INSERT INTO runs (id, job_id, mode, skill_name, skill_version, portal_id, params_json, outcome, started_at, ended_at, ms,
        exec_cost_usd, model_calls, final_screenshot_id, extracted_json)
       VALUES ('R2', 'J1', 'repair', 'register_partner_deal', 1, 'caravela', ?, 'success', ?, ?, 3120, 0.0004, 1, ?, ?)`,
    )
    .run(
      JSON.stringify({ company_name: "Café Aurora Ltda." }),
      now,
      now + 3120,
      shotId,
      JSON.stringify({ registration_id: "NW-REG-48213" }),
    );
  const step = db.raw.prepare(
    "INSERT INTO run_steps (run_id, idx, step_id, op, status, rung, ms) VALUES ('R2', ?, ?, ?, ?, ?, ?)",
  );
  step.run(0, "s1", "goto", "ok", null, 210);
  step.run(1, "s2", "fill", "repaired", "open_weights", 1240);
  step.run(2, "s3", "click", "ok", null, 2400);
  db.raw
    .prepare(
      `INSERT INTO model_calls (ts, purpose, provider, model, run_id, step_idx, input_tokens, output_tokens, latency_ms, cost_usd, status)
       VALUES (?, 'heal_match', 'baseten', 'meta-models/muse-spark-open', 'R2', 1, 812, 41, 1180, 0.0004, 'ok')`,
    )
    .run(now);
  db.raw
    .prepare(
      `INSERT INTO gates (id, job_id, run_id, kind, status, body, image_artifact_id, expires_at, created_at)
       VALUES ('G1', 'J1', 'R2', 'commit', 'approved', ?, ?, ?, ?)`,
    )
    .run(
      "Ready to submit on Caravela Partner Hub. Check the filled form:\n• Customer account name: Café Aurora Ltda.\n\nApprove to submit.",
      shotId,
      now + 60_000,
      now,
    );
  const keep = (runId: string, dryRun: boolean) =>
    artifacts.put(
      new TextEncoder().encode(
        JSON.stringify({
          runId,
          dryRun,
          checked: 1,
          matched: 1,
          rows: [
            {
              stepId: "s2",
              label: "Customer account name",
              expected: "Café Aurora Ltda.",
              actual: "Café Aurora Ltda.",
              ok: true,
            },
          ],
        }),
      ),
      "application/json",
      { kind: "readback", runId },
    );
  await keep("R2", false);
  await keep("R2-canary-c0", true);
  app = createRecorder({ db, artifacts, cacheDir: join(dir, "frames"), base: "/recorder/" });
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

const get = (path: string, init?: RequestInit) => app.request(`http://local${path}`, init);

describe("flight recorder", () => {
  it("lists runs, skills and drafts", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("/recorder/runs/R2");
    expect(page).toContain("register_partner_deal");
    expect(page).toContain("Register a &lt;b&gt;deal&lt;/b&gt;"); // escaped, never markup
  });

  it("shows a run: steps, the rung that fixed one, the model call and the read-back", async () => {
    const page = await (await get("/runs/R2")).text();
    expect(page).toContain("Enter the end customer&#39;s company");
    expect(page).toContain("rung 2 · Muse Spark Open");
    expect(page).toContain("NW-REG-48213");
    expect(page).toContain("Read-back before submit");
    expect(page).toContain("1/1 verified");
    expect(page).toContain("Dry runs before the new version went live");
    expect(page).toContain("canary-c0");
    expect(page).toContain(`/recorder/a/${shotId}`);
  });

  it("shows a skill version with its diff against the parent and the Playwright export", async () => {
    const page = await (await get("/skills/register_partner_deal?v=2")).text();
    expect(page).toContain("What changed: v1 → v2");
    expect(page).toContain("testid=company");
    expect(page).toContain("testid=account-name");
    expect(page).toContain("Playwright export");
    expect(page).toContain("registerPartnerDeal");
  });

  it("shows a teach draft with typed params and the values seen in the video", async () => {
    const page = await (await get("/teach/D1")).text();
    expect(page).toContain('<span class="pchip">company_name</span>');
    expect(page).toContain("Padaria Estrela Ltda.");
    expect(page).toContain("A registration ID like NW-REG-12345");
  });

  it("streams artifacts with byte ranges and 404s unknown ids", async () => {
    const full = await get(`/a/${shotId}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("image/png");
    const bytes = new Uint8Array(await full.arrayBuffer());
    const part = await get(`/a/${shotId}`, { headers: { range: "bytes=0-7" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 0-7/${bytes.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(0, 8));
    expect((await get("/a/NOPE")).status).toBe(404);
    expect((await get("/runs/NOPE")).status).toBe(404);
    expect((await get("/skills/nope")).status).toBe(404);
    expect((await get("/runs/..%2F..%2Fetc")).status).toBe(404);
  });
});

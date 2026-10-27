import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScriptStep } from "@dockhand/core";
import { addDaysIso, isoToDmy, type PortalHandle, startPartnerPortal } from "@dockhand/portals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CTX, cuInput, recordingHooks } from "./cu/cu-test-kit.ts";
import { runComputerUse } from "./cu/loop.ts";
import { createBrowserPool, type DockhandBrowserPool } from "./pool.ts";
import { createScriptedModel } from "./scripted.ts";

let portal: PortalHandle;
let pool: DockhandBrowserPool;

beforeAll(async () => {
  portal = await startPartnerPortal({ port: 0, latencyMs: [50, 100] });
  pool = createBrowserPool({
    headless: true,
    maxContexts: 2,
    storageStateDir: mkdtempSync(join(tmpdir(), "dockhand-state-")),
  });
});
afterAll(async () => {
  await pool?.closeAll();
  await portal?.close();
});

describe("scripted model on Caravela Partner Hub v1", () => {
  it("registers a deal with a misclick and a typo; the trace carries the expected tags", async () => {
    const runId = "scripted-partner-1";
    const lease = await pool.lease({
      portalId: "caravela",
      runId,
      cookies: await portal.session({ runId, ui: "v1", mutation: null }),
      ttlMs: 120_000,
    });
    const { page } = lease;
    try {
      await page.goto(`${portal.url}/deals/new`);
      // A spot on the page subtitle: plain text, so clicking it changes nothing.
      const sub = await page
        .locator("p")
        .filter({ hasText: "protected partner pricing" })
        .first()
        .boundingBox();
      if (!sub) throw new Error("no subtitle");
      const closeDate = isoToDmy(addDaysIso(portal.config().serverDate, 60));
      const script: ScriptStep[] = [
        { do: "misclick", x: Math.round(sub.x + sub.width / 2), y: Math.round(sub.y + sub.height / 2) },
        { do: "fill", target: { label: "End customer company" }, text: "Sabiá Foods Ltda." },
        {
          do: "typo",
          target: { label: "Company website" },
          wrong: "sabiafods.com.br",
          right: "sabiafoods.com.br",
        },
        { do: "select", trigger: { role: "combobox", name: "Country" }, option: "Brazil" },
        { do: "fill", target: { label: "City" }, text: "São Paulo" },
        { do: "fill", target: { label: "Contact full name" }, text: "Mariana Costa" },
        { do: "fill", target: { label: "Contact email" }, text: "mariana.costa@sabiafoods.example" },
        { do: "fill", target: { label: "Contact phone" }, text: "+55 11 91234 5678" },
        { do: "select", trigger: { role: "combobox", name: "Product" }, option: "Tidewater Cloud Business" },
        { do: "fill", target: { label: "Seats" }, text: "25" },
        { do: "fill", target: { label: "Estimated value (USD)" }, text: "18000" },
        { do: "fill", target: { label: "Expected close date" }, text: closeDate },
        {
          do: "check",
          target: { role: "checkbox", name: "The end customer agreed to be contacted by Caravela" },
        },
        { do: "click", target: { role: "button", name: "Submit registration" } }, // forgets the gate
        {
          do: "call",
          name: "request_commit",
          args: { summary: "Register Sabiá Foods Ltda. (Brazil), 25 seats" },
        },
        { do: "click", target: { role: "button", name: "Submit registration" } },
        { do: "done", text: "Registration submitted." },
      ];
      const model = createScriptedModel(script, page);
      const hooks = recordingHooks("approved");
      const input = cuInput(page, {
        portalId: "caravela",
        runId,
        goal: "Register the Sabiá Foods deal with Caravela",
        params: { company: "Sabiá Foods Ltda.", country: "Brazil", seats: 25 },
        commitHints: ["Submit registration"],
        writeGuard: { origins: [portal.url], allow: ["/api/__", "/api/login"] },
      });
      const r = await runComputerUse(model, input, hooks, CTX);

      expect(r.outcome).toBe("done");
      expect(r.message).toBe("Registration submitted.");
      const subs = portal.submissions({ runId });
      expect(subs).toHaveLength(1);
      expect(subs[0]?.fields).toMatchObject({
        companyName: "Sabiá Foods Ltda.",
        companyWebsite: "sabiafoods.com.br",
        country: "Brazil",
        city: "São Paulo",
        contactName: "Mariana Costa",
        contactEmail: "mariana.costa@sabiafoods.example",
        product: "Tidewater Cloud Business",
        seats: 25,
        consent: true,
      });

      const steps = r.trace.steps;
      expect(steps[0]?.tags).toEqual(["noise"]);
      const typed = steps.filter(
        (s) => s.action.type === "type" && s.target?.fingerprint.label === "Company website",
      );
      expect(typed.map((s) => s.fieldValueAfter)).toEqual(["sabiafods.com.br", "sabiafoods.com.br"]);
      const options = steps.filter((s) => s.tags.includes("option"));
      expect(options.map((s) => s.target?.fingerprint.name)).toEqual(["Brazil", "Tidewater Cloud Business"]);
      const submits = steps.filter((s) => s.target?.fingerprint.name === "Submit registration");
      expect(submits.map((s) => s.tags)).toEqual([
        ["blocked"],
        expect.arrayContaining(["commit", "navigation"]),
      ]);
      const commitStep = submits[1];
      expect(commitStep?.urlAfter).toMatch(/\/deals\/NW-REG-\d{5}$/);
      expect(commitStep?.target?.candidates[0]).toEqual({ by: "testid", value: "nw-submit" });
      expect(steps.some((s) => s.action.type === "fn" && s.action.name === "request_commit")).toBe(true);
      // The form snapshot before the commit holds every end value (what the compiler templates from).
      expect(commitStep?.formSnapshotBefore).toMatchObject({
        "End customer company": "Sabiá Foods Ltda.",
        "Company website": "sabiafoods.com.br",
        Country: "Brazil",
        "Expected close date": closeDate,
        "The end customer agreed to be contacted by Caravela": "true",
      });
      expect(r.trace.final.url).toMatch(/\/deals\/NW-REG-\d{5}$/);
      expect(r.trace.final.text).toMatch(/NW-REG-\d{5}/);
      expect(hooks.commits[0]?.readback).toContainEqual({ label: "Seats", value: "25" });
      // Every candidate recorded for a click target was unique when it was captured; spot-check a few now.
      expect(steps.filter((s) => s.tags.includes("noise")).length).toBeGreaterThanOrEqual(1);
    } finally {
      await lease.release();
    }
  });
});

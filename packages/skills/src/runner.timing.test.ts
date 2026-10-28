// Reported times are machine time: the rep's approval wait is not in RunResult.ms or the commit step's ms.

import { DH_SCRIPT } from "@dockhand/browser";
import { createMemoryArtifactStore, type ParamValue, type Skill } from "@dockhand/core";
import { addDaysIso, type PortalHandle, startPartnerPortal } from "@dockhand/portals";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PARTNER_PARAM_SPECS, partnerTrace } from "./__fixtures__/partner-trace.ts";
import { compile } from "./compile.ts";
import { runSkill } from "./runner.ts";

let browser: Browser;
let portal: PortalHandle;
let skill: Skill;
const artifacts = createMemoryArtifactStore();

beforeAll(async () => {
  [browser, portal] = await Promise.all([
    chromium.launch({ headless: true }),
    startPartnerPortal({ port: 0, latencyMs: [0, 0] }),
  ]);
  const compiled = compile(partnerTrace(portal.url), {
    name: "register_partner_deal",
    title: "Register a deal on Caravela Partner Hub",
    params: PARTNER_PARAM_SPECS,
    createdFrom: { kind: "goal", traceRunId: "01JTRACERUN0000000000000001" },
  }).skill;
  skill = { ...compiled, version: 1, parentVersion: null };
});

afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

function params(): Record<string, ParamValue> {
  return {
    company: "Cajá Logística S.A.",
    website: "caja-logistica.com.br",
    country: "Chile",
    city: "Valparaíso",
    contact_name: "Rodrigo Pereira",
    contact_email: "rodrigo.pereira@caja-logistica.com.br",
    contact_phone: "+56 9 8765 4321",
    product: "Tidewater Cloud Enterprise",
    seats: 340,
    est_value: 255000,
    close_date: addDaysIso(portal.config().serverDate, 120),
    notes: "Expansion to the Santiago office",
  };
}

describe("runner timing", () => {
  it("leaves the rep's approval wait out of RunResult.ms and the commit step", async () => {
    const runId = `timing-${process.pid}`;
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await context.addInitScript({ content: DH_SCRIPT });
    await context.addCookies(await portal.session({ ui: "v1", mutation: null, runId }));
    const page = await context.newPage();
    const WAIT = 1500;
    try {
      const t0 = performance.now();
      const r = await runSkill(
        page,
        skill,
        params(),
        {
          approveCommit: () => new Promise((ok) => setTimeout(() => ok("approved"), WAIT)),
          approveSafety: async () => "rejected",
        },
        { runId, stepTimeoutMs: 2000, screenshots: "fail_only", allowFallbackHeal: true, artifacts },
      );
      const wall = performance.now() - t0;
      expect(r.outcome).toBe("success");
      expect(wall - r.ms).toBeGreaterThanOrEqual(WAIT - 50);
      const commit = r.steps.find((s) => s.stepId === skill.steps.find((x) => "commit" in x && x.commit)?.id);
      expect(commit?.ms).toBeLessThan(WAIT);
    } finally {
      await context.close();
    }
  });
});

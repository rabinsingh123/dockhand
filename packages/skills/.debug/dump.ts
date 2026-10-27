import { DH_SCRIPT, describeLocator } from "@dockhand/browser";
import { createMemoryArtifactStore, type Skill, type Step } from "@dockhand/core";
import { addDaysIso, startPartnerPortal } from "@dockhand/portals";
import { chromium } from "playwright";
import { createLocalFakeGateway, promptText } from "../src/__fixtures__/fake-models.ts";
import { PARTNER_PARAM_SPECS, partnerTrace } from "../src/__fixtures__/partner-trace.ts";
import { compile } from "../src/compile.ts";
import { createOpenWeightsRepairer } from "../src/repair.ts";
import { runSkill } from "../src/runner.ts";
import { stepTarget, withStepTarget } from "../src/targets.ts";

const browser = await chromium.launch();
const portal = await startPartnerPortal({ port: 0, latencyMs: [10, 40] });
const open = async (s: any) => {
  const c = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
  await c.addInitScript({ content: DH_SCRIPT });
  await c.addCookies(await portal.session(s));
  return { page: await c.newPage(), c };
};
const compiled = compile(partnerTrace(portal.url), {
  name: "register_partner_deal",
  title: "t",
  params: PARTNER_PARAM_SPECS,
  createdFrom: { kind: "goal", traceRunId: "x" },
}).skill;
let skill: Skill = { ...compiled, version: 1, parentVersion: null };
{
  const { page, c } = await open({ ui: "v1", mutation: null, runId: "rc" });
  await page.goto(`${portal.url}/deals`);
  const steps: Step[] = [];
  for (const s of skill.steps) {
    if (s.op === "waitFor" && s.urlIncludes === "/deals/new") await page.goto(`${portal.url}/deals/new`);
    const t = stepTarget(s);
    const tid = t?.candidates.find((x) => x.by === "testid");
    steps.push(
      t && tid?.by === "testid" ? withStepTarget(s, await describeLocator(page.getByTestId(tid.value))) : s,
    );
  }
  skill = { ...skill, steps };
  await c.close();
}
for (const s of skill.steps) {
  const t = stepTarget(s);
  if (t) console.log(s.id, JSON.stringify(t.candidates));
}
const gw = createLocalFakeGateway((req) => {
  const lines = promptText(req).split("\n");
  const p = "Element the step used before the change: ";
  const old = JSON.parse(lines.find((l) => l.startsWith(p))!.slice(p.length));
  const list = JSON.parse(lines[lines.indexOf("Elements of the same kind on the page now:") + 1]!);
  const ren: any = { "Submit registration": "Register opportunity", Product: "Solution" };
  const on = old.label ?? old.name;
  const w = ren[on] ?? on;
  const hit = list.find((e: any) => e.name === w || e.label === w);
  return hit
    ? { index: hit.index, confidence: 0.9, reason: "x" }
    : { index: null, confidence: 0, reason: "none" };
});
const params = {
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
  notes: "x",
};
for (const [label, sess] of [
  ["v2", { ui: "v2", mutation: null }],
  ["churn", { ui: "v1", mutation: { seed: 7, operators: ["testid_churn"] } }],
  ["synonym", { ui: "v1", mutation: { seed: 5, operators: ["label_synonym"] } }],
  [
    "reorder",
    {
      ui: "v1",
      mutation: { seed: 9, operators: ["reorder_fields", "wrapper_divs", "class_churn", "id_churn"] },
    },
  ],
] as const) {
  const runId = `dbg-${label}`;
  const { page, c } = await open({ ...sess, runId });
  const t0 = Date.now();
  gw.calls.length = 0;
  const r = await runSkill(
    page,
    skill,
    params,
    {
      approveCommit: async () => "approved",
      approveSafety: async () => "rejected",
      repairers: [createOpenWeightsRepairer(gw, { model: "m" })],
    },
    {
      runId,
      stepTimeoutMs: 1500,
      screenshots: "fail_only",
      allowFallbackHeal: true,
      artifacts: createMemoryArtifactStore(),
    },
  );
  console.log(
    `\n== ${label}: ${r.outcome} ${r.errorCode ?? ""} ${r.error ?? ""} ms=${r.ms} wall=${Date.now() - t0} modelCalls=${gw.calls.length}`,
  );
  console.log(
    r.steps
      .map(
        (s) =>
          `${s.stepId}:${s.status}${s.rung ? "/" + s.rung : ""}${s.candidateIdx !== undefined ? "#" + s.candidateIdx : ""}(${s.ms})`,
      )
      .join(" "),
  );
  const sub = portal.submissions({ runId })[0];
  console.log("submitted:", sub ? JSON.stringify(sub.fields) : "none");
  if (r.patched) console.log("changelog:\n" + r.patched.changelog);
  await c.close();
}
await browser.close();
await portal.close();

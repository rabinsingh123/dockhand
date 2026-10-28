// Live teach check: the Caravela screen recording -> Files API -> SkillDraft with the orchestrator's own
// teach request, graded against fixtures/teach/caravela-register-deal.expected.json.
//
// Usage: META_MODE=live tsx scripts/live/teach.ts [--model muse-wonder-1.0] [--effort medium] [--fps 2]

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Effort, SkillDraft } from "../../packages/core/src/index.ts";
import { normalizeDraft, teachRequest } from "../../packages/orchestrator/src/flows/teach.ts";
import { PORTAL_DEFAULTS, type PortalDirectory } from "../../packages/orchestrator/src/portals.ts";
import { fixturePath } from "../lib/files.ts";
import { openLive } from "./lib.ts";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    effort: { type: "string" },
    fps: { type: "string" },
  },
});

interface GradedParam {
  name: string;
  aliases: string[];
  observed: string;
}
interface Expected {
  draft: SkillDraft;
  grading: {
    requiredParams: GradedParam[];
    optionalParams: GradedParam[];
    comboboxParams: string[];
    commitStep: string;
    success: { textPattern: string; idRegex: string };
  };
}

const live = openLive("teach");
const portals: PortalDirectory = Object.fromEntries(
  Object.values(PORTAL_DEFAULTS).map((p, i) => [
    p.id,
    {
      ...p,
      url: `http://localhost:${5101 + i}`,
      writeGuardAllow: [],
      session: async () => [],
    },
  ]),
);

/** Grades a draft like a reviewer would: params found by name or alias, no observed value in steps. */
export function gradeDraft(d: SkillDraft, exp: Expected): string[] {
  const issues: string[] = [];
  const names = new Set(d.params.map((p) => p.name));
  const find = (g: GradedParam) => [g.name, ...g.aliases].find((n) => names.has(n));
  for (const g of exp.grading.requiredParams) {
    const name = find(g);
    if (!name) issues.push(`required param missing: ${g.name}`);
    else if (!d.params.find((p) => p.name === name)?.required)
      issues.push(`param ${name} not marked required`);
  }
  for (const g of exp.grading.optionalParams) if (!find(g)) issues.push(`optional param missing: ${g.name}`);
  for (const c of exp.grading.comboboxParams) {
    const g = [...exp.grading.requiredParams, ...exp.grading.optionalParams].find((x) => x.name === c);
    const p = g ? d.params.find((x) => x.name === find(g)) : undefined;
    if (p && !(p.enumValues ?? []).includes(g?.observed ?? ""))
      issues.push(`combobox ${p.name} lacks "${g?.observed}" in enumValues`);
  }
  if (d.commitStep.trim().toLowerCase() !== exp.grading.commitStep.toLowerCase())
    issues.push(`commitStep "${d.commitStep}" (want "${exp.grading.commitStep}")`);
  if (!new RegExp(exp.grading.success.textPattern, "i").test(d.success))
    issues.push(`success does not mention "${exp.grading.success.textPattern}"`);
  const steps = d.steps.join("\n");
  for (const g of [...exp.grading.requiredParams, ...exp.grading.optionalParams]) {
    if (g.observed.length > 3 && steps.includes(g.observed))
      issues.push(`observed value leaked into steps: ${g.observed}`);
  }
  const consent =
    d.steps.some((s) => /consent|agreed to be contacted|contacted by caravela/i.test(s)) ||
    names.has("consent");
  if (!consent) issues.push("no consent checkbox step");
  return issues;
}

try {
  const expected = JSON.parse(
    readFileSync(fixturePath("teach/caravela-register-deal.expected.json"), "utf8"),
  ) as Expected;
  const bytes = new Uint8Array(readFileSync(fixturePath("teach/caravela-register-deal.mp4")));
  const video = await live.artifacts.put(bytes, "video/mp4", { kind: "inbound_media", jobId: "live-teach" });
  const base = teachRequest(video, undefined, portals);
  const req = {
    ...base,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort as Effort } : {}),
    ...(values.fps
      ? { input: base.input.map((p) => (p.type === "video" ? { ...p, fps: Number(values.fps) } : p)) }
      : {}),
  };
  console.log(`teach: ${req.model}, effort ${req.effort}, video ${(bytes.byteLength / 1e6).toFixed(1)} MB`);
  const t0 = Date.now();
  const raw = await live.models.structured(req, {
    purpose: "teach",
    jobId: "live-teach",
    timeoutMs: 300_000,
  });
  const draft = normalizeDraft(raw, portals);
  console.log(`ok in ${Date.now() - t0} ms`);
  console.log(JSON.stringify(draft, null, 1));
  const issues = gradeDraft(draft, expected);
  console.log(
    issues.length === 0 ? "\ngrade: every check passed" : `\ngrade issues:\n  ${issues.join("\n  ")}`,
  );
} catch (err) {
  console.log(`teach FAILED: ${(err as Error).message}`);
} finally {
  console.log(`\n${live.report()}`);
  live.close();
}

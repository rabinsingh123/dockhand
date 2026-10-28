// Teach once on real software: records a human-paced screen recording of creating a Lead in EspoCRM (the
// kind of video a rep sends), then, with --teach, sends it to Muse Wonder with the orchestrator's own teach
// request. The draft is saved with a map from its param names to the adapter's fields, found by matching
// the draft's observedValues against the values typed in the recording (so a first run can use it).
//
// Usage: tsx scripts/oss/espocrm-teach.ts [--teach] [--effort medium]
//   (--teach needs META_MODE=live; output in $DOCKHAND_VAR_DIR/espocrm/teach-*.{mp4,json})

import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, promisify } from "node:util";
import { chromium } from "playwright";
import type { Effort, ParamValue, SkillDraft } from "../../packages/core/src/index.ts";
import { normalizeDraft, teachRequest } from "../../packages/orchestrator/src/flows/teach.ts";
import type { PortalDirectory } from "../../packages/orchestrator/src/portals.ts";
import { CURSOR_OVERLAY_JS, createHuman } from "../lib/human.ts";
import { openLive } from "../live/lib.ts";
import {
  ESPO_PORTAL_ID,
  ESPO_URL,
  ensureEspoLogin,
  espoApi,
  gradeLead,
  LEAD_FIELDS,
  leadsSince,
  waitForLeadForm,
} from "./espocrm.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const { values } = parseArgs({
  options: { teach: { type: "boolean", default: false }, effort: { type: "string", default: "medium" } },
});

/** The lead typed in the recording: fictional, and different from every synthetic lead. */
export const TEACH_LEAD: Record<string, ParamValue> = {
  first_name: "Helena",
  last_name: "Prado",
  account_name: "Cerrado Café",
  email: "helena.prado@cerradocafe.example",
  title: "Purchasing Lead",
  website: "cerradocafe.example",
  city: "Goiânia",
  country: "Brazil",
  opportunity_amount: 36000,
};

process.env.DOCKHAND_VAR_DIR ||= join(process.cwd(), "var", "agent-oss");
const outDir = join(process.env.DOCKHAND_VAR_DIR, "espocrm");
const stateDir = join(process.env.DOCKHAND_VAR_DIR, "state");

async function record(): Promise<{ mp4: string; seconds: number }> {
  await ensureEspoLogin(stateDir, { fresh: true });
  // EspoCRM's duplicate check would stop the Save on a second recording: remove the previous teach lead.
  const q = `Lead?select=id&where[0][type]=equals&where[0][attribute]=emailAddress&where[0][value]=${encodeURIComponent(String(TEACH_LEAD.email))}`;
  for (const l of (await espoApi<{ list: { id: string }[] }>("GET", q)).list)
    await espoApi("DELETE", `Lead/${l.id}`);
  const work = join(outDir, "teach-video");
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  const browser = await chromium.launch();
  const since = Date.now();
  let webm = "";
  let trim = 0;
  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      storageState: join(stateDir, `${ESPO_PORTAL_ID}.json`),
      recordVideo: { dir: work, size: { width: 1280, height: 800 } },
    });
    await context.addInitScript({ content: CURSOR_OVERLAY_JS });
    const page = await context.newPage();
    const started = Date.now();
    await page.goto(`${ESPO_URL}/#Lead`);
    await page
      .getByRole("button", { name: "Create Lead" })
      .or(page.getByRole("link", { name: "Create Lead" }))
      .first()
      .waitFor({ timeout: 60_000 });
    await page.waitForLoadState("networkidle").catch(() => undefined);
    await page.mouse.move(930, 260);
    trim = (Date.now() - started) / 1000;
    const human = createHuman(page, 20261028);
    await human.pause(900, 1100);
    await human.click(
      page
        .getByRole("button", { name: "Create Lead" })
        .or(page.getByRole("link", { name: "Create Lead" }))
        .first(),
    );
    await waitForLeadForm(page);
    await human.pause(600, 800);
    const input = (name: string) =>
      page.locator(`.record [data-name="${name}"]`).locator("input, textarea").first();
    await human.fill(page.getByRole("textbox", { name: "First Name" }), String(TEACH_LEAD.first_name));
    await human.fill(page.getByRole("textbox", { name: "Last Name" }), String(TEACH_LEAD.last_name));
    await human.fill(input("accountName"), String(TEACH_LEAD.account_name));
    await human.fill(
      page.locator('.record [data-name="emailAddress"] input[type="email"]'),
      String(TEACH_LEAD.email),
    );
    await human.fill(input("title"), String(TEACH_LEAD.title));
    await human.fill(input("website"), String(TEACH_LEAD.website));
    await human.fill(page.getByRole("textbox", { name: "City" }), String(TEACH_LEAD.city));
    await human.fill(page.getByRole("textbox", { name: "Country" }), String(TEACH_LEAD.country));
    await human.fill(input("opportunityAmount"), String(TEACH_LEAD.opportunity_amount));
    await human.pause(500, 700);
    await human.click(page.getByRole("button", { name: "Save", exact: true }));
    await page.waitForURL(/#Lead\/view\//, { timeout: 20_000 });
    await page.waitForTimeout(2400);
    const video = page.video();
    await context.close();
    webm = (await video?.path()) ?? "";
  } finally {
    await browser.close();
  }
  const g = gradeLead((await leadsSince(since)).at(-1), TEACH_LEAD);
  if (g.mismatches.length > 0)
    throw new Error(`the recorded lead was not saved as typed: ${g.mismatches.join("; ")}`);
  const mp4 = join(outDir, "teach-espocrm-create-lead.mp4");
  await run(FFMPEG, [
    "-v",
    "error",
    "-y",
    "-ss",
    trim.toFixed(2),
    "-i",
    webm,
    "-an",
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-r",
    "25",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4,
  ]);
  const probe = await run(FFMPEG, ["-hide_banner", "-i", mp4]).then(
    (r) => r.stderr,
    (e: { stderr?: string }) => e.stderr ?? "",
  );
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(probe);
  return { mp4, seconds: m ? Number(m[2]) * 60 + Number(m[3]) : 0 };
}

const fold = (v: unknown) =>
  String(v ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();

/** Draft param -> adapter param, by the value each was seen with (observedValues vs TEACH_LEAD). */
export function mapDraftParams(d: SkillDraft): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, seen] of Object.entries(d.observedValues ?? {})) {
    // Numbers come back as the page displayed them ("36,000.00" for 36000).
    const num = Number(String(seen).replace(/,/g, ""));
    const hit = Object.entries(TEACH_LEAD).find(([, v]) =>
      typeof v === "number" ? num === v : fold(v) === fold(seen),
    );
    if (hit) out[name] = hit[0];
  }
  return out;
}

const { mp4, seconds } = await record();
console.log(`recorded ${mp4} (${seconds.toFixed(1)} s)`);
if (values.teach) {
  const live = openLive("espocrm-teach");
  try {
    const portals = {
      [ESPO_PORTAL_ID]: {
        id: ESPO_PORTAL_ID,
        name: "EspoCRM",
        url: ESPO_URL,
        startPath: "/#Lead/create",
        writeGuardAllow: [],
        session: async () => [],
      },
    } as PortalDirectory;
    const video = await live.artifacts.put(new Uint8Array(readFileSync(mp4)), "video/mp4", {
      kind: "inbound_media",
      jobId: "live-espocrm-teach",
    });
    const req = { ...teachRequest(video, undefined, portals), effort: values.effort as Effort };
    const t0 = Date.now();
    const raw = await live.models.structured(req, {
      purpose: "teach",
      jobId: "live-espocrm-teach",
      timeoutMs: 300_000,
    });
    const draft = normalizeDraft(raw, portals);
    const map = mapDraftParams(draft);
    const unmapped = LEAD_FIELDS.map((f) => f.param).filter((p) => !Object.values(map).includes(p));
    const file = join(outDir, `teach-draft-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify({ draft, map, unmapped }, null, 1));
    console.log(
      `teach (${req.model}, ${req.effort}) in ${Date.now() - t0} ms: ${draft.steps.length} steps, params ${draft.params.map((p) => p.name).join(", ")}; commit "${draft.commitStep}"`,
    );
    console.log(
      `mapped to the adapter: ${Object.entries(map)
        .map(([a, b]) => `${a}->${b}`)
        .join(", ")}${unmapped.length ? `; unmapped ${unmapped.join(", ")}` : ""}`,
    );
    console.log(`draft: ${file}`);
  } finally {
    console.log(live.report());
    live.close();
  }
}

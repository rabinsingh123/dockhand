// Design review: renders every phone card from a real rehearsal's data, the style frames and a still of every
// clip, then a contact sheet, into var/design/. Nothing here calls a model; the cards are built by the same
// functions the flows use (packages/orchestrator/src/tools/phone-cards.ts), fed with a rehearsal's own rows.
//
//   pnpm exec tsx assets/video/design.ts                       uses var/recordings/rh-cassette-2/var
//   pnpm exec tsx assets/video/design.ts --from <var dir>      another session's var dir
//   pnpm exec tsx assets/video/design.ts --cards               cards and style frames only (no clip stills)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright";
import { openDb, type Skill, type SkillDraft, type StepResult } from "../../packages/core/src/index.ts";
import { referenceSheetHtml, tells } from "../../packages/design/src/index.ts";
import { registerPlan } from "../../packages/orchestrator/src/plan.ts";
import {
  askPhoneCardHtml,
  diffPhoneCardHtml,
  PHONE_CARD_HEIGHT,
  PHONE_CARD_SCALE,
  PHONE_CARD_WIDTH,
  planPhoneCardHtml,
  receiptPhoneCardHtml,
  skillCounts,
  skillPhoneCardHtml,
  submitPhoneCardHtml,
  teachPhoneCardHtml,
  videoDuration,
  videoFrames,
} from "../../packages/orchestrator/src/tools/phone-cards.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(ROOT, "var", "design");
const args = process.argv.slice(2);
const from = args.includes("--from") ? (args[args.indexOf("--from") + 1] as string) : join(ROOT, "var", "recordings", "rh-cassette-2", "var");
const cardsOnly = args.includes("--cards");

// A copy of the rehearsal database, so opening it never touches the session's own files.
const tmp = mkdtempSync(join(os.tmpdir(), "dockhand-design-"));
for (const ext of ["", "-wal", "-shm"]) {
  const f = join(from, `dockhand.sqlite${ext}`);
  if (existsSync(f)) copyFileSync(f, join(tmp, `dockhand.sqlite${ext}`));
}
const db = openDb(join(tmp, "dockhand.sqlite"));
const q = <T>(sql: string, ...p: unknown[]) => db.raw.prepare(sql).all(...p) as T[];
const one = <T>(sql: string, ...p: unknown[]) => db.raw.prepare(sql).get(...p) as T | undefined;
const artifact = (id: string | null | undefined): Uint8Array | undefined => {
  if (!id) return undefined;
  const row = one<{ rel_path: string }>("SELECT rel_path FROM artifacts WHERE id = ?", id);
  return row ? new Uint8Array(readFileSync(join(from, row.rel_path))) : undefined;
};
const skill = (name: string, v: number) =>
  JSON.parse(one<{ json: string }>("SELECT json FROM skills WHERE name = ? AND version = ?", name, v)?.json ?? "null") as Skill;
const cost = (runId: string) => one<{ c: number }>("SELECT COALESCE(SUM(cost_usd), 0) c FROM model_calls WHERE run_id = ?", runId)?.c ?? 0;
const steps = (runId: string) =>
  q<{ idx: number; step_id: string; status: string; rung: string | null; ms: number }>(
    "SELECT idx, step_id, status, rung, ms FROM run_steps WHERE run_id = ? ORDER BY idx",
    runId,
  ).map((s) => ({ idx: s.idx, stepId: s.step_id, status: s.status, ms: s.ms, ...(s.rung ? { rung: s.rung } : {}) }) as StepResult);
const PORTAL = "Caravela Partner Hub";

interface RunRow {
  id: string;
  job_id: string;
  mode: string;
  skill_name: string;
  skill_version: number | null;
  outcome: string;
  ms: number;
  exec_cost_usd: number;
  final_screenshot_id: string | null;
  extracted_json: string | null;
  params_json: string;
}
const runs = q<RunRow>("SELECT * FROM runs WHERE skill_name = 'register_partner_deal' ORDER BY started_at");
const canary = (runId: string) => {
  const n = q<{ id: string }>("SELECT id FROM artifacts WHERE run_id LIKE ?", `${runId}-canary-c%`).length;
  return n;
};

// ---------- the cards ----------

async function cards(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const draftRow = one<{ json: string; video_artifact_id: string }>("SELECT json, video_artifact_id FROM skill_drafts LIMIT 1");
  const draft = JSON.parse(draftRow?.json ?? "null") as SkillDraft;
  const videoRel = one<{ rel_path: string }>("SELECT rel_path FROM artifacts WHERE id = ?", draftRow?.video_artifact_id)?.rel_path;
  const video = videoRel ? join(from, videoRel) : undefined;
  const frames = video ? await videoFrames("ffmpeg", video, 3) : [];
  const durationS = video ? await videoDuration("ffmpeg", video) : undefined;
  out.teach = teachPhoneCardHtml(draft, { portalName: PORTAL, frames, ...(durationS ? { durationS } : {}) });

  const v1 = skill("register_partner_deal", 1);
  out.skill = skillPhoneCardHtml({ skill: v1, portalName: PORTAL, verified: { passed: 2, total: 2 }, draft });

  // The replay of v1 (shot 4), then the v2 repair (shot 1) and the v3 -> v4 watch-style repair (shot 7).
  const replay = runs.find((r) => r.mode === "replay" && r.skill_version === 1) as RunRow;
  const params = JSON.parse(replay.params_json);
  out.plan = planPhoneCardHtml(registerPlan(PORTAL, params, { skill: { name: "register_partner_deal", version: 1 } }).card);

  const commit = one<{ body: string; image_artifact_id: string }>("SELECT body, image_artifact_id FROM gates WHERE job_id = ? AND kind = 'commit'", replay.job_id);
  const readback = (commit?.body ?? "")
    .split("\n")
    .flatMap((l) => {
      const m = /^([^:]+): (.*)$/.exec(l);
      return m ? [{ label: m[1] as string, value: m[2] as string }] : [];
    });
  const shot = artifact(
    one<{ id: string }>(
      "SELECT id FROM artifacts WHERE run_id = ? AND kind = 'screenshot' ORDER BY created_at DESC LIMIT 1",
      replay.id,
    )?.id,
  );
  out.submit = submitPhoneCardHtml({ portalName: PORTAL, ...(shot ? { screenshot: shot } : {}), readback });

  const intake = (jobId: string) =>
    one<{ c: number }>("SELECT COALESCE(SUM(cost_usd),0) c FROM model_calls WHERE job_id = ? AND purpose IN ('transcribe','extract','understand')", jobId)?.c ?? 0;
  const repair = runs.find((r) => r.mode === "repair") as RunRow;
  const id = Object.values(JSON.parse(repair.extracted_json ?? "{}"))[0] as string | undefined;
  const conf = artifact(repair.final_screenshot_id);
  out.receipt = receiptPhoneCardHtml({
    title: v1.title,
    tier: "repair",
    ...(id ? { headline: id } : {}),
    seconds: repair.ms / 1000,
    execCostUsd: repair.exec_cost_usd,
    intakeCostUsd: intake(repair.job_id),
    skill: { name: "register_partner_deal", version: 1 },
    verified: { matched: skillCounts(v1).fields, checked: skillCounts(v1).fields },
    ...(conf ? { screenshot: conf } : {}),
  });

  const v2 = skill("register_partner_deal", 2);
  out.diff = diffPhoneCardHtml({
    portalName: PORTAL,
    parent: v1,
    saved: v2,
    steps: steps(repair.id),
    canary: { passed: 3, total: 3 },
    costUsd: cost(repair.id),
    usedOpenWeights: false, // cassette replay: the credit is for a live Baseten call only
  });

  const ask = one<{ body: string; image_artifact_id: string }>("SELECT body, image_artifact_id FROM gates WHERE kind = 'question' LIMIT 1");
  const askShot = artifact(ask?.image_artifact_id);
  out.ask = askPhoneCardHtml({ portalName: PORTAL, label: /"([^"]+)"/.exec(ask?.body ?? "")?.[1] ?? "Partner tier", options: ["Gold", "Silver", "Bronze"], ...(askShot ? { screenshot: askShot } : {}) });

  const watchRun = runs.find((r) => r.outcome === "repaired" && r.skill_version === 3) as RunRow;
  out.watch = diffPhoneCardHtml({
    portalName: PORTAL,
    parent: skill("register_partner_deal", 3),
    saved: skill("register_partner_deal", 4),
    steps: steps(watchRun.id),
    canary: { passed: 5, total: 5 },
    costUsd: cost(watchRun.id),
    usedOpenWeights: false,
    watch: { when: "overnight" },
  });
  void canary;
  return out;
}

async function shoot(page: Page, html: string, file: string, size: { w: number; h: number }) {
  await page.setViewportSize({ width: size.w, height: size.h });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  writeFileSync(file, await page.screenshot({ type: "png", scale: "device" }));
  console.log(file);
}

async function main(): Promise<void> {
  mkdirSync(join(OUT, "cards"), { recursive: true });
  mkdirSync(join(OUT, "style-frames"), { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ["--force-color-profile=srgb", "--disable-lcd-text"] });
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: PHONE_CARD_SCALE, colorScheme: "light" });
    const page = await ctx.newPage();
    const html = await cards();
    for (const [name, h] of Object.entries(html)) checkTells(name, h);
    for (const [name, h] of Object.entries(html))
      await shoot(page, h, join(OUT, "cards", `${name}.png`), { w: PHONE_CARD_WIDTH, h: PHONE_CARD_HEIGHT });

    // Style frame (b): the overnight card in a light WhatsApp chat, at the phone's true scale in a 1080p frame.
    const frame = await browser.newContext({ deviceScaleFactor: 1, viewport: { width: 1920, height: 1080 } });
    const fp = await frame.newPage();
    const chat = pathToFileURL(join(HERE, "src", "frames", "phone.html")).href;
    await fp.goto(`${chat}?card=${encodeURIComponent(pathToFileURL(join(OUT, "cards", "watch.png")).href)}`);
    await fp.evaluate(() => document.fonts.ready.then(() => undefined));
    await fp.waitForFunction(() => [...document.images].every((i) => i.complete));
    writeFileSync(join(OUT, "style-frames", "b-overnight-card.png"), await fp.screenshot({ type: "png" }));
    console.log(join(OUT, "style-frames", "b-overnight-card.png"));
  } finally {
    await browser.close();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  }

  // Style frames (a) and (c) are stills of the end card and the proof chart.
  const stills = (clip: string, ...t: number[]) =>
    spawnSync(
      "pnpm",
      ["exec", "tsx", "assets/video/render.ts", clip, ...t.flatMap((s) => ["--still", String(s)])].concat([
        "--out",
        "var/design/stills",
      ]),
      { cwd: ROOT, stdio: "inherit", shell: true },
    );
  stills("endcard-wordmark", 1);
  stills("chart-proof", 8.5);
  copyFileSync(join(OUT, "stills", "endcard-wordmark-1.00s.png"), join(OUT, "style-frames", "a-endcard-wordmark.png"));
  copyFileSync(join(OUT, "stills", "chart-proof-8.50s.png"), join(OUT, "style-frames", "c-proof-chart.png"));
  await systemSheet();
  if (cardsOnly) return;

  // A still of every clip at the moments that matter, then the contact sheet of everything.
  const shots: [string, number[]][] = [
    ["title", [3, 7.9]],
    ["title-band", [3]],
    ["chart-baseline", [7.9]],
    ["chart-cost", [9.9]],
    ["chart-heals", [7.9]],
    ["endcard", [3, 7.9]],
  ];
  for (const [clip, t] of shots) stills(clip, ...t);
  const tiles = [
    ...["a-endcard-wordmark", "b-overnight-card", "c-proof-chart"].map((f) => join(OUT, "style-frames", `${f}.png`)),
    ...shots.flatMap(([clip, t]) => t.map((s) => join(OUT, "stills", `${clip}-${s.toFixed(2)}s.png`))),
  ];
  const cardNames = ["teach", "plan", "submit", "ask", "receipt", "skill", "diff", "watch"];
  const sheet = `<!doctype html><html><head><style>
body{margin:0;background:#E3E1DB;font:500 14px system-ui;color:#6B6B6B}
.g{display:grid;grid-template-columns:repeat(4,480px);gap:16px;padding:16px}
.c{display:grid;grid-template-columns:repeat(8,228px);gap:16px;padding:0 16px 16px}
img{width:100%;display:block;background:#F6F5F1}figure{margin:0}figcaption{padding:4px 0}
</style></head><body><div class="g">${tiles
    .map((f) => `<figure><img src="${pathToFileURL(f).href}"><figcaption>${f.split(/[\\/]/).at(-1)}</figcaption></figure>`)
    .join("")}</div><div class="c">${cardNames
    .map((n) => `<figure><img src="${pathToFileURL(join(OUT, "cards", `${n}.png`)).href}"><figcaption>${n}</figcaption></figure>`)
    .join("")}</div></body></html>`;
  const sheetFile = join(OUT, "tmp", "review.html");
  mkdirSync(dirname(sheetFile), { recursive: true });
  writeFileSync(sheetFile, sheet);
  const b2 = await chromium.launch({ headless: true });
  try {
    const p = await b2.newPage({ viewport: { width: 2000, height: 800 } });
    await p.goto(pathToFileURL(sheetFile).href);
    await p.waitForFunction(() => [...document.images].every((i) => i.complete));
    writeFileSync(join(OUT, "review.png"), await p.screenshot({ type: "png", fullPage: true }));
    console.log(join(OUT, "review.png"));
  } finally {
    await b2.close();
  }
  await systemSheet(); // again, now with this run's stills
}

/** var/design/system.png: the reference sheet, with the real cards and the film frames. */
async function systemSheet(): Promise<void> {
  const url = (f: string) => pathToFileURL(f).href;
  const cards = ["teach", "plan", "submit", "ask", "receipt", "skill", "diff", "watch"].map((n) => ({
    name: n,
    src: url(join(OUT, "cards", `${n}.png`)),
  }));
  const frames = [
    ["Proof chart", join(OUT, "style-frames", "c-proof-chart.png")],
    ["Overnight card at phone scale", join(OUT, "style-frames", "b-overnight-card.png")],
    ["End card", join(OUT, "style-frames", "a-endcard-wordmark.png")],
    ...["chart-cost-9.90s", "chart-heals-7.90s", "chart-baseline-7.90s", "title-band-3.00s", "endcard-7.90s"].map(
      (s) => [s, join(OUT, "stills", `${s}.png`)],
    ),
  ]
    .filter(([, f]) => existsSync(f as string))
    .map(([name, f]) => ({ name: name as string, src: url(f as string) }));
  const file = join(OUT, "tmp", "system.html");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, referenceSheetHtml({ cards, frames }));
  const b = await chromium.launch({ headless: true });
  try {
    const p = await b.newPage({ viewport: { width: 2400, height: 1200 } });
    await p.goto(url(file));
    await p.evaluate(() => document.fonts.ready.then(() => undefined));
    await p.waitForFunction(() => [...document.images].every((i) => i.complete));
    writeFileSync(join(OUT, "system.png"), await p.screenshot({ type: "png", fullPage: true }));
    console.log(join(OUT, "system.png"));
  } finally {
    await b.close();
  }
}

/** Fails loudly when a card carries a pattern the design system forbids (docs/DESIGN.md, "Don't"). */
export function checkTells(name: string, html: string): void {
  const found = tells(html.replace(/url(data:[^)]*)/g, "").replace(/src="data:[^"]*"/g, ""));
  if (found.length) throw new Error(`${name}: ${found.join(", ")}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});

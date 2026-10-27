// Records fixtures/teach/caravela-register-deal.mp4: a human-paced registration of a deal on the
// Caravela partner portal (v1, no mutation), the kind of screen recording a rep sends to teach Dockhand.
// The deal (Padaria Estrela) differs from the referral fixtures on purpose.
//
// Usage: tsx scripts/record-teach-video.ts
// Needs ffmpeg (FFMPEG_PATH or "ffmpeg" on PATH). Starts its own portal on a free port.
// The recording itself is not byte-deterministic (real timing); the fixture is replaced only after the
// portal confirms the registration with exactly the intended values and the mp4 passes the size and
// length limits.

import { execFile } from "node:child_process";
import { mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import {
  PARTNER_REG_ID_RE,
  type PortalHandle,
  portalSession,
  startPartnerPortal,
} from "../apps/portals/src/index.ts";
import { TEACH_DEAL, TEACH_USERNAME } from "./lib/data.ts";
import { fixturePath, formatBytes, WORKSPACE_ROOT, workspaceRel } from "./lib/files.ts";
import { dmyToIso } from "./lib/html.ts";
import { CURSOR_OVERLAY_JS, createHuman } from "./lib/human.ts";
import { TEACH_VIDEO } from "./lib/teach.ts";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const VIEWPORT = { width: 1280, height: 800 };
const RUN_ID = "teach-video";
const MAX_SECONDS = 60;
const MAX_BYTES = 16 * 1024 * 1024;
const CONFIRMATION_HOLD_MS = 2400;

function localIsoToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** What the portal must have stored for the recording to count. */
function expectedSubmission() {
  return {
    companyName: TEACH_DEAL.companyName,
    companyWebsite: TEACH_DEAL.companyWebsite,
    country: TEACH_DEAL.country,
    city: TEACH_DEAL.city,
    contactName: TEACH_DEAL.contactName,
    contactEmail: TEACH_DEAL.contactEmail,
    contactPhone: TEACH_DEAL.contactPhone,
    product: TEACH_DEAL.product,
    seats: Number(TEACH_DEAL.seats),
    estimatedValue: Number(TEACH_DEAL.estimatedValueUsd),
    expectedCloseDate: dmyToIso(TEACH_DEAL.expectedCloseDate),
    referralPartner: TEACH_DEAL.referralPartner,
    notes: TEACH_DEAL.notes,
    consent: true,
  };
}

async function record(
  portal: PortalHandle,
  workDir: string,
): Promise<{ webm: string; trimSeconds: number; regId: string }> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: "light",
      recordVideo: { dir: workDir, size: VIEWPORT },
    });
    await context.addCookies(
      await portalSession(portal, { runId: RUN_ID, ui: "v1", mutation: null, username: TEACH_USERNAME }),
    );
    await context.addInitScript({ content: CURSOR_OVERLAY_JS });
    const page = await context.newPage();
    const recordingStarted = Date.now();
    const video = page.video();
    if (!video) throw new Error("video recording did not start");

    await page.goto(`${portal.url}/deals`);
    await page.getByRole("heading", { name: "Deal registrations" }).waitFor();
    await page.mouse.move(930, 260);
    await page.waitForTimeout(250);
    // Everything before this point is a blank page loading; it is cut from the mp4.
    const trimSeconds = (Date.now() - recordingStarted) / 1000;

    const human = createHuman(page, 20261027);
    await human.pause(1100, 1300);
    await human.click(page.getByRole("button", { name: "Register a deal" }));
    await page.waitForURL(/\/deals\/new$/);
    await page.getByRole("heading", { name: "Register a deal" }).waitFor();
    await human.pause(700, 900);

    const field = (label: string) => page.getByLabel(label, { exact: true });
    await human.fill(field("End customer company"), TEACH_DEAL.companyName);
    await human.fill(field("Company website"), TEACH_DEAL.companyWebsite);
    await human.pick(
      page.getByRole("combobox", { name: "Country" }),
      TEACH_DEAL.country,
      TEACH_DEAL.countryQuery,
    );
    await human.fill(field("City"), TEACH_DEAL.city);
    await human.fill(field("Contact full name"), TEACH_DEAL.contactName);
    await human.fill(field("Contact email"), TEACH_DEAL.contactEmail);
    await human.fill(field("Contact phone"), TEACH_DEAL.contactPhone);
    await human.pick(page.getByRole("combobox", { name: "Product" }), TEACH_DEAL.product);
    await human.fill(field("Seats"), TEACH_DEAL.seats);
    await human.fill(field("Estimated value (USD)"), TEACH_DEAL.estimatedValueUsd);
    await human.fill(field("Expected close date"), TEACH_DEAL.expectedCloseDate);
    await human.fill(field("Referral partner"), TEACH_DEAL.referralPartner);
    await human.fill(field("Notes"), TEACH_DEAL.notes);
    await human.click(page.getByLabel("The end customer agreed to be contacted by Caravela"));
    await human.pause(500, 700);
    await human.click(page.getByRole("button", { name: "Submit registration" }));

    await page.waitForURL(/\/deals\/NW-REG-\d{5}$/);
    await page.getByRole("heading", { name: "Registration received" }).waitFor();
    const regId = PARTNER_REG_ID_RE.exec(page.url())?.[0];
    if (!regId) throw new Error(`no registration id in ${page.url()}`);
    // Glance at the registration ID (v1 test id; this session pins "no mutation"), then hold the page.
    const idBox = await page.getByTestId("nw-registration-id").boundingBox();
    if (idBox)
      await human.moveTo(Math.round(idBox.x + idBox.width + 36), Math.round(idBox.y + idBox.height + 22));
    await page.waitForTimeout(CONFIRMATION_HOLD_MS);

    await context.close();
    return { webm: await video.path(), trimSeconds, regId };
  } finally {
    await browser.close();
  }
}

function checkSubmission(portal: PortalHandle): void {
  const subs = portal.submissions({ runId: RUN_ID });
  if (subs.length !== 1) throw new Error(`expected 1 submission, the portal has ${subs.length}`);
  const actual = subs[0]?.fields ?? {};
  const expected = expectedSubmission();
  const wrong = Object.entries(expected).filter(([k, v]) => actual[k] !== v);
  const extra = Object.keys(actual).filter((k) => !(k in expected));
  if (wrong.length > 0 || extra.length > 0) {
    throw new Error(
      `submission differs from the plan: ${wrong.map(([k, v]) => `${k}=${JSON.stringify(actual[k])} (want ${JSON.stringify(v)})`).join(", ")} ${extra.join(", ")}`,
    );
  }
}

async function toMp4(webm: string, trimSeconds: number, out: string): Promise<void> {
  await run(FFMPEG, [
    "-v",
    "error",
    "-y",
    "-ss",
    trimSeconds.toFixed(2),
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
    out,
  ]);
}

async function durationSeconds(file: string): Promise<number> {
  // `ffmpeg -i` without an output exits non-zero but prints the container duration.
  const stderr = await run(FFMPEG, ["-hide_banner", "-i", file]).then(
    (r) => r.stderr,
    (err: { stderr?: string }) => err.stderr ?? "",
  );
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) throw new Error(`could not read the duration of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

async function main(): Promise<void> {
  const closeIso = dmyToIso(TEACH_DEAL.expectedCloseDate);
  if (closeIso <= localIsoToday()) {
    throw new Error(
      `TEACH_DEAL.expectedCloseDate ${TEACH_DEAL.expectedCloseDate} is not in the future; update scripts/lib/data.ts`,
    );
  }
  const workDir = resolve(WORKSPACE_ROOT, "var/tmp/teach-video");
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });

  const portal = await startPartnerPortal({ port: 0, version: "v1", mutation: null, latencyMs: [450, 450] });
  let rec: Awaited<ReturnType<typeof record>>;
  try {
    rec = await record(portal, workDir);
    checkSubmission(portal);
  } finally {
    await portal.close();
  }

  const target = fixturePath(TEACH_VIDEO.replace(/^fixtures\//, ""));
  const tmp = resolve(workDir, "caravela-register-deal.mp4");
  await toMp4(rec.webm, rec.trimSeconds, tmp);
  const seconds = await durationSeconds(tmp);
  const bytes = statSync(tmp).size;
  if (seconds >= MAX_SECONDS) throw new Error(`video is ${seconds.toFixed(1)} s, limit ${MAX_SECONDS} s`);
  if (bytes >= MAX_BYTES) throw new Error(`video is ${formatBytes(bytes)}, limit 16 MB`);
  mkdirSync(resolve(target, ".."), { recursive: true });
  renameSync(tmp, target);
  rmSync(workDir, { recursive: true, force: true });
  console.log(
    `wrote ${workspaceRel(target)}: ${seconds.toFixed(1)} s, ${formatBytes(bytes)}, registration ${rec.regId}`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

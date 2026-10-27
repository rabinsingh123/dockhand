// Generates the synthetic fixtures under fixtures/ (everything except the teach video, which
// scripts/record-teach-video.ts records against the live partner portal).
//
// Usage: tsx scripts/make-fixtures.ts [--only profile,rep,docs,referrals,invitations,voice,teach]
//
// Idempotent and deterministic: values come from scripts/lib/data.ts, randomness is seeded, PDF
// timestamps are pinned, and files are only rewritten when their bytes change, so a second run
// reports every file as "unchanged".

import { type Browser, chromium } from "playwright";
import {
  type CanonicalField,
  isValidInviteCode,
  PARTNER_COUNTRIES,
  PARTNER_PRODUCTS,
  SUPPLIER_FIELDS,
  TENANTS,
} from "../apps/portals/src/index.ts";
import { Understanding } from "../packages/core/src/contracts/orchestrator.ts";
import { SkillDraft } from "../packages/core/src/contracts/skills.ts";
import { INVITATIONS, REFERRALS, REP, TEACH_DEAL, TIDEWATER_PROFILE } from "./lib/data.ts";
import { insuranceCertificateHtml, w9Html } from "./lib/documents.ts";
import { fixturePath, formatBytes, toJson, type WriteResult, writeIfChanged } from "./lib/files.ts";
import { invitationExpected, invitationHtml } from "./lib/invitation.ts";
import { PAPER, PHOTO, photoSceneHtml, referralExpected, referralFormHtml } from "./lib/referral.ts";
import { htmlToJpeg, htmlToPdf, htmlToPng } from "./lib/render.ts";
import { TEACH_EXPECTED, teachExpected } from "./lib/teach.ts";
import { voiceExpectedJson, voiceScriptsMarkdown } from "./lib/voice.ts";

const GROUPS = ["profile", "rep", "docs", "referrals", "invitations", "voice", "teach"] as const;
type Group = (typeof GROUPS)[number];

function parseOnly(argv: string[]): Set<Group> {
  const i = argv.indexOf("--only");
  if (i === -1) return new Set(GROUPS);
  const picked = (argv[i + 1] ?? "").split(",").map((s) => s.trim());
  for (const p of picked) {
    if (!(GROUPS as readonly string[]).includes(p)) {
      throw new Error(`--only takes a comma-separated list of: ${GROUPS.join(", ")} (got "${p}")`);
    }
  }
  return new Set(picked as Group[]);
}

// ---- validation against the portals and the contracts (fail loudly instead of shipping bad truth)

function fieldProblems(f: CanonicalField, value: string): string[] {
  const out: string[] = [];
  if (f.type === "checkbox" && value !== "true" && value !== "false")
    out.push(`${f.key}: checkbox must be "true"/"false"`);
  if ((f.type === "combobox" || f.type === "radio") && !f.options?.includes(value)) {
    out.push(`${f.key}: "${value}" is not one of ${f.options?.join(" | ")}`);
  }
  if (f.type === "checkboxGroup" && !value.split(";").every((v) => f.options?.includes(v.trim()))) {
    out.push(`${f.key}: "${value}" has an option outside ${f.options?.join(" | ")}`);
  }
  if (f.pattern && !new RegExp(f.pattern).test(value))
    out.push(`${f.key}: "${value}" does not match /${f.pattern}/`);
  if (f.type === "file" && !value.endsWith(".pdf")) out.push(`${f.key}: expected a .pdf path`);
  return out;
}

function checkProfile(): void {
  const byKey = new Map(SUPPLIER_FIELDS.map((f) => [f.key, f]));
  const problems: string[] = [];
  for (const [key, value] of Object.entries(TIDEWATER_PROFILE)) {
    const f = byKey.get(key);
    if (!f) problems.push(`${key}: not a SUPPLIER_FIELDS key`);
    else problems.push(...fieldProblems(f, value));
  }
  for (const f of SUPPLIER_FIELDS) {
    if (!f.required || f.tenants || f.insertedBy) continue;
    if (f.showWhen) {
      const v = TIDEWATER_PROFILE[f.showWhen.key];
      const shown =
        typeof f.showWhen.equals === "boolean"
          ? (v === "true") === f.showWhen.equals
          : v === f.showWhen.equals;
      if (!shown) continue;
    }
    if (!(f.key in TIDEWATER_PROFILE)) problems.push(`${f.key}: required by the supplier portal but missing`);
  }
  if (problems.length > 0) throw new Error(`tidewater profile:\n  ${problems.join("\n  ")}`);
}

function checkPartnerValues(where: string, product: string, country: string): void {
  if (!(PARTNER_PRODUCTS as readonly string[]).includes(product))
    throw new Error(`${where}: unknown product ${product}`);
  if (!(PARTNER_COUNTRIES as readonly string[]).includes(country))
    throw new Error(`${where}: unknown country ${country}`);
}

// ---- generators

const docsDir = (name: string) => fixturePath(`docs/${name}`);
const inboundDir = (name: string) => fixturePath(`inbound/${name}`);

async function docs(browser: Browser): Promise<WriteResult[]> {
  return [
    writeIfChanged(docsDir("w9-sample.pdf"), await htmlToPdf(browser, w9Html())),
    writeIfChanged(
      docsDir("insurance-certificate-sample.pdf"),
      await htmlToPdf(browser, insuranceCertificateHtml()),
    ),
  ];
}

async function referrals(browser: Browser): Promise<WriteResult[]> {
  const out: WriteResult[] = [];
  for (const r of REFERRALS) {
    const expected = referralExpected(r);
    Understanding.parse(expected.understanding);
    checkPartnerValues(r.slug, r.product, expected.partnerPortalSubmission.country);
    // Rendered at 2x so the paper stays crisp after the perspective transform scales it down.
    const paper = await htmlToPng(browser, referralFormHtml(r), PAPER, {
      deviceScaleFactor: 2,
      fit: ".paper",
    });
    const scene = photoSceneHtml(`data:image/png;base64,${paper.toString("base64")}`, r.look.scene);
    out.push(
      writeIfChanged(inboundDir(`referral-${r.slug}.jpg`), await htmlToJpeg(browser, scene, PHOTO, 80)),
    );
    out.push(writeIfChanged(inboundDir(`referral-${r.slug}.expected.json`), toJson(expected)));
  }
  return out;
}

async function invitations(browser: Browser): Promise<WriteResult[]> {
  const out: WriteResult[] = [];
  for (const inv of INVITATIONS) {
    if (!isValidInviteCode(TENANTS[inv.tenant], TENANTS[inv.tenant].sampleInviteCode)) {
      throw new Error(`${inv.tenant}: invite code rejected by the portal`);
    }
    const expected = invitationExpected(inv);
    Understanding.parse(expected.understanding);
    out.push(
      writeIfChanged(
        inboundDir(`${inv.tenant}-supplier-invitation.pdf`),
        await htmlToPdf(browser, invitationHtml(inv)),
      ),
    );
    out.push(writeIfChanged(inboundDir(`${inv.tenant}-supplier-invitation.expected.json`), toJson(expected)));
  }
  return out;
}

function voice(): WriteResult[] {
  const expected = voiceExpectedJson();
  for (const s of expected.scripts) Understanding.parse(s.expected);
  return [
    writeIfChanged(fixturePath("voice/scripts.md"), voiceScriptsMarkdown()),
    writeIfChanged(fixturePath("voice/expected.json"), toJson(expected)),
  ];
}

function teach(): WriteResult[] {
  checkPartnerValues("teach deal", TEACH_DEAL.product, TEACH_DEAL.country);
  const expected = teachExpected();
  SkillDraft.parse(expected.draft);
  return [writeIfChanged(fixturePath(TEACH_EXPECTED.replace(/^fixtures\//, "")), toJson(expected))];
}

async function main(): Promise<void> {
  const only = parseOnly(process.argv.slice(2));
  const results: WriteResult[] = [];
  if (only.has("profile")) {
    checkProfile();
    results.push(writeIfChanged(fixturePath("profile/tidewater.json"), toJson(TIDEWATER_PROFILE)));
  }
  if (only.has("rep")) results.push(writeIfChanged(fixturePath("reps/rep.json"), toJson(REP)));
  if (only.has("voice")) results.push(...voice());
  if (only.has("teach")) results.push(...teach());

  if (only.has("docs") || only.has("referrals") || only.has("invitations")) {
    const browser = await chromium.launch();
    try {
      if (only.has("docs")) results.push(...(await docs(browser)));
      if (only.has("referrals")) results.push(...(await referrals(browser)));
      if (only.has("invitations")) results.push(...(await invitations(browser)));
    } finally {
      await browser.close();
    }
  }

  const width = Math.max(...results.map((r) => r.path.length));
  for (const r of results)
    console.log(`${r.status.padEnd(9)} ${r.path.padEnd(width)} ${formatBytes(r.bytes).padStart(9)}`);
  const count = (s: WriteResult["status"]) => results.filter((r) => r.status === s).length;
  console.log(
    `\n${results.length} files: ${count("created")} created, ${count("updated")} updated, ${count("unchanged")} unchanged`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

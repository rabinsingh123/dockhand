import { createHash } from "node:crypto";
import { type ArtifactRef, createMemoryArtifactStore } from "@dockhand/core";
import { type PortalHandle, startSupplierPortal } from "@dockhand/portals";
import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createScriptedModel } from "../scripted.ts";
import { launchTestBrowser } from "../test-support.ts";
import { CTX, cuInput, recordingHooks } from "./cu-test-kit.ts";
import { runComputerUse } from "./loop.ts";

let browser: Browser;
let portal: PortalHandle;

beforeAll(async () => {
  [browser, portal] = await Promise.all([
    launchTestBrowser(),
    startSupplierPortal({ port: 0, latencyMs: [20, 40] }),
  ]);
});
afterAll(async () => {
  await browser?.close();
  await portal?.close();
});

function pdf(title: string): Uint8Array {
  return new TextEncoder().encode(
    [
      "%PDF-1.4",
      `% ${title}`,
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "trailer << /Root 1 0 R >>",
      "%%EOF",
      "",
    ].join("\n"),
  );
}

const fill = (page: Page, label: string, value: string) =>
  page.getByLabel(label, { exact: true }).fill(value);
async function pick(page: Page, combobox: string, option: string) {
  await page.getByRole("combobox", { name: combobox, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}
async function next(page: Page, step: string) {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.waitForURL(new RegExp(`/t/acme/register/${step}$`));
}

/** Steps 1-4 by plain Playwright (the loop under test only runs the uploads). */
async function reachCompliance(page: Page) {
  await page.goto(`${portal.url}/t/acme/invite/ACME-7731`);
  await page.getByRole("button", { name: "Start registration", exact: true }).click();
  await page.waitForURL(/\/t\/acme\/register\/company$/);
  await fill(page, "Legal company name", "Tidewater Cloud Inc.");
  await fill(page, "Tax ID (EIN)", "12-3456789");
  await pick(page, "Country of incorporation", "United States");
  await fill(page, "State / province of incorporation", "Delaware");
  await fill(page, "Year founded", "2016");
  await fill(page, "Company website", "https://tidewater.example");
  await pick(page, "Number of employees", "51-200");
  await pick(page, "Annual revenue (USD)", "$10M-$50M");
  await page.getByRole("radio", { name: "LLC", exact: true }).check();
  await next(page, "address");
  await fill(page, "Street address", "500 Harbor Way");
  await fill(page, "City", "Wilmington");
  await fill(page, "State / province", "DE");
  await fill(page, "Postal code", "19801");
  await pick(page, "Country", "United States");
  await next(page, "contacts");
  await fill(page, "Primary contact name", "Ana Souza");
  await fill(page, "Primary contact title", "Head of Partnerships");
  await fill(page, "Primary contact email", "ana.souza@tidewater.example");
  await fill(page, "Primary contact phone", "+1 302 555 0142");
  await fill(page, "Accounts receivable name", "Leo Park");
  await fill(page, "Accounts receivable email", "ar@tidewater.example");
  await next(page, "banking");
  await fill(page, "Bank name", "First Harbor Bank");
  await fill(page, "Account holder name", "Tidewater Cloud Inc.");
  await fill(page, "Account number", "000123456789");
  await fill(page, "Routing number (ABA)", "021000021");
  await pick(page, "Currency", "USD");
  await page.getByLabel("I confirm these banking details", { exact: true }).check();
  await next(page, "compliance");
}

describe("attach_file on the supplier portal", () => {
  it("intercepts the file chooser, attaches the slot's file, and tags the steps as upload", async () => {
    const runId = "upload-acme-1";
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await context.addCookies(await portal.session({ runId }));
    const page = await context.newPage();
    try {
      await reachCompliance(page);
      const artifacts = createMemoryArtifactStore();
      const w9Bytes = pdf("W-9 Tidewater Cloud Inc.");
      const coiBytes = pdf("Certificate of insurance Tidewater Cloud Inc.");
      const w9: ArtifactRef = await artifacts.put(w9Bytes, "application/pdf", { kind: "upload_fixture" });
      const coi: ArtifactRef = await artifacts.put(coiBytes, "application/pdf", { kind: "upload_fixture" });
      const model = createScriptedModel(
        [
          { do: "click", target: { role: "button", name: "Choose file for W-9 form" } },
          { do: "call", name: "attach_file", args: { slot: "w9" } },
          { do: "click", target: { role: "button", name: "Choose file for Certificate of insurance" } },
          { do: "call", name: "attach_file", args: { slot: "coi" } },
          { do: "done", text: "Both files are attached." },
        ],
        page,
      );
      const input = cuInput(page, {
        portalId: "supplier-acme",
        runId,
        goal: "Attach the W-9 and the certificate of insurance",
        artifacts,
        attachments: { w9, coi },
        params: { w9_file: { file: w9, filename: "w9-tidewater.pdf" } },
        writeGuard: { origins: [portal.url], allow: ["/api/__"] },
      });
      const r = await runComputerUse(model, input, recordingHooks(), CTX);
      expect(r.outcome).toBe("done");

      const steps = r.trace.steps;
      const openers = steps.filter((s) => s.action.type === "click");
      expect(openers.map((s) => s.tags)).toEqual([["upload"], ["upload"]]);
      const attaches = steps.filter((s) => s.action.type === "fn");
      expect(attaches.map((s) => s.upload?.slot)).toEqual(["w9", "coi"]);
      expect(attaches.every((s) => s.tags.includes("upload") && s.screenshot)).toBe(true);
      const w9Step = attaches[0];
      expect(w9Step?.upload?.target.fingerprint).toMatchObject({
        tag: "input",
        inputType: "file",
        label: "W-9 form",
      });
      expect(w9Step?.upload?.target.candidates[0]).toEqual({ by: "label", value: "W-9 form", exact: true });
      expect(w9Step?.fieldValueAfter).toBe("w9-tidewater.pdf");
      expect(attaches[1]?.fieldValueAfter).toBe("coi.pdf"); // no file param: slot name + extension
      await page.getByText("w9-tidewater.pdf", { exact: true }).waitFor();
      expect(model.sessions[0]?.functions.map((f) => f.name)).toEqual(["request_commit", "attach_file"]);

      // Finish the wizard outside the loop: the portal must have received the exact bytes.
      await page.getByLabel("Small business", { exact: true }).check();
      await page.getByRole("radio", { name: "No", exact: true }).check();
      await page.getByLabel("I accept the Supplier Code of Conduct", { exact: true }).check();
      await fill(page, "Signatory name", "Ana Souza");
      await fill(page, "Signatory title", "Head of Partnerships");
      await next(page, "review");
      await page.getByRole("button", { name: "Submit for approval", exact: true }).click();
      await page.waitForURL(/\/t\/acme\/register\/complete\/SG-ACME-\d{6}$/);
      const files = portal.submissions({ runId })[0]?.files ?? [];
      const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
      expect(files.map((f) => [f.field, f.filename, f.sha256])).toEqual([
        ["w9File", "w9-tidewater.pdf", sha(w9Bytes)],
        ["coiFile", "coi.pdf", sha(coiBytes)],
      ]);
    } finally {
      await context.close();
    }
  });

  it("answers attach_file with an error when no file picker is open", async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    try {
      await page.setContent("<button>Nothing to upload</button>");
      const artifacts = createMemoryArtifactStore();
      const w9 = await artifacts.put(pdf("x"), "application/pdf", { kind: "upload_fixture" });
      const model = createScriptedModel([{ do: "call", name: "attach_file", args: { slot: "w9" } }], page);
      await runComputerUse(model, cuInput(page, { artifacts, attachments: { w9 } }), recordingHooks(), CTX);
      const out = model.replies.find((x) => x.kind === "function_output");
      expect(out?.kind === "function_output" && out.output).toMatch(/no file picker is open/);
    } finally {
      await context.close();
    }
  });
});

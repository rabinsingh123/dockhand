// A Selectize-style dropdown (EspoCRM's Status and Source): a hidden native <select> that keeps only the chosen
// option, followed by the widget that shows it and lists the options as [data-value] items when open.

import { DH_SCRIPT, describeAt, describeLocator } from "@dockhand/browser";
import { createMemoryArtifactStore, type Skill } from "@dockhand/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCanary } from "./canary.ts";
import { runSkill } from "./runner.ts";

const ORIGIN = "http://crm.test";
const PAGE = `<!doctype html><html><head><style>
  .drop { display: none; border: 1px solid #ccc } .open .drop { display: block }
  .box, .option { cursor: pointer; padding: 4px } .box { border: 1px solid #999; height: 24px }
</style></head><body>
<div class="cell"><label>Status</label>
  <div class="field">
    <select id="status" style="display:none"><option value="New" selected>New</option></select>
    <div class="control" id="widget">
      <div class="box"><div class="item" data-value="New">New</div><input type="text" style="width:4px"></div>
      <div class="drop"><div class="content">
        <div class="option" data-value="New">New</div>
        <div class="option" data-value="Assigned">Assigned</div>
        <div class="option" data-value="In Process">In Process</div>
      </div></div>
    </div>
  </div>
</div>
<button type="button" id="save">Save</button>
<script>
  const widget = document.getElementById("widget"), select = document.getElementById("status");
  widget.querySelector(".box").addEventListener("click", () => widget.classList.add("open"));
  for (const o of widget.querySelectorAll(".option")) o.addEventListener("click", (e) => {
    e.stopPropagation();
    const v = o.dataset.value;
    select.innerHTML = '<option value="' + v + '" selected>' + v + '</option>';
    widget.querySelector(".item").dataset.value = v;
    widget.querySelector(".item").textContent = v;
    widget.classList.remove("open");
  });
  document.getElementById("save").addEventListener("click", () => { window.saved = select.value; location.hash = "#saved"; });
</script></body></html>`;

let browser: Browser;
const artifacts = createMemoryArtifactStore();
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

async function open(): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addInitScript({ content: DH_SCRIPT });
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: PAGE }),
  );
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/lead`);
  return { page, close: () => context.close() };
}

describe("proxied dropdowns", () => {
  it("reads the widget as a combobox with the select's value, and its open items as options", async () => {
    const { page, close } = await open();
    try {
      const box = await page.locator(".item").boundingBox();
      const t = await describeAt(page, Math.round((box?.x ?? 0) + 5), Math.round((box?.y ?? 0) + 5));
      expect(t?.fingerprint).toMatchObject({ role: "combobox", label: "Status", value: "New" });
      await page.locator(".box").click();
      const opt = await page.getByText("In Process").boundingBox();
      const o = await describeAt(page, Math.round((opt?.x ?? 0) + 5), Math.round((opt?.y ?? 0) + 5));
      expect(o?.fingerprint).toMatchObject({ role: "option", name: "In Process" });
    } finally {
      await close();
    }
  });

  it("replays a select by the visible option text and verifies it on the hidden select", async () => {
    const { page, close } = await open();
    try {
      const trigger = await describeLocator(page.locator("#widget"));
      const save = await describeLocator(page.getByRole("button", { name: "Save" }));
      const skill: Skill = {
        name: "crm_status",
        version: 1,
        parentVersion: null,
        title: "Set a status",
        portalId: "crm",
        params: [{ name: "status", type: "enum", required: true, description: "Status" }],
        steps: [
          { id: "s1", op: "goto", intent: "Open", url: `${ORIGIN}/lead` },
          { id: "s2", op: "select", intent: "Pick Status", trigger, option: "{{status}}" },
          { id: "s3", op: "click", intent: "Save", target: save, commit: true },
        ],
        success: { urlIncludes: "#saved", extract: [] },
        createdFrom: { kind: "goal", traceRunId: "fixture" },
        changelog: "",
      };
      const r = await runSkill(
        page,
        skill,
        { status: "in process" },
        {
          approveCommit: async () => "approved",
          approveSafety: async () => "rejected",
        },
        { runId: "px-1", stepTimeoutMs: 2000, screenshots: "fail_only", allowFallbackHeal: true, artifacts },
      );
      expect(r.error ?? "").toBe("");
      expect(r.outcome).toBe("success");
      expect(r.verification?.mismatches).toEqual([]);
      expect(await page.evaluate(() => (window as unknown as { saved: string }).saved)).toBe("In Process");
    } finally {
      await close();
    }
  });
});

// EspoCRM's lead form after its admin reorders the layout (live-sim-3): the dropdowns have no id, name or label
// Playwright can use, so the compiled skill finds Status by a positional path alone. After the reorder that path
// lands on another field's cell, the run heals Status by similarity, and the patched skill must then pass its
// canary on the same page. It failed 3 of 3 with STEP_AMBIGUOUS: the old path, kept "in case the UI flips back",
// still matched the other cell and disagreed with the fresh one.
const widget = (name: string, options: string[]) =>
  `<select data-name="${name}" style="display:none"><option value="" selected></option></select>
   <div class="control"><div class="box"><div class="item" data-value=""></div><input type="text" style="width:4px"></div>
     <div class="drop"><div class="content">${options
       .map((o) => `<div class="option" data-value="${o}">${o}</div>`)
       .join("")}</div></div></div>`;
const cell = (label: string, inner: string) =>
  `<div class="cell"><label class="control-label">${label}</label><div class="field">${inner}</div></div>`;
const STATUS = cell("Status", widget("status", ["New", "Assigned", "In Process"]));
const SOURCE = cell("Source", widget("source", ["Call", "Partner", "Web Site"]));
const NOTE = cell(
  "Description",
  `<div class="field-text"><div class="note">Imported from the partner list</div></div>`,
);
const layoutPage = (row: string) => `<!doctype html><html><head><style>
  .drop { display: none; border: 1px solid #ccc } .open .drop { display: block }
  .box, .option { cursor: pointer; padding: 4px } .box { border: 1px solid #999; height: 24px; min-width: 120px }
  .row { display: flex; gap: 16px }
</style></head><body>
<div class="record">
  <div class="panel"><div class="row">${cell("Account Name", '<input type="text" class="form-control">')}</div></div>
  <div class="panel"><div class="row">${row}</div></div>
</div>
<button type="button" class="btn">Save</button>
<script>
  for (const widget of document.querySelectorAll(".control")) {
    const select = widget.previousElementSibling, item = widget.querySelector(".item");
    widget.querySelector(".box").addEventListener("click", () => widget.classList.add("open"));
    for (const o of widget.querySelectorAll(".option")) o.addEventListener("click", (e) => {
      e.stopPropagation();
      const v = o.dataset.value;
      select.innerHTML = '<option value="' + v + '" selected>' + v + '</option>';
      item.dataset.value = v;
      item.textContent = v;
      widget.classList.remove("open");
    });
  }
  document.querySelector("button").addEventListener("click", () => { location.hash = "#saved"; });
</script></body></html>`;
const LAYOUT_A = layoutPage(`${STATUS}${SOURCE}`);
// The admin's reorder: a read-only Description cell takes Status's old place, Status moves to the end.
const LAYOUT_B = layoutPage(`${NOTE}${SOURCE}${STATUS}`);

describe("a dropdown healed after a layout reorder", () => {
  const contexts: { close: () => Promise<void> }[] = [];
  afterAll(async () => {
    for (const c of contexts) await c.close().catch(() => {});
  });
  async function pageWith(html: string): Promise<Page> {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    contexts.push(context);
    await context.addInitScript({ content: DH_SCRIPT });
    await context.route(`${ORIGIN}/**`, (route) =>
      route.fulfill({ status: 200, contentType: "text/html", body: html }),
    );
    const page = await context.newPage();
    await page.goto(`${ORIGIN}/lead`);
    return page;
  }
  const widgetIn = (page: Page, label: string) =>
    page
      .locator(".cell")
      .filter({ has: page.locator(`label:text-is("${label}")`) })
      .locator(".control");

  it("passes its canary on the reordered page", async () => {
    const a = await pageWith(LAYOUT_A);
    const status = await describeLocator(widgetIn(a, "Status"));
    const source = await describeLocator(widgetIn(a, "Source"));
    const save = await describeLocator(a.getByRole("button", { name: "Save" }));
    // As compiled from EspoCRM: Status is found by a positional path and nothing else.
    expect(status.candidates.length).toBeGreaterThan(0);
    expect(status.candidates.every((c) => c.by === "css" && /:nth-of-type\(/.test(c.value))).toBe(true);
    const skill: Skill = {
      name: "crm_lead_status",
      version: 1,
      parentVersion: null,
      title: "Create a lead",
      portalId: "crm",
      params: [
        { name: "status", type: "enum", required: true, description: "Status" },
        { name: "source", type: "enum", required: true, description: "Source" },
      ],
      steps: [
        { id: "s1", op: "goto", intent: "Open", url: `${ORIGIN}/lead` },
        { id: "s2", op: "select", intent: "Pick Status", trigger: status, option: "{{status}}" },
        { id: "s3", op: "select", intent: "Pick Source", trigger: source, option: "{{source}}" },
        { id: "s4", op: "click", intent: "Save", target: save, commit: true },
      ],
      success: { urlIncludes: "#saved", extract: [] },
      createdFrom: { kind: "goal", traceRunId: "fixture" },
      changelog: "",
    };

    const b = await pageWith(LAYOUT_B);
    // The drift as seen live: the stored path now lands on exactly one element, and it is not Status.
    const stale = b.locator((status.candidates[0] as { value: string }).value);
    expect(await stale.count()).toBe(1);
    expect(await stale.evaluate((el) => el.closest(".cell")?.querySelector("label")?.textContent)).not.toBe(
      "Status",
    );
    const run = await runSkill(
      b,
      skill,
      { status: "Assigned", source: "Partner" },
      { approveCommit: async () => "approved", approveSafety: async () => "rejected" },
      { runId: "drift-1", stepTimeoutMs: 2000, screenshots: "fail_only", allowFallbackHeal: true, artifacts },
    );
    expect(run.error ?? "").toBe("");
    expect(run.outcome).toBe("success");
    expect(run.steps.find((s) => s.stepId === "s2")).toMatchObject({ status: "healed", rung: "similarity" });
    const patched = run.patched;
    expect(patched).toBeDefined();

    const canary = await runCanary(
      () => pageWith(LAYOUT_B),
      { ...(patched as Skill), version: 2, parentVersion: 1 },
      [
        { status: "In Process", source: "Call" },
        { status: "New", source: "Web Site" },
        { status: "Assigned", source: "Partner" },
      ],
      { artifacts, stepTimeoutMs: 2000 },
    );
    expect(canary.failures.map((f) => `${f.errorCode}: ${f.error}`)).toEqual([]);
    expect(canary.passed).toBe(3);
  });
});

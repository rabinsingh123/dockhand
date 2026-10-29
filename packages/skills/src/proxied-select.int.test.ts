// A Selectize-style dropdown (EspoCRM's Status and Source): a hidden native <select> that keeps only the chosen
// option, followed by the widget that shows it and lists the options as [data-value] items when open.

import { DH_SCRIPT, describeAt, describeLocator } from "@dockhand/browser";
import { createMemoryArtifactStore, type Skill } from "@dockhand/core";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

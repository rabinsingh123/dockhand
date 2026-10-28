// Computer-use wire probes against the live API (raw HTTP, every call recorded in the ledger):
//   latency  - turn latency of a fresh request vs a previous_response_id chain vs stateless replay (store:false)
//   safety   - whether a trivial, data-free task also gets pending_safety_checks
//   keys     - what key names and scroll deltas the model emits for keyboard/scroll-only tasks
//
// Usage: META_MODE=live tsx scripts/live/cu-probe.ts latency|safety|keys [--model muse-spark-1.3] [--n 2]

import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { startPartnerPortal } from "../../apps/portals/src/index.ts";
import { responsesUsage, tokenCostUsd } from "../../packages/meta/src/index.ts";
import { openLive } from "./lib.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    model: { type: "string", default: "muse-spark-1.3" },
    n: { type: "string", default: "2" },
    effort: { type: "string", default: "low" },
  },
});
const which = positionals[0] ?? "latency";
const MODEL = values.model as string;
const live = openLive(`cu-probe-${which}`);
const key = live.config.meta.apiKey as string;
const base = live.config.meta.baseUrl;
const runId = `probe-${which}-${Date.now()}`;

// biome-ignore lint/suspicious/noExplicitAny: raw wire bodies of unknown shape, probe script only
type Json = Record<string, any>;

async function post(body: Json): Promise<{ json: Json; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${base}/responses`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const ms = Date.now() - t0;
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
  const json = JSON.parse(text) as Json;
  const usage = responsesUsage(json.usage);
  live.ledger.record({
    purpose: "cu_first_run",
    provider: "meta",
    model: MODEL,
    runId,
    responseId: json.id,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
    images: 1,
    latencyMs: ms,
    costUsd: tokenCostUsd(MODEL, usage),
    status: json.status === "completed" ? "ok" : "incomplete",
  });
  return { json, ms };
}

function calls(json: Json) {
  return (json.output as Json[]).filter((o) => o.type === "computer_call");
}
function describe(json: Json): string {
  return (json.output as Json[])
    .map((o) =>
      o.type === "computer_call"
        ? `computer_call[${(o.actions ?? [o.action]).map((a: Json) => JSON.stringify(a)).join(" ")}] checks=${(o.pending_safety_checks ?? []).map((c: Json) => c.code).join(",")}`
        : o.type === "message"
          ? `message(${o.phase ?? "-"}): ${JSON.stringify(o.content?.[0]?.text ?? "").slice(0, 160)}`
          : o.type,
    )
    .join(" | ");
}

const portal = await startPartnerPortal({ port: 0 });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await context.addCookies(await portal.session({ runId }));
  const page = await context.newPage();
  await page.goto(`${portal.url}/deals/new`, { waitUntil: "load" });
  const shot = async () =>
    `data:image/png;base64,${(await page.screenshot({ type: "png", scale: "css" })).toString("base64")}`;
  const tools = [{ type: "computer" }];
  const reasoning = { effort: values.effort };
  const instructions =
    "You operate one browser tab with a 1280x800 viewport. Coordinates are pixels in the most recent screenshot.";

  if (which === "latency") {
    const task = "Click into the End customer company field and type ACME TEST. Then stop and say done.";
    for (let i = 0; i < Number(values.n); i++) {
      // A: fresh request (no chain)
      const a1 = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: true,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: task },
              { type: "input_image", image_url: await shot() },
            ],
          },
        ],
      });
      console.log(`fresh #${i + 1}: ${a1.ms} ms  ${describe(a1.json)}`);
      const call = calls(a1.json)[0];
      if (!call) continue;
      // B: chained computer_call_output
      const b = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: true,
        previous_response_id: a1.json.id,
        input: [
          {
            type: "computer_call_output",
            call_id: call.call_id,
            acknowledged_safety_checks: call.pending_safety_checks ?? [],
            output: { type: "computer_screenshot", image_url: await shot() },
          },
        ],
      });
      console.log(`chained #${i + 1}: ${b.ms} ms  ${describe(b.json)}`);
      // C: stateless replay (store:false), the same turn re-sent with every item
      const c1 = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: task },
              { type: "input_image", image_url: await shot() },
            ],
          },
        ],
      });
      const cc = calls(c1.json)[0];
      if (!cc) continue;
      const c2 = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: task },
              { type: "input_image", image_url: await shot() },
            ],
          },
          ...(c1.json.output as Json[]).filter((o) => o.type !== "reasoning"),
          {
            type: "computer_call_output",
            call_id: cc.call_id,
            acknowledged_safety_checks: cc.pending_safety_checks ?? [],
            output: { type: "computer_screenshot", image_url: await shot() },
          },
        ],
      });
      console.log(`stateless #${i + 1}: first ${c1.ms} ms, second ${c2.ms} ms  ${describe(c2.json)}`);
      // D: chained, but answered with a fresh screenshot in a user message plus the output (no new image in output)
    }
  } else if (which === "safety") {
    for (const task of [
      "Scroll down a little to see more of the form.",
      "Click the Deal registrations link in the top navigation.",
      "Click into the City field.",
    ]) {
      const r = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: task },
              { type: "input_image", image_url: await shot() },
            ],
          },
        ],
      });
      console.log(`${task}\n  -> ${r.ms} ms  ${describe(r.json)}`);
    }
  } else if (which === "keys") {
    for (const task of [
      "Scroll down the page by about half a screen using the mouse wheel.",
      "Press Page Down once.",
      "Select all text in the focused field with the keyboard shortcut, then press Tab to move to the next field.",
      "Press the key combination to go back in browser history.",
    ]) {
      const r = await post({
        model: MODEL,
        instructions,
        tools,
        reasoning,
        store: false,
        input: [
          {
            role: "user",
            content: [
              { type: "input_text", text: task },
              { type: "input_image", image_url: await shot() },
            ],
          },
        ],
      });
      console.log(`${task}\n  -> ${r.ms} ms  ${describe(r.json)}`);
    }
  }
} finally {
  await browser.close();
  await portal.close();
  console.log(`\n${live.report()}`);
  live.close();
}

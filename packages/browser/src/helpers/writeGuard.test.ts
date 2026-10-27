import type { Browser, Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FIXTURE_ORIGIN, type FixtureServer, fixtureContext, launchTestBrowser } from "../test-support.ts";
import { installWriteGuard } from "./writeGuard.ts";

const PAGE = `<!doctype html><button id=save onclick="send('POST', '/api/deals')">Save</button>
<button id=draft onclick="send('PUT', '/api/__draft')">Draft</button>
<button id=get onclick="send('GET', '/api/deals')">Load</button>
<output id=out></output>
<script>
  function send(method, url) {
    fetch(url, { method, body: method === 'GET' ? undefined : '{}' })
      .then(r => r.json()).then(j => { out.textContent += method + ' ok;'; })
      .catch(() => { out.textContent += method + ' failed;'; });
  }
</script>`;

let browser: Browser;
let page: Page;
let server: FixtureServer;

beforeAll(async () => {
  browser = await launchTestBrowser();
});
afterAll(async () => {
  await browser?.close();
});
beforeEach(async () => {
  ({ page, server } = await fixtureContext(browser, { "/app": PAGE }));
  await page.goto(`${FIXTURE_ORIGIN}/app`);
});

describe("installWriteGuard", () => {
  it("holds a POST until a token is granted, then releases exactly one write", async () => {
    const seen: string[] = [];
    let resolveSeen: () => void = () => {};
    const reported = new Promise<void>((r) => {
      resolveSeen = r;
    });
    const guard = await installWriteGuard(page, { origins: [FIXTURE_ORIGIN], allow: ["/api/__"] }, (req) => {
      seen.push(`${req.method} ${new URL(req.url).pathname}`);
      resolveSeen();
      return new Promise(() => {}); // nobody decides: only a grant can release it
    });
    await page.click("#save");
    await reported;
    expect(guard.pending()).toBe(1);
    expect(server.hits.filter((h) => h.method === "POST")).toHaveLength(0);

    guard.grant(1);
    await page.locator("#out", { hasText: "POST ok;" }).waitFor();
    expect(server.hits.filter((h) => h.method === "POST")).toHaveLength(1);
    expect(guard.pending()).toBe(0);
    expect(guard.released()).toBe(1);
    expect(guard.tokens()).toBe(0);
    expect(seen).toEqual(["POST /api/deals"]);
    await guard.dispose();
  });

  it("lets reads and allow-listed writes through, and aborts a write the callback blocks", async () => {
    const guard = await installWriteGuard(
      page,
      { origins: [FIXTURE_ORIGIN], allow: ["/api/__"] },
      async () => "block",
    );
    await page.click("#get");
    await page.click("#draft");
    await page.locator("#out", { hasText: "GET ok;" }).waitFor();
    await page.locator("#out", { hasText: "PUT ok;" }).waitFor();
    await page.click("#save");
    await page.locator("#out", { hasText: "POST failed;" }).waitFor();
    expect(server.hits.map((h) => h.method).sort()).toEqual(["GET", "PUT"]);
    await guard.dispose();
  });

  it("spends a token granted in advance on the next write only", async () => {
    const guard = await installWriteGuard(
      page,
      { origins: [FIXTURE_ORIGIN], allow: [] },
      async () => "block",
    );
    guard.grant();
    await page.click("#save");
    await page.locator("#out", { hasText: "POST ok;" }).waitFor();
    await page.click("#save");
    await page.locator("#out", { hasText: "POST failed;" }).waitFor();
    expect(server.hits.filter((h) => h.method === "POST")).toHaveLength(1);
    await guard.dispose();
  });

  it("ignores other origins and aborts held writes on dispose", async () => {
    const other = await installWriteGuard(
      page,
      { origins: ["http://elsewhere.test"], allow: [] },
      async () => "block",
    );
    await page.click("#save");
    await page.locator("#out", { hasText: "POST ok;" }).waitFor();
    await other.dispose();

    const guard = await installWriteGuard(
      page,
      { origins: [FIXTURE_ORIGIN], allow: [] },
      () => new Promise(() => {}),
    );
    await page.click("#save");
    await expect.poll(() => guard.pending()).toBe(1);
    await guard.dispose();
    await page.locator("#out", { hasText: "POST failed;" }).waitFor();
    expect(server.hits.filter((h) => h.method === "POST")).toHaveLength(1);
  });
});

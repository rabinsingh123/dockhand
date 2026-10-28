import { createFixedClock, createMemoryArtifactStore, type Db, openDb } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRepos, idemKey, type Repos } from "../repo.ts";
import { createFakeCrm } from "./crm-fake.ts";
import { createHubSpotCrm } from "./hubspot.ts";

interface Seen {
  method: string;
  path: string;
  auth: string | null;
  json?: unknown;
  form?: Record<string, string | { name: string; type: string; size: number }>;
}

/** A HubSpot stand-in: records each request and answers from `routes` ("METHOD path" -> handler). */
function mockHubSpot(routes: Record<string, (body: unknown) => { status: number; body: unknown }>) {
  const seen: Seen[] = [];
  let toolCallsAtRequest: string[][] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const s: Seen = { method: req.method, path: url.pathname, auth: req.headers.get("authorization") };
    const type = req.headers.get("content-type") ?? "";
    if (type.includes("application/json")) s.json = await req.json();
    if (type.includes("multipart/form-data")) {
      s.form = {};
      for (const [k, v] of (await req.formData()).entries()) {
        s.form[k] = typeof v === "string" ? v : { name: v.name, type: v.type, size: v.size };
      }
    }
    seen.push(s);
    toolCallsAtRequest.push(snapshot());
    const route = routes[`${s.method} ${s.path}`];
    if (!route) return new Response(JSON.stringify({ message: "no route" }), { status: 404 });
    const r = route(s.json ?? s.form);
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  };
  let snapshot: () => string[] = () => [];
  return {
    fetch,
    seen,
    /** tool_calls statuses as they were when each request arrived. */
    rowsAtRequest: () => toolCallsAtRequest,
    watch(fn: () => string[]) {
      snapshot = fn;
      toolCallsAtRequest = [];
    },
  };
}

let db: Db;
let repos: Repos;
const clock = createFixedClock(Date.UTC(2026, 9, 27, 15, 0, 0));

beforeEach(() => {
  db = openDb(":memory:");
  repos = createRepos(db, clock);
});
afterEach(() => db.close());

function newJob(): string {
  return repos.jobs.create("5511999990001").id;
}

describe("HubSpot client", () => {
  it("searches, creates the company, the deal with its association, uploads the PDF and notes it", async () => {
    const artifacts = createMemoryArtifactStore(clock);
    const pdf = await artifacts.put(new TextEncoder().encode("%PDF-1.4 quote"), "application/pdf", {
      kind: "quote_pdf",
    });
    const mock = mockHubSpot({
      "POST /crm/v3/objects/companies/search": () => ({ status: 200, body: { total: 0, results: [] } }),
      "POST /crm/v3/objects/companies": () => ({ status: 201, body: { id: "9001" } }),
      "POST /crm/v3/objects/deals": () => ({ status: 201, body: { id: "7001" } }),
      "POST /files/v3/files": () => ({ status: 201, body: { id: "5001", parentFolderId: "1" } }),
      "POST /crm/v3/objects/notes": () => ({ status: 201, body: { id: "3001" } }),
    });
    const jobId = newJob();
    mock.watch(() => repos.toolCalls.forJob(jobId).map((r) => `${r.kind}:${r.status}`));
    const crm = createHubSpotCrm({
      token: "pat-na1-test",
      db,
      artifacts,
      clock,
      fetch: mock.fetch,
      hubId: "123",
    });

    const company = await crm.upsertCompany(
      { name: "Café Aurora", city: "São Paulo", country: "Brazil" },
      idemKey(jobId, 0),
    );
    expect(company).toEqual({
      id: "9001",
      created: true,
      url: "https://app.hubspot.com/contacts/123/record/0-2/9001",
    });
    const deal = await crm.createDeal(
      {
        name: "Café Aurora · 25 seats · Business",
        amountMinor: 3_213_000,
        currency: "BRL",
        closeDate: "2026-12-31",
        companyId: "9001",
      },
      idemKey(jobId, 1),
    );
    expect(deal.id).toBe("7001");
    const note = await crm.attachFileNote(
      { dealId: "7001", body: "Quote TWC-20261027-ABCD", file: pdf, filename: "quote.pdf" },
      idemKey(jobId, 3),
    );
    expect(note).toEqual({ noteId: "3001" });

    expect(mock.seen.map((s) => `${s.method} ${s.path}`)).toEqual([
      "POST /crm/v3/objects/companies/search",
      "POST /crm/v3/objects/companies",
      "POST /crm/v3/objects/deals",
      "POST /files/v3/files",
      "POST /crm/v3/objects/notes",
    ]);
    expect(new Set(mock.seen.map((s) => s.auth))).toEqual(new Set(["Bearer pat-na1-test"]));
    expect(mock.seen[0]?.json).toEqual({
      filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: "Café Aurora" }] }],
      properties: ["name", "domain", "city", "country"],
      limit: 1,
    });
    expect(mock.seen[1]?.json).toEqual({
      properties: { name: "Café Aurora", city: "São Paulo", country: "Brazil" },
    });
    expect(mock.seen[2]?.json).toEqual({
      properties: {
        dealname: `Café Aurora · 25 seats · Business [${jobId.slice(-6)}]`,
        amount: "32130.00",
        closedate: "2026-12-31T12:00:00.000Z",
        pipeline: "default",
        dealstage: "appointmentscheduled",
        description: `Created by Dockhand for job ${jobId}.`,
      },
      associations: [
        { to: { id: "9001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] },
      ],
    });
    expect(mock.seen[3]?.form).toEqual({
      file: { name: "quote.pdf", type: "application/pdf", size: 14 },
      options: JSON.stringify({ access: "PRIVATE" }),
      folderPath: "/dockhand/quotes",
    });
    expect(mock.seen[4]?.json).toEqual({
      properties: {
        hs_timestamp: "2026-10-27T15:00:00.000Z",
        hs_note_body: "Quote TWC-20261027-ABCD",
        hs_attachment_ids: "5001",
      },
      associations: [
        { to: { id: "7001" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 214 }] },
      ],
    });

    // Each write's row was committed as 'started' before its request went out.
    const atRequest = mock.rowsAtRequest();
    expect(atRequest[1]).toEqual(["hubspot.company.create:started"]);
    expect(atRequest[2]).toEqual(["hubspot.company.create:succeeded", "hubspot.deal.create:started"]);
    expect(atRequest[3]?.at(-1)).toBe("hubspot.file.upload:started");
    expect(atRequest[4]?.at(-1)).toBe("hubspot.note.create:started");
    expect(repos.toolCalls.forJob(jobId).map((r) => [r.idemKey, r.status])).toEqual([
      [`${jobId}:0`, "succeeded"],
      [`${jobId}:1`, "succeeded"],
      [`${jobId}:3:file`, "succeeded"],
      [`${jobId}:3`, "succeeded"],
    ]);
  });

  it("finds an existing company without writing", async () => {
    const mock = mockHubSpot({
      "POST /crm/v3/objects/companies/search": () => ({
        status: 200,
        body: { total: 1, results: [{ id: "42" }] },
      }),
    });
    const jobId = newJob();
    const crm = createHubSpotCrm({
      token: "t",
      db,
      artifacts: createMemoryArtifactStore(),
      clock,
      fetch: mock.fetch,
    });
    await expect(crm.upsertCompany({ name: "Café Aurora" }, idemKey(jobId, 0))).resolves.toMatchObject({
      id: "42",
      created: false,
    });
    expect(repos.toolCalls.forJob(jobId)).toEqual([]);
  });

  it("returns the stored result for a repeated key and never re-posts", async () => {
    const mock = mockHubSpot({ "POST /crm/v3/objects/deals": () => ({ status: 201, body: { id: "7001" } }) });
    const jobId = newJob();
    const crm = createHubSpotCrm({
      token: "t",
      db,
      artifacts: createMemoryArtifactStore(),
      clock,
      fetch: mock.fetch,
    });
    const d = { name: "Deal", amountMinor: 100, currency: "BRL", closeDate: "2026-12-31", companyId: "1" };
    await crm.createDeal(d, idemKey(jobId, 1));
    await expect(crm.createDeal(d, idemKey(jobId, 1))).resolves.toMatchObject({ id: "7001" });
    expect(mock.seen).toHaveLength(1);
  });

  it("marks a 5xx unknown, a 4xx failed, and refuses to retry an unknown write", async () => {
    let status = 502;
    const mock = mockHubSpot({ "POST /crm/v3/objects/deals": () => ({ status, body: { message: "boom" } }) });
    const jobId = newJob();
    const crm = createHubSpotCrm({
      token: "t",
      db,
      artifacts: createMemoryArtifactStore(),
      clock,
      fetch: mock.fetch,
    });
    const d = { name: "Deal", amountMinor: 100, currency: "BRL", closeDate: "2026-12-31", companyId: "1" };
    await expect(crm.createDeal(d, idemKey(jobId, 1))).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(repos.toolCalls.byKey(idemKey(jobId, 1))?.status).toBe("unknown");
    await expect(crm.createDeal(d, idemKey(jobId, 1))).rejects.toMatchObject({ code: "UNKNOWN_OUTCOME" });
    expect(mock.seen).toHaveLength(1); // never retried

    status = 400;
    await expect(crm.createDeal(d, idemKey(jobId, 2))).rejects.toMatchObject({ code: "TOOL_ERROR" });
    expect(repos.toolCalls.byKey(idemKey(jobId, 2))?.status).toBe("failed");
  });

  it("treats a network error as an unknown outcome", async () => {
    const jobId = newJob();
    const crm = createHubSpotCrm({
      token: "t",
      db,
      artifacts: createMemoryArtifactStore(),
      clock,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(crm.upsertCompany({ name: "X" }, idemKey(jobId, 0))).rejects.toMatchObject({
      code: "UNKNOWN_OUTCOME",
    });
  });
});

describe("fake CRM", () => {
  it("is idempotent on the key and finds companies by name", async () => {
    const crm = createFakeCrm();
    const a = await crm.upsertCompany({ name: "Café Aurora" }, "J:0");
    const again = await crm.upsertCompany({ name: "Café Aurora" }, "J:0");
    expect(again).toEqual(a);
    expect((await crm.upsertCompany({ name: "café aurora" }, "K:0")).created).toBe(false);
    const deal = await crm.createDeal(
      { name: "D", amountMinor: 1, currency: "BRL", closeDate: "2027-01-01", companyId: a.id },
      "J:1",
    );
    await crm.createDeal(
      { name: "D", amountMinor: 1, currency: "BRL", closeDate: "2027-01-01", companyId: a.id },
      "J:1",
    );
    expect(crm.state().deals).toHaveLength(1);
    expect(deal.id).toBe(crm.state().deals[0]?.id);
    expect(crm.writes()).toBe(2);
  });
});

describe("HubSpot record links", () => {
  it("reads the portal id and app domain once when lookupAccount is set", async () => {
    const mock = mockHubSpot({
      "GET /account-info/v3/details": () => ({
        status: 200,
        body: { portalId: 247822536, uiDomain: "app-na2.hubspot.com" },
      }),
      "POST /crm/v3/objects/companies/search": () => ({
        status: 200,
        body: { total: 1, results: [{ id: "9001" }] },
      }),
      "POST /crm/v3/objects/deals": () => ({ status: 201, body: { id: "7001" } }),
    });
    const jobId = newJob();
    const crm = createHubSpotCrm({
      token: "pat-na2-test",
      db,
      artifacts: createMemoryArtifactStore(clock),
      clock,
      fetch: mock.fetch,
      lookupAccount: true,
      dealStage: "qualifiedtobuy",
      currencyCode: true,
    });
    const company = await crm.upsertCompany({ name: "Café Aurora" }, idemKey(jobId, 0));
    expect(company.url).toBe("https://app-na2.hubspot.com/contacts/247822536/record/0-2/9001");
    const deal = await crm.createDeal(
      {
        name: "Café Aurora",
        amountMinor: 3_570_000,
        currency: "BRL",
        closeDate: "2027-01-29",
        companyId: "9001",
      },
      idemKey(jobId, 1),
    );
    expect(deal.url).toBe("https://app-na2.hubspot.com/contacts/247822536/record/0-3/7001");
    expect(mock.seen.filter((s) => s.path === "/account-info/v3/details")).toHaveLength(1);
    const dealBody = mock.seen.find((s) => s.path === "/crm/v3/objects/deals")?.json as {
      properties: Record<string, string>;
    };
    expect(dealBody.properties).toMatchObject({ dealstage: "qualifiedtobuy", deal_currency_code: "BRL" });
  });

  it("falls back to the default link when the account lookup fails, without failing the write", async () => {
    const mock = mockHubSpot({
      "GET /account-info/v3/details": () => ({ status: 403, body: { category: "MISSING_SCOPES" } }),
      "POST /crm/v3/objects/companies/search": () => ({ status: 200, body: { total: 0, results: [] } }),
      "POST /crm/v3/objects/companies": () => ({ status: 201, body: { id: "9002" } }),
    });
    const crm = createHubSpotCrm({
      token: "pat-na2-test",
      db,
      artifacts: createMemoryArtifactStore(clock),
      clock,
      fetch: mock.fetch,
      lookupAccount: true,
    });
    const company = await crm.upsertCompany({ name: "Vila Nova Logística" }, idemKey(newJob(), 0));
    expect(company).toMatchObject({
      id: "9002",
      created: true,
      url: "https://app.hubspot.com/contacts/_/record/0-2/9002",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeMultipart, fetchWithRetry, parseRetryAfter, redact } from "./http.ts";
import { type MockServer, startMockServer } from "./test-support/mock-server.ts";
import { docFixture } from "./test-support/world.ts";

let server: MockServer;
let sleeps: number[];
const fast = () => ({
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
  random: () => 0.5,
});

beforeEach(async () => {
  server = await startMockServer();
  sleeps = [];
});
afterEach(async () => {
  await server.close();
});

describe("fetchWithRetry", () => {
  it("retries a 429 after the Retry-After it was given, then returns the success", async () => {
    server.on(
      "/x",
      { status: 429, json: docFixture("errors.rate-limit.json"), headers: { "retry-after": "2" } },
      { json: { ok: 1 } },
    );

    const res = await fetchWithRetry(`${server.url}/x`, { method: "POST", body: "{}" }, fast());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: 1 });
    expect(server.requestsTo("/x")).toHaveLength(2);
    expect(sleeps).toEqual([2000]); // max(jittered backoff 375 ms, Retry-After 2 s)
  });

  it("backs off exponentially with jitter on 5xx and stops after 3 attempts with the last response", async () => {
    server.on(
      "/x",
      { status: 503, json: {} },
      { status: 500, json: {} },
      { status: 502, json: { last: true } },
    );

    const res = await fetchWithRetry(`${server.url}/x`, {}, fast());

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ last: true });
    expect(server.requestsTo("/x")).toHaveLength(3);
    expect(sleeps).toEqual([375, 750]); // 500 ms then 1000 ms ceilings, half fixed plus half jitter (random 0.5)
  });

  it("never retries other 4xx", async () => {
    for (const status of [400, 401, 402, 403, 404, 413]) server.on(`/s${status}`, { status, json: {} });
    for (const status of [400, 401, 402, 403, 404, 413]) {
      const res = await fetchWithRetry(`${server.url}/s${status}`, {}, fast());
      expect(res.status).toBe(status);
    }
    expect(server.requests).toHaveLength(6);
    expect(sleeps).toEqual([]);
  });

  it("does not retry a 504 gateway_timeout (the same request usually times out again)", async () => {
    server.on("/x", { status: 504, json: {} }, { json: {} });
    const res = await fetchWithRetry(`${server.url}/x`, {}, fast());
    expect(res.status).toBe(504);
    expect(server.requestsTo("/x")).toHaveLength(1);
  });

  it("retries network errors", async () => {
    server.on("/x", { destroy: true }, { json: { ok: true } });
    const res = await fetchWithRetry(`${server.url}/x`, {}, fast());
    expect(res.status).toBe(200);
    expect(sleeps).toHaveLength(1);
  });

  it("returns the 429 instead of waiting when Retry-After exceeds the cap or the deadline", async () => {
    server.on("/a", { status: 429, json: {}, headers: { "retry-after": "120" } });
    const a = await fetchWithRetry(`${server.url}/a`, {}, { ...fast(), maxRetryAfterMs: 60_000 });
    expect(a.status).toBe(429);

    server.on("/b", { status: 429, json: {}, headers: { "retry-after": "5" } });
    const b = await fetchWithRetry(`${server.url}/b`, {}, { ...fast(), deadlineAt: Date.now() + 1_000 });
    expect(b.status).toBe(429);
    expect(sleeps).toEqual([]);
  });

  it("stops waiting when the signal aborts during a backoff", async () => {
    server.on("/x", { status: 503, json: {} }, { json: {} });
    const controller = new AbortController();
    const pending = fetchWithRetry(
      `${server.url}/x`,
      { signal: controller.signal },
      { baseDelayMs: 10_000, maxDelayMs: 10_000 },
    );
    setTimeout(() => controller.abort(new Error("cancelled")), 50);
    await expect(pending).rejects.toThrow("cancelled");
    expect(server.requestsTo("/x")).toHaveLength(1);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    const now = Date.parse("2026-10-27T12:00:00Z");
    expect(parseRetryAfter("15", now)).toBe(15_000);
    expect(parseRetryAfter("0.5", now)).toBe(500);
    expect(parseRetryAfter("Tue, 27 Oct 2026 12:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("soon", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe("encodeMultipart", () => {
  it("writes parts in order, with filename and content type only where given", async () => {
    const { body, contentType } = encodeMultipart([
      { name: "request", value: '{"model":"m"}', contentType: "application/json" },
      { name: "audio", value: new Uint8Array([1, 2, 3]), filename: "a.wav", contentType: "audio/wav" },
    ]);
    const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
    expect(form.get("request")).toBeTypeOf("string"); // no filename: a plain field, as curl -F 'request=...;type=...' sends
    const audio = form.get("audio") as File;
    expect(audio.name).toBe("a.wav");
    expect(audio.type).toBe("audio/wav");
    expect(new Uint8Array(await audio.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("redact", () => {
  it("removes data URLs, long base64 runs and secrets", () => {
    const text = `x data:image/jpeg;base64,${"QUJD".repeat(80)} y ${"Z".repeat(250)} key sk-secret-123`;
    const out = redact(text, ["sk-secret-123"]);
    expect(out).toBe("x data:image/jpeg;base64,<redacted> y <redacted> key <redacted>");
  });
});

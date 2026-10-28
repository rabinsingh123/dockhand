import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ArtifactKind,
  type ArtifactRef,
  type CallCtx,
  createFixedClock,
  createLogger,
  createMemoryArtifactStore,
  type Ledger,
  type MetaMode,
  type ModelCallRecord,
  type ModelGateway,
} from "@dockhand/core";
import type { CuState } from "../computer-use.ts";
import type { MetaConfig } from "../config.ts";
import { createModelGateway } from "../gateway.ts";
import { type MockServer, startMockServer } from "./mock-server.ts";

export const META_KEY = "test-meta-key-0123456789";
export const BASETEN_KEY = "test-baseten-key-9876543210";
export const OPEN_WEIGHTS_MODEL = "meta-models/muse-spark-open";

/** A ledger that keeps rows in memory so tests can read each one. */
export function memoryLedger(): Ledger & { rows: ModelCallRecord[] } {
  const rows: ModelCallRecord[] = [];
  return {
    rows,
    record: (r) => {
      rows.push(r);
    },
    totals: (f) => {
      const picked = rows.filter(
        (r) =>
          (f.jobId === undefined || r.jobId === f.jobId) &&
          (f.runId === undefined || r.runId === f.runId) &&
          (f.purposes === undefined || f.purposes.includes(r.purpose)),
      );
      return {
        calls: picked.length,
        costUsd: picked.reduce((n, r) => n + r.costUsd, 0),
        latencyMs: picked.reduce((n, r) => n + r.latencyMs, 0),
      };
    },
  };
}

export interface WorldOptions {
  mode?: MetaMode;
  cassetteDir?: string;
  disableParallelToolCalls?: boolean;
  computerUseState?: CuState;
  openWeights?: Partial<MetaConfig["openWeights"]>;
  metaApiKey?: string;
  /** Replaces fetch (cassette tests pass one that fails on any network use). */
  fetch?: typeof fetch;
  /** Reuse a server across gateways. */
  server?: MockServer;
}

export interface World {
  server: MockServer;
  gateway: ModelGateway;
  ledger: ReturnType<typeof memoryLedger>;
  logs: string[];
  sleeps: number[];
  config: MetaConfig;
  put(bytes: Uint8Array, mime: string, kind?: ArtifactKind): Promise<ArtifactRef>;
  close(): Promise<void>;
}

export async function makeWorld(opts: WorldOptions = {}): Promise<World> {
  const server = opts.server ?? (await startMockServer());
  const ledger = memoryLedger();
  const logs: string[] = [];
  const sleeps: number[] = [];
  const artifacts = createMemoryArtifactStore();
  const config: MetaConfig = {
    meta: { mode: opts.mode ?? "live", apiKey: opts.metaApiKey ?? META_KEY, baseUrl: `${server.url}/v1` },
    openWeights: {
      model: OPEN_WEIGHTS_MODEL,
      apiKey: BASETEN_KEY,
      baseUrl: `${server.url}/baseten/v1`,
      priceInPerM: 1.25,
      priceOutPerM: 4.25,
      ...opts.openWeights,
    },
  };
  const gateway = createModelGateway({
    config,
    ledger,
    artifacts,
    clock: createFixedClock(Date.parse("2026-10-27T12:00:00Z")),
    log: createLogger({ level: "debug", write: (line) => logs.push(line) }),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(opts.cassetteDir ? { cassetteDir: opts.cassetteDir } : {}),
    ...(opts.disableParallelToolCalls ? { disableParallelToolCalls: true } : {}),
    ...(opts.computerUseState ? { computerUseState: opts.computerUseState } : {}),
    retry: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  });
  return {
    server,
    gateway,
    ledger,
    logs,
    sleeps,
    config,
    put: (bytes, mime, kind = "inbound_media") => artifacts.put(bytes, mime, { kind }),
    close: () => (opts.server ? Promise.resolve() : server.close()),
  };
}

export function ctx(purpose: CallCtx["purpose"] = "extract", extra: Partial<CallCtx> = {}): CallCtx {
  return { purpose, timeoutMs: 10_000, jobId: "job-1", ...extra };
}

export async function tempDir(): Promise<{ path: string; remove(): Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), "dockhand-meta-"));
  return { path, remove: () => rm(path, { recursive: true, force: true }) };
}

// ---- documented shapes ------------------------------------------------------------------------------

const DOCS_DIR = fileURLToPath(new URL("../__fixtures__/docs/", import.meta.url));

export function docFixture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(join(DOCS_DIR, name), "utf8")) as T;
}

/** Narrows away undefined (fails the test with a clear message instead of a TypeError). */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to be present`);
  return value;
}

/** Recursively compares key structure (object keys and array lengths), ignoring leaf values. */
export function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, shapeOf(v)]),
    );
  }
  return typeof value;
}

// ---- synthetic media --------------------------------------------------------------------------------

export function pngBytes(seed = 0): Uint8Array {
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    seed & 0xff,
    1,
    2,
    3,
  ]);
}

export function jpegBytes(): Uint8Array {
  return Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);
}

export function pdfBytes(text = "Tidewater Cloud supplier form"): Uint8Array {
  return new TextEncoder().encode(`%PDF-1.4\n% ${text}\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n`);
}

export function mp4Bytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0, 0, 0, 0x18], 0);
  bytes.set(new TextEncoder().encode("ftypisom"), 4);
  return bytes;
}

/** RIFF/WAVE with a 16-byte PCM fmt chunk and `ms` of silence. */
export function wavBytes(
  o: { sampleRate?: number; channels?: number; bits?: number; ms?: number } = {},
): Uint8Array {
  const sampleRate = o.sampleRate ?? 16000;
  const channels = o.channels ?? 1;
  const bits = o.bits ?? 16;
  const dataBytes = Math.round(((o.ms ?? 1500) / 1000) * sampleRate) * channels * (bits / 8);
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  buf.writeUInt16LE((channels * bits) / 8, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function b64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ---- canned Responses API bodies --------------------------------------------------------------------

export function responseBody(
  output: unknown[],
  o: { id?: string; status?: string; usage?: unknown; incomplete?: string } = {},
): Record<string, unknown> {
  return {
    id: o.id ?? "resp_test_1",
    object: "response",
    created_at: 1714502400,
    status: o.status ?? "completed",
    model: "muse-spark-1.3",
    output,
    incomplete_details: o.incomplete ? { reason: o.incomplete } : null,
    usage: o.usage ?? {
      input_tokens: 1200,
      input_tokens_details: { cached_tokens: 200 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 100 },
      total_tokens: 1500,
    },
  };
}

export function reasoningItem(id = "rs_1"): Record<string, unknown> {
  return { type: "reasoning", id, summary: [] };
}

export function messageItem(text: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
    ...extra,
  };
}

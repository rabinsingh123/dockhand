import { randomUUID } from "node:crypto";
import type { Logger } from "@dockhand/core";
import { DockhandError } from "@dockhand/core";

// ---- fetchWithRetry -------------------------------------------------------------------------------

export interface RetryPolicy {
  /** Total attempts, the first one included. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this is not waited out: the response is returned to the caller. */
  maxRetryAfterMs: number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export const DEFAULT_RETRY_POLICY: Readonly<RetryPolicy> = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
  sleep: abortableSleep,
  random: Math.random,
});

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  status?: number;
  error?: string;
}

export interface FetchWithRetryOptions extends Partial<RetryPolicy> {
  fetch?: typeof fetch;
  /** Epoch ms (wall clock). A retry whose wait would end after this is not started. */
  deadlineAt?: number;
  onRetry?: (e: RetryEvent) => void;
}

/**
 * Retries 429, 5xx (except 504) and network errors with jittered exponential backoff, honoring Retry-After.
 * Never retries other 4xx. 504 is excluded because Meta documents that the same request usually times out
 * again (https://dev.meta.ai/docs/error-handling). After the last attempt the final response is returned
 * (or the final network error thrown); mapping status codes to errors is the caller's job.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  opts: FetchWithRetryOptions = {},
): Promise<Response> {
  const policy = resolvePolicy(opts);
  const doFetch = opts.fetch ?? fetch;
  const signal = init.signal ?? undefined;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(url, init);
    } catch (err) {
      if (signal?.aborted || attempt >= policy.maxAttempts || !isNetworkError(err)) throw err;
      const delayMs = backoffMs(policy, attempt);
      if (!fitsDeadline(opts.deadlineAt, delayMs)) throw err;
      opts.onRetry?.({ attempt, delayMs, error: errorName(err) });
      await policy.sleep(delayMs, signal);
      continue;
    }
    if (!isRetryableStatus(res.status) || attempt >= policy.maxAttempts) return res;
    const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"), Date.now());
    if (retryAfterMs !== undefined && retryAfterMs > policy.maxRetryAfterMs) return res;
    const delayMs = Math.max(backoffMs(policy, attempt), retryAfterMs ?? 0);
    if (!fitsDeadline(opts.deadlineAt, delayMs)) return res;
    await res.body?.cancel().catch(() => undefined);
    opts.onRetry?.({ attempt, delayMs, status: res.status });
    await policy.sleep(delayMs, signal);
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599 && status !== 504);
}

/** Retry-After as delta-seconds or an HTTP date; undefined when absent or unparseable. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function resolvePolicy(opts: FetchWithRetryOptions): RetryPolicy {
  return {
    maxAttempts: opts.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts,
    baseDelayMs: opts.baseDelayMs ?? DEFAULT_RETRY_POLICY.baseDelayMs,
    maxDelayMs: opts.maxDelayMs ?? DEFAULT_RETRY_POLICY.maxDelayMs,
    maxRetryAfterMs: opts.maxRetryAfterMs ?? DEFAULT_RETRY_POLICY.maxRetryAfterMs,
    sleep: opts.sleep ?? DEFAULT_RETRY_POLICY.sleep,
    random: opts.random ?? DEFAULT_RETRY_POLICY.random,
  };
}

function backoffMs(policy: RetryPolicy, attempt: number): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(ceiling / 2 + (policy.random() * ceiling) / 2);
}

function fitsDeadline(deadlineAt: number | undefined, delayMs: number): boolean {
  return deadlineAt === undefined || Date.now() + delayMs < deadlineAt;
}

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "AbortError" || err.name === "TimeoutError") return false;
  if (err instanceof TypeError) return true; // undici: "fetch failed" with the socket error as cause
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && (code.startsWith("E") || code.startsWith("UND_ERR"));
}

function errorName(err: unknown): string {
  if (!(err instanceof Error)) return "unknown";
  const cause = (err as { cause?: { code?: unknown } }).cause;
  return typeof cause?.code === "string" ? `${err.name} (${cause.code})` : err.name;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// ---- multipart/form-data ----------------------------------------------------------------------------

export interface MultipartPart {
  name: string;
  value: string | Uint8Array;
  contentType?: string;
  filename?: string;
}

/**
 * Builds the body by hand (FormData always adds a filename to Blob parts, and the transcribe endpoint's
 * `request` part is a JSON field without one). Parts are written in the order given.
 */
export function encodeMultipart(parts: MultipartPart[]): {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
} {
  const boundary = `----dockhand${randomUUID().replaceAll("-", "")}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${headerValue(part.name)}"`;
    if (part.filename !== undefined) head += `; filename="${headerValue(part.filename)}"`;
    head += "\r\n";
    if (part.contentType !== undefined) head += `Content-Type: ${part.contentType}\r\n`;
    head += "\r\n";
    chunks.push(encoder.encode(head));
    chunks.push(typeof part.value === "string" ? encoder.encode(part.value) : part.value);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  return { body: concatBytes(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

function headerValue(s: string): string {
  return s.replace(/[\r\n]/g, " ").replaceAll('"', "%22");
}

function concatBytes(chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// ---- provider client --------------------------------------------------------------------------------

export type HttpProvider = "meta" | "baseten";

export interface RequestScope {
  signal: AbortSignal;
  /** Epoch ms (wall clock) when the gateway call times out. */
  deadlineAt: number;
}

export interface ProviderClient {
  readonly provider: HttpProvider;
  postJson(path: string, body: unknown, scope: RequestScope): Promise<unknown>;
  postMultipart(
    path: string,
    parts: MultipartPart[],
    scope: RequestScope,
    opts?: { query?: Record<string, string>; accept?: string },
  ): Promise<unknown>;
}

export interface ProviderClientOptions {
  provider: HttpProvider;
  baseUrl: string;
  apiKey: string | undefined;
  log: Logger;
  fetch?: typeof fetch;
  retry?: Partial<RetryPolicy>;
}

export function createProviderClient(o: ProviderClientOptions): ProviderClient {
  const base = o.baseUrl.replace(/\/+$/, "");
  const secrets = o.apiKey ? [o.apiKey] : [];

  async function send(path: string, init: RequestInit, scope: RequestScope, query?: Record<string, string>) {
    if (!o.apiKey) throw new DockhandError("MODEL_ERROR", `${o.provider}: no API key configured`);
    const url = new URL(`${base}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${o.apiKey}`);
    const res = await fetchWithRetry(
      url,
      { ...init, headers, signal: scope.signal },
      {
        ...o.retry,
        fetch: o.fetch,
        deadlineAt: scope.deadlineAt,
        onRetry: (e) => o.log.warn("model http retry", { provider: o.provider, path, ...e }),
      },
    );
    if (!res.ok) throw await errorFromResponse(res, o.provider, secrets);
    const text = await res.text();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new DockhandError("MODEL_ERROR", `${o.provider}: response from ${path} is not JSON`, {
        provider: o.provider,
        status: res.status,
      });
    }
  }

  return {
    provider: o.provider,
    postJson(path, body, scope) {
      return send(
        path,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(body),
        },
        scope,
      );
    },
    postMultipart(path, parts, scope, opts) {
      const { body, contentType } = encodeMultipart(parts);
      return send(
        path,
        {
          method: "POST",
          headers: { "content-type": contentType, accept: opts?.accept ?? "application/json" },
          body,
        },
        scope,
        opts?.query,
      );
    },
  };
}

/** Error details a caller may branch on; `message` is redacted (no base64, no keys). */
export interface ProviderErrorDetail {
  provider: HttpProvider;
  status: number;
  type?: string;
  code?: string;
  param?: string;
  message: string;
}

export async function errorFromResponse(
  res: Response,
  provider: HttpProvider,
  secrets: string[],
): Promise<DockhandError> {
  const raw = (await res.text().catch(() => "")).slice(0, 4000);
  let type: string | undefined;
  let code: string | undefined;
  let param: string | undefined;
  let message = raw;
  try {
    const envelope = JSON.parse(raw) as {
      error?: { message?: unknown; type?: unknown; code?: unknown; param?: unknown };
    };
    const e = envelope.error;
    if (e && typeof e === "object") {
      if (typeof e.message === "string") message = e.message;
      if (typeof e.type === "string") type = e.type;
      if (typeof e.code === "string") code = e.code;
      if (typeof e.param === "string") param = e.param;
    }
  } catch {
    // not the JSON envelope (e.g. an empty 404 body); keep the raw text
  }
  const detail: ProviderErrorDetail = {
    provider,
    status: res.status,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
    message: redact(message || res.statusText, secrets),
  };
  return new DockhandError(
    "MODEL_ERROR",
    `${provider} HTTP ${res.status}${type ? ` ${type}` : ""}: ${detail.message}`,
    detail,
  );
}

export function providerErrorDetail(err: unknown): ProviderErrorDetail | undefined {
  if (!(err instanceof DockhandError)) return undefined;
  const d = err.detail as Partial<ProviderErrorDetail> | undefined;
  return d && typeof d.status === "number" && typeof d.provider === "string"
    ? (d as ProviderErrorDetail)
    : undefined;
}

/** Strips inline media and secrets from text that may echo a request (error messages). */
export function redact(text: string, secrets: string[] = []): string {
  let out = text.replace(/data:([\w.+/-]+);base64,[A-Za-z0-9+/=]+/g, "data:$1;base64,<redacted>");
  out = out.replace(/[A-Za-z0-9+/=]{200,}/g, "<redacted>");
  for (const s of secrets) if (s.length >= 8) out = out.replaceAll(s, "<redacted>");
  return out;
}

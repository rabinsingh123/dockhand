// Shared server plumbing for both portals: per-context sessions, admin/test endpoints, HTML shell,
// start/stop.
//
// State model: the portal holds DEFAULTS (version, mutation) that admin endpoints and
// setVersion/setMutation change (the on-camera "flip to v2"). A browser context that carries a
// test-session cookie (POST /api/__test/session or handle.session()) can pin its own ui, mutation and
// runId, so parallel eval workers never affect each other or the live demo.

import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  createMutator,
  isMutationOperator,
  type Mutator,
  resolveMutation,
  resolveOperators,
} from "../shared/mutations.ts";
import type {
  BootPayload,
  MutationConfig,
  MutationOperator,
  PortalConfig,
  PortalKind,
  PortalVersion,
  ResolvedMutation,
  SessionCookie,
  SessionOptions,
  Submission,
} from "../shared/types.ts";
import { localIsoDate } from "../shared/validate.ts";
import { bundleClient, clientEntry } from "./bundle.ts";

export interface StartOptions {
  /** 0 = random free port. */
  port?: number;
  /** Bind address. Default 127.0.0.1. */
  host?: string;
  /** Default UI version for contexts that did not pin one. */
  version?: PortalVersion;
  /** Default mutation for contexts that did not pin one. */
  mutation?: MutationConfig | null;
  /** Simulated server latency on submits and logins, [min, max] ms. Default [300, 600]. */
  latencyMs?: readonly [number, number];
}

export interface PortalHandle {
  readonly portal: PortalKind;
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
  /** Sets the DEFAULT version (contexts without a pinned ui). Next page load. No-op on the supplier portal. */
  setVersion(v: PortalVersion): void;
  /** Sets the DEFAULT mutation (contexts without a pinned mutation). Next page load. */
  setMutation(m: MutationConfig | null): void;
  /**
   * Creates an authenticated session for one browser context and returns its cookies
   * (`context.addCookies(cookies)`). No HTTP round trip. Submissions are tagged with `runId`.
   * - `ui` given: ui is pinned, and the mutation is pinned too (`mutation` or none if omitted).
   * - neither `ui` nor `mutation` given: the context follows the portal defaults (live demo flips).
   * - `mutation: null` pins "no mutation"; the supplier portal ignores `ui` for rendering.
   */
  session(opts: SessionOptions): Promise<SessionCookie[]>;
  /** Ground truth for evals (deep copy), optionally filtered by runId. */
  submissions(filter?: { runId?: string }): Submission[];
  /** Clears submissions and UI-created records (all, or only one runId). Keeps sessions and defaults. */
  reset(filter?: { runId?: string }): void;
  /** Default config (what a context without a test session gets). */
  config(): PortalConfig;
}

export interface Session {
  token: string;
  username: string;
  /** Supplier: tenant slug -> invite code used to start registration. */
  invites: Record<string, string>;
  /** Pinned UI version; undefined = follow the default. */
  ui?: PortalVersion;
  /** Pinned mutation; undefined = follow the default, null = pinned "none". */
  mutation?: MutationConfig | null;
  runId: string | null;
}

export interface Effective {
  session: Session | null;
  version: PortalVersion;
  mutation: MutationConfig | null;
  runId: string | null;
  /** Scope for per-client idempotency (runId, else session token, else "anonymous"). */
  scope: string;
}

export interface PortalSpec {
  portal: PortalKind;
  title: string;
  themeColor: string;
  cookiePrefix: string;
  /** The portal has a single UI version (supplier): ui pins and setVersion are ignored. */
  singleVersion?: boolean;
  mount(app: Hono, ctx: PortalContext): void;
}

export class PortalContext {
  version: PortalVersion;
  mutation: MutationConfig | null;
  readonly submissionLog: Submission[] = [];
  scriptSrc = "/assets/app.js";
  cookieName: string;
  private readonly sessions = new Map<string, Session>();
  private readonly resetHooks: Array<(runId?: string) => void> = [];
  private readonly latency: readonly [number, number];

  constructor(
    readonly spec: PortalSpec,
    opts: StartOptions,
  ) {
    this.version = spec.singleVersion ? "v1" : (opts.version ?? "v1");
    this.mutation = opts.mutation ? normalizeMutationConfig(opts.mutation) : null;
    this.latency = opts.latencyMs ?? [300, 600];
    this.cookieName = spec.cookiePrefix;
  }

  get portal(): PortalKind {
    return this.spec.portal;
  }

  setDefaultVersion(v: PortalVersion): void {
    if (v !== "v1" && v !== "v2") throw new Error(`unknown version: ${String(v)}`);
    if (!this.spec.singleVersion) this.version = v;
  }

  /** Effective state for the requesting browser context. */
  effective(c: Context): Effective {
    const session = this.session(c);
    const pinnedUi = this.spec.singleVersion ? undefined : session?.ui;
    return {
      session,
      version: pinnedUi ?? this.version,
      mutation: session && session.mutation !== undefined ? session.mutation : this.mutation,
      runId: session?.runId ?? null,
      scope: session?.runId ?? session?.token ?? "anonymous",
    };
  }

  configFor(eff: Pick<Effective, "version" | "mutation" | "runId">): PortalConfig {
    const now = new Date();
    return {
      portal: this.portal,
      version: eff.version,
      mutation: eff.mutation,
      operators: resolveOperators(this.portal, eff.mutation),
      serverDate: localIsoDate(now),
      serverTime: now.toISOString(),
      runId: eff.runId,
    };
  }

  defaultConfig(): PortalConfig {
    return this.configFor({ version: this.version, mutation: this.mutation, runId: null });
  }

  today(): string {
    return localIsoDate();
  }

  mutatorFor(eff: Pick<Effective, "mutation">): Mutator {
    return createMutator(this.portal, eff.mutation);
  }

  resolvedMutationFor(eff: Pick<Effective, "mutation">): ResolvedMutation | undefined {
    return resolveMutation(this.portal, eff.mutation);
  }

  createSession(init: Partial<Omit<Session, "token">> = {}): Session {
    const session: Session = {
      token: randomBytes(18).toString("base64url"),
      username: init.username ?? "dockhand",
      invites: init.invites ?? {},
      runId: init.runId ?? null,
      ...(init.ui !== undefined ? { ui: init.ui } : {}),
      ...(init.mutation !== undefined ? { mutation: init.mutation } : {}),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** Validates SessionOptions-like input and creates a pinned test session. Throws on bad input. */
  createTestSession(input: unknown): Session {
    const o = isRecord(input) ? input : {};
    const ui = o.ui;
    if (ui !== undefined && ui !== null && ui !== "v1" && ui !== "v2")
      throw new Error('ui must be "v1" or "v2"');
    const runId = o.runId;
    if (runId !== undefined && runId !== null && (typeof runId !== "string" || runId.trim() === "")) {
      throw new Error("runId must be a non-empty string");
    }
    // A context that pins its ui is an isolated (eval) context: an omitted mutation means "none", so
    // it never inherits a default mutation set for a live demo. With neither ui nor mutation given,
    // the context follows the portal defaults (the live-demo context).
    const uiGiven = ui === "v1" || ui === "v2";
    const mutation =
      o.mutation === undefined
        ? uiGiven
          ? null
          : undefined
        : o.mutation === null
          ? null
          : normalizeMutationConfig(o.mutation);
    const username = typeof o.username === "string" && o.username.trim() ? o.username.trim() : "ana.souza";
    return this.createSession({
      username,
      runId: typeof runId === "string" ? runId : null,
      ...(uiGiven && !this.spec.singleVersion ? { ui } : {}),
      ...(mutation !== undefined ? { mutation } : {}),
    });
  }

  session(c: Context): Session | null {
    const token = getCookie(c, this.cookieName);
    return token ? (this.sessions.get(token) ?? null) : null;
  }

  sessionCookie(session: Session, domain: string): SessionCookie {
    return { name: this.cookieName, value: session.token, domain, path: "/" };
  }

  setSessionCookie(c: Context, session: Session): void {
    setCookie(c, this.cookieName, session.token, { path: "/", httpOnly: true, sameSite: "Lax" });
  }

  clearSession(c: Context): void {
    const token = getCookie(c, this.cookieName);
    if (token) this.sessions.delete(token);
    deleteCookie(c, this.cookieName, { path: "/" });
  }

  async delay(): Promise<void> {
    const [min, max] = this.latency;
    const ms = min + Math.random() * Math.max(0, max - min);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  record(submission: Submission): void {
    this.submissionLog.push(submission);
  }

  submissions(runId?: string): Submission[] {
    return runId === undefined ? this.submissionLog : this.submissionLog.filter((s) => s.runId === runId);
  }

  onReset(fn: (runId?: string) => void): void {
    this.resetHooks.push(fn);
  }

  reset(runId?: string): void {
    if (runId === undefined) this.submissionLog.length = 0;
    else {
      const keep = this.submissionLog.filter((s) => s.runId !== runId);
      this.submissionLog.length = 0;
      this.submissionLog.push(...keep);
    }
    for (const fn of this.resetHooks) fn(runId);
  }

  html(
    c: Context,
    opts: { status?: ContentfulStatusCode; data?: Record<string, unknown> | null } = {},
  ): Response {
    const eff = this.effective(c);
    const boot: BootPayload = {
      ...this.configFor(eff),
      path: c.req.path,
      user: eff.session ? { username: eff.session.username } : null,
      data: opts.data ?? null,
    };
    c.header("cache-control", "no-store");
    return c.html(
      renderShell({
        title: this.spec.title,
        boot,
        scriptSrc: this.scriptSrc,
        themeColor: this.spec.themeColor,
      }),
      opts.status ?? 200,
    );
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

export function renderShell(opts: {
  title: string;
  boot: BootPayload;
  scriptSrc: string;
  themeColor: string;
}): string {
  // Escape "<" and the JS line separators so the JSON cannot break out of the script element.
  const bs = "\\";
  const json = JSON.stringify(opts.boot)
    .replace(/</g, `${bs}u003c`)
    .split(String.fromCharCode(0x2028))
    .join(`${bs}u2028`)
    .split(String.fromCharCode(0x2029))
    .join(`${bs}u2029`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="${escapeHtml(opts.themeColor)}">
<title>${escapeHtml(opts.title)}</title>
<link rel="icon" href="data:,">
</head>
<body>
<div id="root"></div>
<noscript>This portal needs JavaScript.</noscript>
<script id="__boot" type="application/json">${json}</script>
<script type="module" src="${escapeHtml(opts.scriptSrc)}"></script>
</body>
</html>`;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** Validates and normalizes a MutationConfig; throws on bad input. */
export function normalizeMutationConfig(input: unknown): MutationConfig {
  if (!isRecord(input)) throw new Error("mutation must be an object like { seed: 42 }");
  const seed = typeof input.seed === "string" && input.seed.trim() !== "" ? Number(input.seed) : input.seed;
  if (typeof seed !== "number" || !Number.isInteger(seed))
    throw new Error("mutation.seed must be an integer");
  if (input.operators === undefined || input.operators === null) return { seed };
  const raw = typeof input.operators === "string" ? input.operators.split(",") : input.operators;
  if (!Array.isArray(raw)) throw new Error("mutation.operators must be an array of operator ids");
  const operators: MutationOperator[] = [];
  for (const op of raw) {
    const id = typeof op === "string" ? op.trim() : op;
    if (id === "") continue;
    if (!isMutationOperator(id)) throw new Error(`unknown mutation operator: ${String(id)}`);
    if (!operators.includes(id)) operators.push(id);
  }
  return { seed, operators };
}

function parseMutationInput(body: unknown, query: Record<string, string>): MutationConfig | null {
  if (query.seed !== undefined)
    return normalizeMutationConfig({ seed: query.seed, operators: query.operators });
  const value = isRecord(body) && "mutation" in body ? body.mutation : body;
  if (value === null || value === undefined) return null;
  if (isRecord(value) && Object.keys(value).length === 0) return null;
  return normalizeMutationConfig(value);
}

function runIdParam(c: Context, body?: unknown): string | undefined {
  const fromQuery = c.req.query("runId");
  if (fromQuery) return fromQuery;
  return isRecord(body) && typeof body.runId === "string" && body.runId ? body.runId : undefined;
}

function mountCommon(app: Hono, ctx: PortalContext, code: string): void {
  app.get("/assets/app.js", (c) => {
    c.header("content-type", "text/javascript; charset=utf-8");
    c.header("cache-control", "no-cache");
    return c.body(code);
  });
  app.get("/favicon.ico", (c) => c.body(null, 204));

  // Effective config for the requesting context.
  app.get("/api/__config", (c) => c.json(ctx.configFor(ctx.effective(c))));

  // Defaults (contexts without a pinned value). This is what the live "flip to v2" changes.
  app.get("/api/__admin/version", (c) => c.json({ version: ctx.version }));
  app.post("/api/__admin/version", async (c) => {
    const body = await readJson(c);
    const v = (isRecord(body) ? body.version : undefined) ?? c.req.query("version");
    if (v !== "v1" && v !== "v2") return c.json({ error: 'version must be "v1" or "v2"' }, 400);
    ctx.setDefaultVersion(v);
    return c.json({ version: ctx.version });
  });
  app.get("/api/__admin/mutation", (c) =>
    c.json({ mutation: ctx.mutation, operators: ctx.defaultConfig().operators }),
  );
  app.post("/api/__admin/mutation", async (c) => {
    try {
      ctx.mutation = parseMutationInput(await readJson(c), c.req.query());
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ mutation: ctx.mutation, operators: ctx.defaultConfig().operators });
  });
  app.delete("/api/__admin/mutation", (c) => {
    ctx.mutation = null;
    return c.json({ mutation: null, operators: [] });
  });

  // Test harness endpoints.
  app.post("/api/__test/session", async (c) => {
    let session: Session;
    try {
      session = ctx.createTestSession(await readJson(c));
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
    return c.json({ cookies: [ctx.sessionCookie(session, new URL(c.req.url).hostname)] });
  });
  app.get("/api/__test/submissions", (c) => c.json(ctx.submissions(c.req.query("runId") || undefined)));
  app.post("/api/__test/reset", async (c) => {
    const runId = runIdParam(c, await readJson(c));
    ctx.reset(runId);
    return c.json({ ok: true, runId: runId ?? null });
  });

  // Login: any non-empty username and password. Login sessions follow the defaults.
  app.post("/api/login", async (c) => {
    const body = await readJson(c);
    const username = isRecord(body) && typeof body.username === "string" ? body.username.trim() : "";
    const password = isRecord(body) && typeof body.password === "string" ? body.password : "";
    const fieldErrors: Record<string, string> = {};
    if (!username) fieldErrors.username = "Enter your username.";
    if (!password) fieldErrors.password = "Enter your password.";
    await ctx.delay();
    if (Object.keys(fieldErrors).length > 0) return c.json({ error: "validation_failed", fieldErrors }, 400);
    const session = ctx.createSession({ username });
    ctx.setSessionCookie(c, session);
    return c.json({ ok: true, user: { username } });
  });
  app.post("/api/logout", (c) => {
    ctx.clearSession(c);
    return c.json({ ok: true });
  });
}

function listen(app: Hono, hostname: string, port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
      resolve({ server: server as Server, port: info.port });
    });
    server.once("error", reject);
  });
}

export async function startPortal(spec: PortalSpec, opts: StartOptions = {}): Promise<PortalHandle> {
  const bundle = await bundleClient(clientEntry(spec.portal));
  const ctx = new PortalContext(spec, opts);
  ctx.scriptSrc = `/assets/app.js?v=${bundle.hash}`;

  const app = new Hono();
  mountCommon(app, ctx, bundle.code);
  spec.mount(app, ctx);
  app.notFound((c) =>
    c.req.path.startsWith("/api/")
      ? c.json({ error: "not_found" }, 404)
      : ctx.html(c, { status: 404, data: { notFound: true } }),
  );
  app.onError((err, c) => {
    console.error(`[${spec.portal} portal]`, err);
    return c.json({ error: "internal_error" }, 500);
  });

  const host = opts.host ?? "127.0.0.1";
  const { server, port } = await listen(app, host, opts.port ?? 0);
  // Cookies are not port-scoped, so the port is part of the name: two portal instances on the same
  // host never read each other's sessions.
  ctx.cookieName = `${spec.cookiePrefix}_${port}`;
  const urlHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  let closing: Promise<void> | null = null;

  return {
    portal: spec.portal,
    url: `http://${urlHost}:${port}`,
    port,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
      return closing;
    },
    setVersion(v) {
      ctx.setDefaultVersion(v);
    },
    setMutation(m) {
      ctx.mutation = m === null ? null : normalizeMutationConfig(m);
    },
    async session(sessionOpts) {
      const session = ctx.createTestSession(sessionOpts);
      return [ctx.sessionCookie(session, urlHost)];
    },
    submissions(filter) {
      return structuredClone(ctx.submissions(filter?.runId));
    },
    reset(filter) {
      ctx.reset(filter?.runId);
    },
    config() {
      return ctx.defaultConfig();
    },
  };
}

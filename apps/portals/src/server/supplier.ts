// Multi-tenant supplier portal server: invite landing, wizard routes, multipart final submit.

import { createHash } from "node:crypto";
import type { Context, Hono } from "hono";
import type { FileMeta } from "../shared/fields.ts";
import {
  getTenant,
  isValidInviteCode,
  SUPPLIER_FILE_FIELDS,
  supplierSections,
  type TenantInfo,
  type TenantSlug,
} from "../shared/supplierSchema.ts";
import type { SubmittedFile, SupplierRecord } from "../shared/types.ts";
import { validateSections } from "../shared/validate.ts";
import {
  isRecord,
  type PortalContext,
  type PortalHandle,
  readJson,
  type StartOptions,
  startPortal,
} from "./core.ts";

const FIRST_ID: Record<TenantSlug, number> = { acme: 123, globex: 311 };

class SupplierStore {
  private readonly records = new Map<string, { record: SupplierRecord; runId: string | null }>();
  private readonly counters: Record<TenantSlug, number> = { ...FIRST_ID };

  create(
    tenant: TenantInfo,
    legalName: string,
    primaryContactEmail: string,
    runId: string | null,
  ): SupplierRecord {
    const n = this.counters[tenant.slug]++;
    const record: SupplierRecord = {
      id: `${tenant.idPrefix}${String(n).padStart(6, "0")}`,
      tenant: tenant.slug,
      status: "Pending buyer approval",
      submittedAt: new Date().toISOString(),
      legalName,
      primaryContactEmail,
    };
    this.records.set(record.id, { record, runId });
    return record;
  }

  get(tenant: string, id: string): SupplierRecord | undefined {
    const r = this.records.get(id.toUpperCase())?.record;
    return r && r.tenant === tenant ? r : undefined;
  }

  reset(runId?: string): void {
    for (const [id, entry] of this.records)
      if (runId === undefined || entry.runId === runId) this.records.delete(id);
  }
}

interface ParsedSubmit {
  payload: Record<string, unknown>;
  files: Record<string, File>;
}

async function parseSubmit(c: Context): Promise<ParsedSubmit | null> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const rawPayload = form.get("payload");
    let payload: unknown = {};
    if (typeof rawPayload === "string") {
      try {
        payload = JSON.parse(rawPayload);
      } catch {
        return null;
      }
    }
    if (!isRecord(payload)) return null;
    const files: Record<string, File> = {};
    for (const key of SUPPLIER_FILE_FIELDS) {
      const value = form.get(key);
      if (value && typeof value !== "string") files[key] = value;
    }
    return { payload, files };
  }
  const body = await readJson(c);
  return isRecord(body) ? { payload: body, files: {} } : null;
}

function mountSupplier(app: Hono, ctx: PortalContext): void {
  const store = new SupplierStore();
  ctx.onReset((runId) => store.reset(runId));

  const loginRedirect = (c: Context, tenant: TenantInfo) => {
    const url = new URL(c.req.url);
    return c.redirect(`/t/${tenant.slug}/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  };
  const tenantOr404 = (c: Context) => getTenant(c.req.param("tenant"));

  app.post("/api/t/:tenant/invite/:code/start", async (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return c.json({ error: "unknown_tenant" }, 404);
    const code = (c.req.param("code") ?? "").toUpperCase();
    await ctx.delay();
    if (!isValidInviteCode(tenant, code)) return c.json({ error: "invalid_invite" }, 400);
    const session = ctx.session(c) ?? ctx.createSession({ username: `invite:${code}` });
    session.invites[tenant.slug] = code;
    ctx.setSessionCookie(c, session);
    return c.json({ ok: true, next: `/t/${tenant.slug}/register/company` });
  });

  app.post("/api/t/:tenant/suppliers", async (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return c.json({ error: "unknown_tenant" }, 404);
    const eff = ctx.effective(c);
    const session = eff.session;
    if (!session) return c.json({ error: "unauthorized" }, 401);
    const parsed = await parseSubmit(c);
    if (!parsed) {
      return c.json(
        { error: "invalid_body", message: "Send multipart form-data with a JSON 'payload' part." },
        400,
      );
    }
    const metas: Record<string, FileMeta> = {};
    for (const [key, file] of Object.entries(parsed.files)) {
      metas[key] = { name: file.name, size: file.size, type: file.type };
    }
    const sections = supplierSections(tenant.slug, ctx.mutatorFor(eff));
    const { fields, errors } = validateSections(sections, parsed.payload, {
      today: ctx.today(),
      files: metas,
    });
    await ctx.delay();
    if (Object.keys(errors).length > 0)
      return c.json({ error: "validation_failed", fieldErrors: errors }, 400);

    const files: SubmittedFile[] = [];
    for (const [key, file] of Object.entries(parsed.files)) {
      const bytes = Buffer.from(await file.arrayBuffer());
      files.push({
        field: key,
        filename: file.name,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    const record = store.create(
      tenant,
      String(fields.legalName),
      String(fields.primaryContactEmail),
      eff.runId,
    );
    const inviteCode = session.invites[tenant.slug];
    ctx.record({
      id: record.id,
      portal: "supplier",
      runId: eff.runId,
      tenant: tenant.slug,
      ...(inviteCode ? { inviteCode } : {}),
      version: eff.version,
      mutation: ctx.resolvedMutationFor(eff),
      fields,
      files,
      createdAt: record.submittedAt,
    });
    return c.json(record, 201);
  });

  app.get("/api/t/:tenant/suppliers/:id", (c) => {
    if (!ctx.session(c)) return c.json({ error: "unauthorized" }, 401);
    const record = store.get(c.req.param("tenant"), c.req.param("id"));
    return record ? c.json(record) : c.json({ error: "not_found" }, 404);
  });

  // Pages
  app.get("/", (c) => ctx.html(c));
  app.get("/t/:tenant", (c) => {
    const tenant = tenantOr404(c);
    return tenant
      ? c.redirect(`/t/${tenant.slug}/login`, 302)
      : ctx.html(c, { status: 404, data: { notFound: true } });
  });
  app.get("/t/:tenant/invite/:code", (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return ctx.html(c, { status: 404, data: { notFound: true } });
    const code = c.req.param("code");
    return ctx.html(c, {
      data: { inviteCode: code.toUpperCase(), inviteValid: isValidInviteCode(tenant, code) },
    });
  });
  app.get("/t/:tenant/login", (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return ctx.html(c, { status: 404, data: { notFound: true } });
    const next = c.req.query("next");
    if (ctx.session(c)) {
      const fallback = `/t/${tenant.slug}/register/company`;
      return c.redirect(next?.startsWith("/") && !next.startsWith("//") ? next : fallback, 302);
    }
    return ctx.html(c);
  });
  app.get("/t/:tenant/register", (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return ctx.html(c, { status: 404, data: { notFound: true } });
    return c.redirect(`/t/${tenant.slug}/register/company`, 302);
  });
  app.get("/t/:tenant/register/complete/:id", (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return ctx.html(c, { status: 404, data: { notFound: true } });
    if (!ctx.session(c)) return loginRedirect(c, tenant);
    const record = store.get(tenant.slug, c.req.param("id"));
    return record
      ? ctx.html(c, { data: { supplier: record } })
      : ctx.html(c, { status: 404, data: { notFound: true } });
  });
  app.get("/t/:tenant/register/:step", (c) => {
    const tenant = tenantOr404(c);
    if (!tenant) return ctx.html(c, { status: 404, data: { notFound: true } });
    const session = ctx.session(c);
    if (!session) return loginRedirect(c, tenant);
    return ctx.html(c, { data: { inviteCode: session.invites[tenant.slug] ?? null } });
  });
}

export function startSupplierPortal(opts: StartOptions = {}): Promise<PortalHandle> {
  return startPortal(
    {
      portal: "supplier",
      title: "Supplier Portal",
      themeColor: "#1f2937",
      cookiePrefix: "sg_session",
      singleVersion: true,
      mount: mountSupplier,
    },
    opts,
  );
}

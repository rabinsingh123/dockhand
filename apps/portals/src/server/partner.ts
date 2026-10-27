// Caravela Partner Hub server: deal registration API + protected SPA routes.

import { randomInt } from "node:crypto";
import type { Context, Hono } from "hono";
import { PARTNER_PORTAL_NAME, PARTNER_REG_ID_PREFIX, partnerSections } from "../shared/partnerSchema.ts";
import type { DealRecord, DealStatus, FieldValue } from "../shared/types.ts";
import { addDaysIso, localIsoDate, validateSections } from "../shared/validate.ts";
import {
  isRecord,
  type PortalContext,
  type PortalHandle,
  readJson,
  type StartOptions,
  startPortal,
} from "./core.ts";

/** Same company + product within this window returns the existing registration (idempotency). */
export const DUPLICATE_WINDOW_MS = 60_000;

interface SeedRow {
  id: string;
  status: DealStatus;
  daysAgo: number;
  closeInDays: number;
  fields: Record<string, FieldValue>;
}

// Fictional demo rows for the registrations list. Not part of submissions().
const SEED_ROWS: SeedRow[] = [
  {
    id: "NW-REG-46288",
    status: "Pending review",
    daysAgo: 2,
    closeInDays: 45,
    fields: {
      companyName: "Mariposa Salud S.A. de C.V.",
      country: "Mexico",
      city: "Guadalajara",
      contactName: "Lucía Herrera",
      contactEmail: "lucia.herrera@mariposa-salud.example",
      product: "Tidewater Cloud Enterprise",
      seats: 300,
      estimatedValue: 264000,
    },
  },
  {
    id: "NW-REG-45021",
    status: "Approved",
    daysAgo: 9,
    closeInDays: 21,
    fields: {
      companyName: "Lumbung Agro Nusantara",
      country: "Indonesia",
      city: "Surabaya",
      contactName: "Dewi Kartika",
      contactEmail: "dewi.kartika@lumbung-agro.example",
      product: "Tidewater Cloud Business",
      seats: 60,
      estimatedValue: 43200,
    },
  },
  {
    id: "NW-REG-44105",
    status: "Declined",
    daysAgo: 16,
    closeInDays: 12,
    fields: {
      companyName: "Pacífico Retail Group",
      country: "Peru",
      city: "Lima",
      contactName: "Andrés Quispe",
      contactEmail: "andres.quispe@pacifico-retail.example",
      product: "Tidewater Cloud Business",
      seats: 80,
      estimatedValue: 57600,
    },
  },
  {
    id: "NW-REG-43592",
    status: "Approved",
    daysAgo: 23,
    closeInDays: 30,
    fields: {
      companyName: "Kaveri Looms Pvt. Ltd.",
      country: "India",
      city: "Coimbatore",
      contactName: "Priya Raman",
      contactEmail: "priya.raman@kaveri-looms.example",
      product: "Tidewater Cloud Starter",
      seats: 35,
      estimatedValue: 12600,
    },
  },
  {
    id: "NW-REG-42310",
    status: "Approved",
    daysAgo: 41,
    closeInDays: -4,
    fields: {
      companyName: "Ipê Alimentos Ltda.",
      country: "Brazil",
      city: "Campinas",
      contactName: "Rafael Moreira",
      contactEmail: "rafael.moreira@ipe-alimentos.example",
      product: "Tidewater Cloud Enterprise",
      seats: 450,
      estimatedValue: 412000,
    },
  },
  {
    id: "NW-REG-41877",
    status: "Expired",
    daysAgo: 96,
    closeInDays: -30,
    fields: {
      companyName: "Cordillera Cargo SpA",
      country: "Chile",
      city: "Santiago",
      contactName: "Tomás Fuentes",
      contactEmail: "tomas.fuentes@cordillera-cargo.example",
      product: "Tidewater Cloud Business",
      seats: 120,
      estimatedValue: 86400,
    },
  },
];

interface CreatedDeal {
  deal: DealRecord;
  /** Idempotency scope (runId or session token). */
  scope: string;
  runId: string | null;
}

class DealStore {
  private created: CreatedDeal[] = [];
  private readonly seeded: DealRecord[];
  private nextNumber = 48213;

  constructor() {
    const today = localIsoDate();
    const now = Date.now();
    this.seeded = SEED_ROWS.map((row) => ({
      id: row.id,
      status: row.status,
      seeded: true,
      submittedAt: new Date(now - row.daysAgo * 86_400_000).toISOString(),
      fields: { ...row.fields, expectedCloseDate: addDaysIso(today, row.closeInDays), consent: true },
    }));
  }

  list(): DealRecord[] {
    return this.created
      .map((c) => c.deal)
      .reverse()
      .concat(this.seeded);
  }

  get(id: string): DealRecord | undefined {
    const key = id.toUpperCase();
    return this.created.find((c) => c.deal.id === key)?.deal ?? this.seeded.find((d) => d.id === key);
  }

  /** Same scope (run or session) + same company + same product within the window. */
  findRecentDuplicate(scope: string, company: string, product: string, now: number): DealRecord | undefined {
    const name = company.trim().toLowerCase();
    for (let i = this.created.length - 1; i >= 0; i--) {
      const c = this.created[i];
      if (!c) continue;
      if (now - Date.parse(c.deal.submittedAt) > DUPLICATE_WINDOW_MS) break;
      const d = c.deal;
      if (
        c.scope === scope &&
        String(d.fields.companyName).toLowerCase() === name &&
        d.fields.product === product
      ) {
        return d;
      }
    }
    return undefined;
  }

  create(fields: Record<string, FieldValue>, scope: string, runId: string | null): DealRecord {
    let id: string;
    do {
      id = `${PARTNER_REG_ID_PREFIX}${this.nextNumber}`;
      this.nextNumber += 1 + randomInt(0, 9);
      if (this.nextNumber > 99999) this.nextNumber = 10000 + randomInt(0, 1000);
    } while (this.get(id));
    const deal: DealRecord = {
      id,
      status: "Pending review",
      seeded: false,
      submittedAt: new Date().toISOString(),
      fields,
    };
    this.created.push({ deal, scope, runId });
    return deal;
  }

  reset(runId?: string): void {
    this.created = runId === undefined ? [] : this.created.filter((c) => c.runId !== runId);
  }
}

function safeNext(next: string | undefined, fallback: string): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

function mountPartner(app: Hono, ctx: PortalContext): void {
  const store = new DealStore();
  ctx.onReset((runId) => store.reset(runId));

  const loginRedirect = (c: Context) => {
    const url = new URL(c.req.url);
    return c.redirect(`/login?next=${encodeURIComponent(url.pathname + url.search)}`, 302);
  };

  app.get("/api/deals", (c) => {
    if (!ctx.session(c)) return c.json({ error: "unauthorized" }, 401);
    return c.json({ deals: store.list() });
  });

  app.get("/api/deals/:id", (c) => {
    if (!ctx.session(c)) return c.json({ error: "unauthorized" }, 401);
    const deal = store.get(c.req.param("id"));
    return deal ? c.json(deal) : c.json({ error: "not_found" }, 404);
  });

  app.post("/api/deals", async (c) => {
    if (!ctx.session(c)) return c.json({ error: "unauthorized" }, 401);
    const body = await readJson(c);
    if (!isRecord(body)) {
      return c.json(
        { error: "invalid_body", message: "Send a JSON object keyed by canonical field names." },
        400,
      );
    }
    // Validate against exactly what this context rendered (its ui + mutation).
    const eff = ctx.effective(c);
    const sections = partnerSections(eff.version, ctx.mutatorFor(eff));
    const { fields, errors } = validateSections(sections, body, { today: ctx.today() });
    await ctx.delay();
    if (Object.keys(errors).length > 0)
      return c.json({ error: "validation_failed", fieldErrors: errors }, 400);

    const duplicate = store.findRecentDuplicate(
      eff.scope,
      String(fields.companyName),
      String(fields.product),
      Date.now(),
    );
    if (duplicate) return c.json({ ...duplicate, duplicate: true }, 200);

    const deal = store.create(fields, eff.scope, eff.runId);
    ctx.record({
      id: deal.id,
      portal: "partner",
      runId: eff.runId,
      version: eff.version,
      mutation: ctx.resolvedMutationFor(eff),
      fields,
      createdAt: deal.submittedAt,
    });
    return c.json(deal, 201);
  });

  app.get("/", (c) => c.redirect(ctx.session(c) ? "/deals" : "/login", 302));
  app.get("/login", (c) => {
    if (ctx.session(c)) return c.redirect(safeNext(c.req.query("next"), "/deals"), 302);
    return ctx.html(c);
  });
  app.get("/deals", (c) =>
    ctx.session(c) ? ctx.html(c, { data: { deals: store.list() } }) : loginRedirect(c),
  );
  app.get("/deals/new", (c) => (ctx.session(c) ? ctx.html(c) : loginRedirect(c)));
  app.get("/deals/:id", (c) => {
    if (!ctx.session(c)) return loginRedirect(c);
    const deal = store.get(c.req.param("id"));
    return deal ? ctx.html(c, { data: { deal } }) : ctx.html(c, { status: 404, data: { notFound: true } });
  });
}

export function startPartnerPortal(opts: StartOptions = {}): Promise<PortalHandle> {
  return startPortal(
    {
      portal: "partner",
      title: PARTNER_PORTAL_NAME,
      themeColor: "#0b3048",
      cookiePrefix: "nw_session",
      mount: mountPartner,
    },
    opts,
  );
}

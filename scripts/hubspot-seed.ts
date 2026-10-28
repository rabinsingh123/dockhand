// `pnpm hubspot:seed`: fills the HubSpot test account with fictional Brazilian companies and a pipeline of
// deals, so the CRM looks lived-in on camera, and proves the quote path end to end with Dockhand's own client
// (PDF upload + note on a deal). Idempotent: companies and deals are matched by name and created only when
// missing. Café Aurora gets a company record but no deal: the demo's quote flow finds it and creates the deal.
// Amounts come from the same price book as the quotes. Synthetic data only.

import { createMemoryArtifactStore, loadConfig, openDb, systemClock } from "../packages/core/src/index.ts";
import {
  createHubSpotCrm,
  createQuoteService,
  createRepos,
  idemKey,
  priceQuote,
} from "../packages/orchestrator/src/index.ts";

const COMPANIES = [
  { name: "Café Aurora", domain: "cafeaurora.example", city: "São Paulo", state: "SP", employees: 40 },
  {
    name: "Vila Nova Logística",
    domain: "vilanovalog.example",
    city: "Curitiba",
    state: "PR",
    employees: 180,
  },
  {
    name: "Padaria Estrela do Sul",
    domain: "estreladosul.example",
    city: "Porto Alegre",
    state: "RS",
    employees: 25,
  },
  {
    name: "Grupo Horizonte Têxtil",
    domain: "horizontetextil.example",
    city: "Blumenau",
    state: "SC",
    employees: 320,
  },
  {
    name: "Clínica Bem Viver",
    domain: "bemviver.example",
    city: "Belo Horizonte",
    state: "MG",
    employees: 60,
  },
  {
    name: "Mercado Pinheiros",
    domain: "mercadopinheiros.example",
    city: "São Paulo",
    state: "SP",
    employees: 90,
  },
  { name: "Construtora Atlântica", domain: "atlantica.example", city: "Recife", state: "PE", employees: 210 },
  {
    name: "Escola Nova Geração",
    domain: "novageracao.example",
    city: "Campinas",
    state: "SP",
    employees: 75,
  },
  {
    name: "Transportes Serra Azul",
    domain: "serraazul.example",
    city: "Goiânia",
    state: "GO",
    employees: 140,
  },
  {
    name: "Agência Maré Digital",
    domain: "maredigital.example",
    city: "Florianópolis",
    state: "SC",
    employees: 18,
  },
  { name: "Hotel Brisa do Mar", domain: "brisadomar.example", city: "Salvador", state: "BA", employees: 55 },
] as const;

type Plan = "starter" | "business" | "enterprise";
const DEALS: { company: string; seats: number; plan: Plan; stage: string; close: string }[] = [
  {
    company: "Vila Nova Logística",
    seats: 40,
    plan: "business",
    stage: "presentationscheduled",
    close: "2027-01-15",
  },
  {
    company: "Padaria Estrela do Sul",
    seats: 10,
    plan: "starter",
    stage: "appointmentscheduled",
    close: "2026-12-10",
  },
  {
    company: "Grupo Horizonte Têxtil",
    seats: 120,
    plan: "enterprise",
    stage: "decisionmakerboughtin",
    close: "2026-12-18",
  },
  { company: "Clínica Bem Viver", seats: 30, plan: "business", stage: "qualifiedtobuy", close: "2027-02-05" },
  { company: "Mercado Pinheiros", seats: 45, plan: "business", stage: "contractsent", close: "2026-11-27" },
  {
    company: "Construtora Atlântica",
    seats: 80,
    plan: "enterprise",
    stage: "qualifiedtobuy",
    close: "2027-03-01",
  },
  { company: "Escola Nova Geração", seats: 35, plan: "starter", stage: "closedwon", close: "2026-10-20" },
  {
    company: "Transportes Serra Azul",
    seats: 60,
    plan: "business",
    stage: "presentationscheduled",
    close: "2027-01-29",
  },
  { company: "Agência Maré Digital", seats: 12, plan: "starter", stage: "closedlost", close: "2026-10-05" },
  {
    company: "Hotel Brisa do Mar",
    seats: 25,
    plan: "business",
    stage: "appointmentscheduled",
    close: "2027-02-20",
  },
];
/** The seeded deal that gets a real quote PDF attached through Dockhand's HubSpot client. */
const QUOTED = "Mercado Pinheiros";
const PLAN_LABEL: Record<Plan, string> = {
  starter: "Starter",
  business: "Business",
  enterprise: "Enterprise",
};

const config = loadConfig();
const token: string =
  config.crm.hubspotToken ??
  (() => {
    throw new Error("Set HUBSPOT_TOKEN in .env");
  })();
const API = "https://api.hubapi.com";
const pause = () => new Promise((r) => setTimeout(r, 250)); // search is limited to 5 requests per second

async function hs(method: string, path: string, json?: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HubSpot ${method} ${path} answered ${res.status}: ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function findId(
  object: "companies" | "deals",
  property: string,
  value: string,
): Promise<string | undefined> {
  await pause();
  const found = await hs("POST", `/crm/v3/objects/${object}/search`, {
    filterGroups: [{ filters: [{ propertyName: property, operator: "EQ", value }] }],
    limit: 1,
  });
  return (found.results as { id: string }[] | undefined)?.[0]?.id;
}

async function main(): Promise<void> {
  const companyIds = new Map<string, string>();
  let createdCompanies = 0;
  for (const c of COMPANIES) {
    let id = await findId("companies", "name", c.name);
    if (!id) {
      const res = await hs("POST", "/crm/v3/objects/companies", {
        properties: {
          name: c.name,
          domain: c.domain,
          city: c.city,
          state: c.state,
          country: "Brazil",
          numberofemployees: String(c.employees),
        },
      });
      id = String(res.id);
      createdCompanies++;
    }
    companyIds.set(c.name, id);
  }

  const today = new Date().toISOString().slice(0, 10);
  const newDeals = new Map<string, string>();
  for (const d of DEALS) {
    const company = COMPANIES.find((c) => c.name === d.company);
    const companyId = companyIds.get(d.company);
    if (!company || !companyId) throw new Error(`unknown company ${d.company}`);
    const name = `${d.company} · ${d.seats} seats · ${PLAN_LABEL[d.plan]}`;
    if (await findId("deals", "dealname", name)) continue;
    const quote = priceQuote(
      {
        company: d.company,
        city: company.city,
        country: "Brazil",
        seats: d.seats,
        startDate: d.close,
        currency: "BRL",
        language: "pt-BR",
        plan: d.plan,
      },
      today,
    );
    const res = await hs("POST", "/crm/v3/objects/deals", {
      properties: {
        dealname: name,
        amount: (quote.totalMinor / 100).toFixed(2),
        closedate: `${d.close}T12:00:00.000Z`,
        pipeline: config.crm.pipeline ?? "default",
        dealstage: d.stage,
      },
      associations: [
        { to: { id: companyId }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 5 }] },
      ],
    });
    newDeals.set(d.company, String(res.id));
  }

  // The quote path, through Dockhand's own client: render the PDF, upload it, note it on the deal.
  let quoteNote = "already seeded";
  const quotedDealId = newDeals.get(QUOTED);
  if (quotedDealId) {
    const db = openDb(":memory:");
    const artifacts = createMemoryArtifactStore(systemClock);
    const quotes = createQuoteService({ artifacts, clock: systemClock });
    const seed = DEALS.find((d) => d.company === QUOTED);
    const company = COMPANIES.find((c) => c.name === QUOTED);
    if (!seed || !company) throw new Error(`${QUOTED} is not in the seed`);
    const request = {
      company: QUOTED,
      city: company.city,
      country: "Brazil",
      seats: seed.seats,
      startDate: seed.close,
      currency: "BRL" as const,
      language: "pt-BR" as const,
    };
    const quote = quotes.price(request);
    const file = await quotes.renderPdf(quote, request);
    const crm = createHubSpotCrm({ token, db, artifacts, clock: systemClock, lookupAccount: true });
    const jobId = createRepos(db, systemClock).jobs.create("seed").id;
    const note = await crm.attachFileNote(
      {
        dealId: quotedDealId,
        file,
        filename: `${quote.number}.pdf`,
        body: `Proposta ${quote.number} enviada: ${seed.seats} seats, Tidewater Cloud ${PLAN_LABEL[seed.plan]}.`,
      },
      idemKey(jobId, 0),
    );
    quoteNote = `note ${note.noteId} with ${quote.number}.pdf on deal ${quotedDealId}`;
    db.close();
  }

  process.stdout.write(
    `Companies: ${COMPANIES.length} (${createdCompanies} created)\n` +
      `Deals: ${DEALS.length} (${newDeals.size} created)\n` +
      `Quote path: ${quoteNote}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

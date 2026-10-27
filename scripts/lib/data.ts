// Every synthetic value used by the fixtures, in one place. The generators, the .expected.json ground
// truth and the teach recording all read from here, so a value can never drift between an asset and
// its expected output. All companies, people, IDs and numbers are fictional.

import { TENANTS, type TenantSlug } from "../../apps/portals/src/index.ts";
import type {
  CompanyProfile,
  RepProfile,
  Understanding,
} from "../../packages/core/src/contracts/orchestrator.ts";

/** Default ports from `tsx apps/portals/src/cli.ts both`. */
export const PARTNER_PORTAL_URL = "http://localhost:5101";
export const SUPPLIER_PORTAL_URL = "http://localhost:5102";

export const REP: RepProfile = {
  phone: "5511999990001",
  name: "Ana Ribeiro",
  tz: "America/Sao_Paulo",
  locale: "pt-BR",
  languageBias: ["Portuguese", "English"],
};

/**
 * Tidewater Cloud's supplier-onboarding profile, keyed by the supplier portal's canonical field keys
 * (SUPPLIER_FIELDS). Values are strings in the format the portal accepts; checkboxes are "true"/"false";
 * files are workspace-relative paths. Left out on purpose: dunsNumber (optional, Globex only; any
 * 9-digit D-U-N-S could belong to a real company), the remit-to block (remitSameAsAddress is "true")
 * and the mutation-only fields (supplierCategory, naicsCode, linkedinUrl) so "new required field"
 * heals still have to ask the rep.
 */
export const TIDEWATER_PROFILE: CompanyProfile = {
  legalName: "Tidewater Cloud Ltda.",
  tradeName: "Tidewater Cloud",
  // EIN-shaped; the prefix 00 is never issued by the IRS.
  taxId: "00-1234567",
  countryOfIncorporation: "Brazil",
  stateOfIncorporation: "São Paulo",
  yearFounded: "2019",
  website: "https://tidewater.example.com",
  employees: "51-200",
  annualRevenue: "$10M-$50M",
  entityType: "LLC",
  street1: "Rua das Marés, 420",
  street2: "Conjunto 81, 8º andar",
  city: "São Paulo",
  state: "SP",
  postalCode: "04571-010",
  country: "Brazil",
  remitSameAsAddress: "true",
  primaryContactName: "Ana Ribeiro",
  primaryContactTitle: "Senior Account Executive",
  primaryContactEmail: "ana.ribeiro@example.com",
  primaryContactPhone: "+55 11 99999-0001",
  arContactName: "Carla Mendes",
  arContactEmail: "contas.receber@example.com",
  arContactPhone: "+55 11 99999-0002",
  salesContactName: "Bruno Azevedo",
  salesContactEmail: "bruno.azevedo@example.com",
  bankName: "Banco Exemplo S.A.",
  accountHolder: "TIDEWATER CLOUD LTDA",
  accountNumber: "000123456",
  // Fails the ABA checksum, so it can never be a real routing number.
  routingNumber: "999999999",
  // "0" as the second location character marks a test BIC (ISO 9362).
  swiftBic: "EXMPBRS0",
  currency: "BRL",
  bankConfirm: "true",
  w9File: "fixtures/docs/w9-sample.pdf",
  coiFile: "fixtures/docs/insurance-certificate-sample.pdf",
  diversity: "None of these",
  conflictOfInterest: "No",
  codeOfConduct: "true",
  signatoryName: "Renata Figueiredo",
  signatoryTitle: "Chief Financial Officer",
};

export function profileValue(key: string): string {
  const v = TIDEWATER_PROFILE[key];
  if (v === undefined) throw new Error(`profile has no ${key}`);
  return v;
}

export const W9_DETAILS = {
  /** US form, so US date order. */
  signedOn: "10/20/2026",
  llcTaxClassification: "C",
};

export const COI_DETAILS = {
  insurer: "Harbor Mutual (fictional)",
  insurerAddress: "Avenida do Porto Fictício, 77 · Rio de Janeiro – RJ · Brazil",
  insurerContact: "certificates@harbor-mutual.example",
  certificateNumber: "SAMPLE-COI-2026-0042",
  issuedOn: "20 Oct 2026",
  periodFrom: "01 Jan 2026",
  periodTo: "01 Jan 2027",
  holder: "To whom it may concern (supplier onboarding)",
  representative: { name: "Daniel Prates", title: "Underwriting Officer" },
  operations:
    "Cloud software subscriptions (Tidewater Cloud Starter, Business and Enterprise) and related implementation and support services.",
  policies: [
    {
      coverage: "Commercial general liability (occurrence)",
      policy: "SAMPLE-GL-0001",
      limits: [
        ["Each occurrence", "USD 1,000,000"],
        ["General aggregate", "USD 2,000,000"],
        ["Products / completed operations", "USD 2,000,000"],
      ],
    },
    {
      coverage: "Technology errors and omissions",
      policy: "SAMPLE-EO-0002",
      limits: [
        ["Each claim", "USD 2,000,000"],
        ["Aggregate", "USD 2,000,000"],
      ],
    },
    {
      coverage: "Cyber and privacy liability",
      policy: "SAMPLE-CY-0003",
      limits: [
        ["Each claim", "USD 1,000,000"],
        ["Aggregate", "USD 1,000,000"],
      ],
    },
    {
      coverage: "Umbrella liability",
      policy: "SAMPLE-UM-0004",
      limits: [["Each occurrence and aggregate", "USD 5,000,000"]],
    },
  ],
} as const;

// ---------------------------------------------------------------------------------------------
// Understanding helper: every field present, unknowns null (the contract's strict-output shape).

type UnderstandingInput = Pick<Understanding, "intent" | "language" | "summaryForRep"> &
  Partial<Understanding>;

export function understanding(u: UnderstandingInput): Understanding {
  return {
    intent: u.intent,
    language: u.language,
    company: u.company ?? null,
    city: u.city ?? null,
    country: u.country ?? null,
    seats: u.seats ?? null,
    startDate: u.startDate ?? null,
    contactName: u.contactName ?? null,
    contactEmail: u.contactEmail ?? null,
    contactPhone: u.contactPhone ?? null,
    product: u.product ?? null,
    estValue: u.estValue ?? null,
    closeDate: u.closeDate ?? null,
    website: u.website ?? null,
    referralPartner: u.referralPartner ?? null,
    notes: u.notes ?? null,
    portalUrl: u.portalUrl ?? null,
    tenant: u.tenant ?? null,
    inviteCode: u.inviteCode ?? null,
    buyerName: u.buyerName ?? null,
    missing: u.missing ?? [],
    summaryForRep: u.summaryForRep,
  };
}

// ---------------------------------------------------------------------------------------------
// Referral forms (photos of signed paper forms, flow 2)

export interface ReferralFixture {
  slug: string;
  partnerCompany: string;
  partnerContact: string;
  companyName: string;
  companyWebsite: string;
  city: string;
  /** As handwritten (Portuguese); the portal option is "Brazil". */
  country: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  product: "Tidewater Cloud Starter" | "Tidewater Cloud Business" | "Tidewater Cloud Enterprise";
  seats: number;
  estimatedValueBrl: number;
  /** DD/MM/YYYY as written. */
  expectedCloseDate: string;
  notes: string;
  signedOn: string;
  look: {
    font: string;
    ink: string;
    seed: number;
    scene: "warm-lamp" | "daylight";
  };
}

export const REFERRALS: readonly ReferralFixture[] = [
  {
    slug: "cafe-aurora",
    partnerCompany: "Rota Consultoria",
    partnerContact: "Marcos Tavares",
    companyName: "Café Aurora Ltda.",
    companyWebsite: "cafeaurora.example",
    city: "São Paulo",
    country: "Brasil",
    contactName: "Júlia Prado",
    contactEmail: "julia@cafeaurora.example",
    contactPhone: "+55 11 99999-0142",
    product: "Tidewater Cloud Business",
    seats: 25,
    estimatedValueBrl: 90000,
    expectedCloseDate: "29/01/2027",
    notes: "6 lojas. Decisão dos sócios em janeiro.",
    signedOn: "26/10/2026",
    look: { font: '"Segoe Print"', ink: "#1d3a8f", seed: 1729, scene: "warm-lamp" },
  },
  {
    slug: "vila-nova",
    partnerCompany: "Rota Consultoria",
    partnerContact: "Marcos Tavares",
    companyName: "Vila Nova Logística Ltda.",
    companyWebsite: "vilanovalog.example",
    city: "Curitiba",
    country: "Brasil",
    contactName: "Helena Kowalski",
    contactEmail: "helena@vilanovalog.example",
    contactPhone: "+55 41 99999-0187",
    product: "Tidewater Cloud Business",
    seats: 40,
    estimatedValueBrl: 144000,
    expectedCloseDate: "26/02/2027",
    notes: "3 centros de distribuição. Integração com ERP.",
    signedOn: "23/10/2026",
    look: { font: '"Ink Free"', ink: "#22252c", seed: 4242, scene: "daylight" },
  },
];

// ---------------------------------------------------------------------------------------------
// Supplier invitation letters (PDF, flow 3)

export interface InvitationFixture {
  tenant: TenantSlug;
  language: "en" | "pt";
  reference: string;
  /** DD/MM/YYYY as written. */
  deadline: string;
  place: string;
  dateLine: string;
  letterheadLine: string;
  signer: { name: string; title: string };
  documents: string[];
}

export const INVITATIONS: readonly InvitationFixture[] = [
  {
    tenant: "acme",
    language: "en",
    reference: "ACME-SUP-2026-0458",
    deadline: "15/11/2026",
    place: "Barueri",
    dateLine: "Barueri, 20 October 2026",
    letterheadLine: "Alameda das Indústrias Fictícias, 900 · Barueri – SP · Brazil",
    signer: { name: "Laura Bennett", title: "Supplier Onboarding Lead, Acme Group Procurement" },
    documents: ["W-9 form", "Certificate of insurance"],
  },
  {
    tenant: "globex",
    language: "pt",
    reference: "GLX-SS-2026-1187",
    deadline: "30/11/2026",
    place: "Campinas",
    dateLine: "Campinas, 22 de outubro de 2026",
    letterheadLine: "Rodovia Fictícia, km 12 · Campinas – SP · Brasil",
    signer: { name: "Rodrigo Valente", title: "Analista de Strategic Sourcing, Globex Industrial" },
    documents: ["Formulário W-9", "Certificado de seguro"],
  },
];

export function inviteUrl(inv: InvitationFixture): string {
  const t = TENANTS[inv.tenant];
  return `${SUPPLIER_PORTAL_URL}/t/${t.slug}/invite/${t.sampleInviteCode}`;
}

// ---------------------------------------------------------------------------------------------
// Teach recording (a DIFFERENT deal than the referral photos, so values seen in the video can be
// told apart from the values of a real run).

export const TEACH_DEAL = {
  companyName: "Padaria Estrela Ltda.",
  companyWebsite: "padariaestrela.example",
  /** Typed into the Country combobox to filter before picking the option. */
  countryQuery: "Bra",
  country: "Brazil",
  city: "Belo Horizonte",
  contactName: "Beatriz Nogueira",
  contactEmail: "beatriz@padariaestrela.example",
  contactPhone: "+55 31 99999-0123",
  product: "Tidewater Cloud Starter",
  seats: "12",
  estimatedValueUsd: "4320",
  /** Must stay in the future: the portal rejects past close dates. */
  expectedCloseDate: "12/03/2027",
  referralPartner: "Ponte Digital Consultoria",
  notes: "Piloto em 3 lojas",
} as const;

export const TEACH_USERNAME = "ana.ribeiro";

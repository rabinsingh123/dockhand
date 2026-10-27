// "Caravela Partner Hub": a fictional Brazilian distributor's partner portal.
// Internal identifiers (nw- testids, NW-REG- ids, nw_session) predate the rename and are kept on
// purpose: they are part of the contract other packages were written against.

import type { FieldDef, SectionDef } from "./fields.ts";
import { type Mutator, mutateSections } from "./mutations.ts";
import type { PortalVersion } from "./types.ts";

export const PARTNER_BRAND = "Caravela";
export const PARTNER_PORTAL_NAME = "Caravela Partner Hub";
/** Registration ids look like NW-REG-48213. */
export const PARTNER_REG_ID_PREFIX = "NW-REG-";
export const PARTNER_REG_ID_RE = /NW-REG-\d{5}/;
/** The partner organization the signed-in user belongs to (our fictional company). */
export const PARTNER_ORG = "Tidewater Cloud";

export const PARTNER_COUNTRIES = [
  "Argentina",
  "Brazil",
  "Chile",
  "Colombia",
  "India",
  "Indonesia",
  "Mexico",
  "Peru",
  "Philippines",
  "Portugal",
  "Spain",
  "United States",
  "Vietnam",
] as const;

export const PARTNER_PRODUCTS = [
  "Tidewater Cloud Starter",
  "Tidewater Cloud Business",
  "Tidewater Cloud Enterprise",
] as const;

export const PARTNER_TIERS = ["Gold", "Silver", "Bronze"] as const;

export type PartnerFieldKey =
  | "companyName"
  | "companyWebsite"
  | "country"
  | "city"
  | "contactName"
  | "contactEmail"
  | "contactPhone"
  | "product"
  | "seats"
  | "estimatedValue"
  | "expectedCloseDate"
  | "referralPartner"
  | "notes"
  | "consent";

type BaseField = Omit<FieldDef, "key" | "testid" | "domId">;

const BASE: Record<PartnerFieldKey, BaseField> = {
  companyName: {
    kind: "text",
    label: "End customer company",
    required: true,
    maxLength: 120,
    placeholder: "e.g. Sabiá Foods Ltda.",
    synonyms: ["Customer account name", "Customer company name", "End-user organization"],
    altPlaceholders: ["Legal name of the customer", "Company name as registered", "Customer organization"],
  },
  companyWebsite: {
    kind: "url",
    label: "Company website",
    placeholder: "e.g. sabiafoods.com.br",
    synonyms: ["Customer website", "Website URL", "Company URL"],
    altPlaceholders: ["https://", "www.example.com", "Customer domain"],
  },
  country: {
    kind: "combobox",
    label: "Country",
    required: true,
    options: PARTNER_COUNTRIES,
    placeholder: "Select a country",
    synonyms: ["Country / region", "Customer country", "Country of operation"],
    altPlaceholders: ["Choose country", "Search countries", "Pick a country"],
  },
  city: {
    kind: "text",
    label: "City",
    required: true,
    maxLength: 80,
    placeholder: "e.g. São Paulo",
    synonyms: ["Town / city", "Customer city", "City / municipality"],
    altPlaceholders: ["City name", "e.g. Bogotá", "Customer city"],
  },
  contactName: {
    kind: "text",
    label: "Contact full name",
    required: true,
    maxLength: 120,
    placeholder: "e.g. Mariana Costa",
    synonyms: ["Contact name", "Primary contact", "Customer contact name"],
    altPlaceholders: ["First and last name", "Full name", "e.g. Ravi Menon"],
  },
  contactEmail: {
    kind: "email",
    label: "Contact email",
    required: true,
    maxLength: 160,
    placeholder: "name@company.com",
    inputMode: "email",
    synonyms: ["Email address", "Contact e-mail", "Business email"],
    altPlaceholders: ["email@customer.com", "Work email", "you@example.com"],
  },
  contactPhone: {
    kind: "tel",
    label: "Contact phone",
    placeholder: "+55 11 91234 5678",
    inputMode: "tel",
    synonyms: ["Phone number", "Contact telephone", "Mobile / phone"],
    altPlaceholders: ["Include country code", "+1 555 010 0000", "Phone"],
  },
  product: {
    kind: "combobox",
    label: "Product",
    required: true,
    options: PARTNER_PRODUCTS,
    placeholder: "Select a product",
    synonyms: ["Offering", "Product line", "Plan"],
    altPlaceholders: ["Choose a plan", "Search products", "Pick one"],
  },
  seats: {
    kind: "integer",
    label: "Seats",
    required: true,
    min: 1,
    max: 100000,
    placeholder: "e.g. 25",
    inputMode: "numeric",
    synonyms: ["Number of users", "Licenses", "Seat count"],
    altPlaceholders: ["Number of seats", "Users", "e.g. 100"],
  },
  estimatedValue: {
    kind: "money",
    label: "Estimated value (USD)",
    placeholder: "e.g. 18000",
    inputMode: "decimal",
    synonyms: ["Deal size (USD)", "Projected revenue (USD)", "Opportunity amount (USD)"],
    altPlaceholders: ["Amount in USD", "0.00", "e.g. 50000"],
  },
  expectedCloseDate: {
    kind: "date",
    label: "Expected close date",
    required: true,
    futureDate: true,
    placeholder: "DD/MM/YYYY",
    inputMode: "numeric",
    synonyms: ["Target close date", "Anticipated close date", "Forecast close date"],
    altPlaceholders: ["dd/mm/yyyy", "Day/Month/Year", "DD/MM/YYYY (future date)"],
  },
  referralPartner: {
    kind: "text",
    label: "Referral partner",
    maxLength: 120,
    placeholder: "Partner or agent name (optional)",
    synonyms: ["Referred by", "Referring partner", "Partner referral"],
    altPlaceholders: ["Who referred this deal?", "Agent name", "Optional"],
  },
  notes: {
    kind: "textarea",
    label: "Notes",
    maxLength: 2000,
    rows: 4,
    placeholder: "Anything Caravela should know about this opportunity",
    synonyms: ["Comments", "Additional details", "Deal notes"],
    altPlaceholders: [
      "Add context for the Caravela team",
      "Optional notes",
      "Competitors, timeline, special terms",
    ],
  },
  consent: {
    kind: "checkbox",
    label: "The end customer agreed to be contacted by Caravela",
    required: true,
    requiredMessage: "Confirm that the end customer agreed to be contacted by Caravela.",
    synonyms: [
      "The customer has agreed to be contacted by Caravela",
      "End customer consents to contact from Caravela",
      "Customer agreed to Caravela contacting them",
    ],
  },
};

interface Overlay {
  testid: string;
  domId: string;
  label?: string;
  placeholder?: string;
  span?: 1 | 2;
}

const V1: Record<PartnerFieldKey, Overlay> = {
  companyName: { testid: "nw-company-name", domId: "company-name" },
  companyWebsite: { testid: "nw-company-website", domId: "company-website" },
  country: { testid: "nw-country", domId: "country" },
  city: { testid: "nw-city", domId: "city" },
  contactName: { testid: "nw-contact-name", domId: "contact-name" },
  contactEmail: { testid: "nw-contact-email", domId: "contact-email" },
  contactPhone: { testid: "nw-contact-phone", domId: "contact-phone" },
  product: { testid: "nw-product", domId: "product" },
  seats: { testid: "nw-seats", domId: "seats" },
  estimatedValue: { testid: "nw-estimated-value", domId: "estimated-value" },
  expectedCloseDate: { testid: "nw-close-date", domId: "close-date" },
  referralPartner: { testid: "nw-referral-partner", domId: "referral-partner" },
  notes: { testid: "nw-notes", domId: "notes" },
  consent: { testid: "nw-consent", domId: "consent" },
};

const V2: Record<PartnerFieldKey, Overlay> = {
  companyName: { testid: "reg-account-name", domId: "opp-account-name" },
  companyWebsite: { testid: "reg-account-website", domId: "opp-account-website" },
  country: { testid: "reg-account-country", domId: "opp-account-country" },
  city: { testid: "reg-account-city", domId: "opp-account-city" },
  contactName: { testid: "reg-contact-fullname", domId: "opp-contact-fullname" },
  contactEmail: { testid: "reg-contact-email", domId: "opp-contact-email" },
  contactPhone: { testid: "reg-contact-phone", domId: "opp-contact-phone" },
  product: {
    testid: "reg-solution",
    domId: "opp-solution",
    label: "Solution",
    placeholder: "Select a solution",
  },
  seats: { testid: "reg-seat-count", domId: "opp-seat-count" },
  estimatedValue: { testid: "reg-deal-value", domId: "opp-deal-value" },
  expectedCloseDate: { testid: "reg-close-date", domId: "opp-close-date" },
  referralPartner: { testid: "reg-referrer", domId: "opp-referrer" },
  notes: { testid: "reg-notes", domId: "opp-notes", span: 2 },
  consent: { testid: "reg-consent", domId: "opp-consent", span: 2 },
};

export function partnerTestidPrefix(version: PortalVersion): string {
  return version === "v1" ? "nw-" : "reg-";
}

function field(version: PortalVersion, key: PartnerFieldKey): FieldDef {
  const overlay = version === "v1" ? V1[key] : V2[key];
  return { key, ...BASE[key], ...overlay };
}

/** Unmutated layout for a version. v1 field order is the spec order. */
export function partnerBaseSections(version: PortalVersion): SectionDef[] {
  const f = (k: PartnerFieldKey) => field(version, k);
  if (version === "v1") {
    return [
      {
        key: "customer",
        title: "End customer",
        description: "The company buying through Caravela.",
        columns: 1,
        fields: [f("companyName"), f("companyWebsite"), f("country"), f("city")],
      },
      {
        key: "contact",
        title: "Customer contact",
        description: "Who Caravela can reach at the end customer.",
        columns: 1,
        fields: [f("contactName"), f("contactEmail"), f("contactPhone")],
      },
      {
        key: "opportunity",
        title: "Opportunity",
        columns: 1,
        fields: [f("product"), f("seats"), f("estimatedValue"), f("expectedCloseDate"), f("referralPartner")],
      },
      { key: "details", title: "Additional information", columns: 1, fields: [f("notes")] },
      { key: "consent", columns: 1, insertable: false, fields: [f("consent")] },
    ];
  }
  return [
    {
      key: "contact",
      title: "Customer contact",
      fieldset: true,
      columns: 2,
      fields: [f("contactName"), f("contactEmail"), f("contactPhone")],
    },
    {
      key: "account",
      title: "Account",
      columns: 2,
      fields: [f("companyName"), f("companyWebsite"), f("city"), f("country")],
    },
    {
      key: "opportunity",
      title: "Opportunity",
      columns: 2,
      fields: [f("product"), f("seats"), f("estimatedValue"), f("expectedCloseDate"), f("referralPartner")],
    },
    { key: "notes", columns: 2, insertable: false, fields: [f("notes")] },
    { key: "consent", columns: 2, insertable: false, fields: [f("consent")] },
  ];
}

function optionalCandidates(version: PortalVersion): FieldDef[] {
  const p = partnerTestidPrefix(version);
  return [
    {
      key: "campaignCode",
      kind: "text",
      label: "Campaign code",
      placeholder: "e.g. CV-Q4-ACCEL",
      maxLength: 40,
      testid: `${p}campaign-code`,
      domId: "campaign-code",
    },
    {
      key: "customerPoNumber",
      kind: "text",
      label: "Customer PO number",
      placeholder: "If the customer already issued one",
      maxLength: 40,
      testid: `${p}po-number`,
      domId: "po-number",
    },
  ];
}

function requiredField(version: PortalVersion): FieldDef {
  return {
    key: "partnerTier",
    kind: "combobox",
    label: "Partner tier",
    required: true,
    options: PARTNER_TIERS,
    placeholder: "Select your tier",
    hint: "Your current Caravela partner program tier.",
    testid: `${partnerTestidPrefix(version)}partner-tier`,
    domId: "partner-tier",
  };
}

/** Effective (mutated) form layout. Used by both the server (validation) and the client (render). */
export function partnerSections(version: PortalVersion, m: Mutator): SectionDef[] {
  return mutateSections(partnerBaseSections(version), m, {
    optionalCandidates: optionalCandidates(version),
    requiredField: requiredField(version),
    requiredAfter: "product",
    radioEligible: ["product"],
  });
}

/** Canonical labels for every key a partner submission can contain (read-back fallback). */
export const PARTNER_FIELD_LABELS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, v.label])),
  campaignCode: "Campaign code",
  customerPoNumber: "Customer PO number",
  partnerTier: "Partner tier",
};

export const PARTNER_ACTIONS = {
  submit: {
    v1: "Submit registration",
    v2: "Register opportunity",
    synonyms: [
      "Send registration",
      "Submit deal",
      "Confirm registration",
      "Register deal",
      "Send for review",
    ],
  },
  newDeal: {
    text: "Register a deal",
    synonyms: ["New registration", "Register new deal", "Add a registration"],
  },
} as const;

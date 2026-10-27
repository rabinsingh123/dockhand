// Multi-tenant supplier onboarding portal (Coupa-like, fictional). Each tenant shows only the
// buyer's brand ("Acme Group · Supplier Portal"). Tenants share labels, testids and canonical keys;
// globex differs in layout (extra optional D-U-N-S field, field order in steps 1 and 3, and the
// remit-to checkbox at the end of step 2) so a replay must not depend on positions.

import type { FieldDef, SectionDef } from "./fields.ts";
import { type Mutator, mutateSections } from "./mutations.ts";

export type TenantSlug = "acme" | "globex";

export interface TenantInfo {
  slug: TenantSlug;
  name: string;
  portalName: string;
  invitePrefix: string;
  sampleInviteCode: string;
  /** Supplier ids look like SG-ACME-000123. */
  idPrefix: string;
  requester: string;
  contactEmail: string;
  brand: { primary: string; hover: string; tint: string; ring: string; ink: string };
}

export const TENANTS: Record<TenantSlug, TenantInfo> = {
  acme: {
    slug: "acme",
    name: "Acme Group",
    portalName: "Acme Group · Supplier Portal",
    invitePrefix: "ACME",
    sampleInviteCode: "ACME-7731",
    idPrefix: "SG-ACME-",
    requester: "Acme Group Procurement",
    contactEmail: "supplier.onboarding@acme-group.example",
    brand: {
      primary: "#2456d6",
      hover: "#1c46b3",
      tint: "#edf2fe",
      ring: "rgba(36,86,214,0.28)",
      ink: "#13306f",
    },
  },
  globex: {
    slug: "globex",
    name: "Globex Industrial",
    portalName: "Globex Industrial · Supplier Portal",
    invitePrefix: "GLOBEX",
    sampleInviteCode: "GLOBEX-2048",
    idPrefix: "SG-GLOBEX-",
    requester: "Globex Industrial Strategic Sourcing",
    contactEmail: "vendors@globex-industrial.example",
    brand: {
      primary: "#0f7b53",
      hover: "#0b6343",
      tint: "#e8f5ef",
      ring: "rgba(15,123,83,0.28)",
      ink: "#0a3d2a",
    },
  },
};

export function getTenant(slug: string | undefined): TenantInfo | undefined {
  return slug === "acme" || slug === "globex" ? TENANTS[slug] : undefined;
}

/** Codes match ^[A-Z]+-\d{4}$ with the tenant's prefix (case-insensitive input, normalized upper). */
export function isValidInviteCode(tenant: TenantInfo, code: string): boolean {
  const c = code.trim().toUpperCase();
  return /^[A-Z]+-\d{4}$/.test(c) && c.startsWith(`${tenant.invitePrefix}-`);
}

export const SUPPLIER_ID_RE = /SG-[A-Z]+-\d{6}/;

export const SUPPLIER_COUNTRIES = [
  "Argentina",
  "Australia",
  "Brazil",
  "Canada",
  "Chile",
  "Colombia",
  "France",
  "Germany",
  "India",
  "Indonesia",
  "Ireland",
  "Japan",
  "Mexico",
  "Netherlands",
  "Peru",
  "Philippines",
  "Portugal",
  "Singapore",
  "Spain",
  "United Kingdom",
  "United States",
  "Vietnam",
] as const;
export const EMPLOYEE_RANGES = [
  "1-10",
  "11-50",
  "51-200",
  "201-500",
  "501-1000",
  "1001-5000",
  "5001+",
] as const;
export const REVENUE_RANGES = [
  "Under $1M",
  "$1M-$10M",
  "$10M-$50M",
  "$50M-$250M",
  "$250M-$1B",
  "Over $1B",
] as const;
export const ENTITY_TYPES = ["Corporation", "LLC", "Partnership", "Sole proprietor"] as const;
export const CURRENCIES = ["USD", "EUR", "BRL", "MXN", "INR"] as const;
export const DIVERSITY_OPTIONS = [
  "Small business",
  "Women-owned",
  "Minority-owned",
  "Veteran-owned",
  "None of these",
] as const;
export const SUPPLIER_CATEGORIES = [
  "Software and SaaS",
  "Professional services",
  "IT hardware",
  "Logistics",
  "Marketing services",
] as const;

export type SupplierStepKey = "company" | "address" | "contacts" | "banking" | "compliance";

export interface StepMeta {
  key: SupplierStepKey;
  title: string;
  heading: string;
  /** `{buyer}` is replaced with the tenant name. */
  description: string;
}

export const SUPPLIER_STEPS: readonly StepMeta[] = [
  {
    key: "company",
    title: "Company",
    heading: "Company information",
    description: "Legal and tax details for the entity that will invoice {buyer}.",
  },
  {
    key: "address",
    title: "Address",
    heading: "Business address",
    description: "Where your company is registered, and where {buyer} should send payments.",
  },
  {
    key: "contacts",
    title: "Contacts",
    heading: "Contacts",
    description: "People {buyer} can reach about orders, invoices and payments.",
  },
  {
    key: "banking",
    title: "Banking",
    heading: "Banking details",
    description: "The account {buyer} will pay. Details are encrypted and only visible to accounts payable.",
  },
  {
    key: "compliance",
    title: "Compliance",
    heading: "Compliance and documents",
    description: "Tax and insurance documents, supplier diversity, and policy acceptance.",
  },
];

export interface StepDef extends StepMeta {
  sections: SectionDef[];
}

type Def = Omit<FieldDef, "key">;

const F = {
  // Step 1: company
  legalName: {
    kind: "text",
    label: "Legal company name",
    required: true,
    maxLength: 160,
    placeholder: "As shown on your tax documents",
    testid: "sg-legal-name",
    domId: "legal-name",
    synonyms: ["Registered company name", "Legal entity name", "Company legal name"],
    altPlaceholders: ["Registered legal name", "e.g. Tidewater Cloud Inc.", "Full legal name"],
  },
  tradeName: {
    kind: "text",
    label: "Trade name (DBA)",
    maxLength: 160,
    placeholder: "If different from the legal name",
    testid: "sg-trade-name",
    domId: "trade-name",
    synonyms: ["Doing business as", "Brand name", "Trading name"],
    altPlaceholders: ["Optional", "Brand or trading name", "DBA"],
  },
  taxId: {
    kind: "text",
    label: "Tax ID (EIN)",
    required: true,
    placeholder: "NN-NNNNNNN",
    pattern: {
      source: "^\\d{2}-\\d{7}$",
      message: "{label} must use the format NN-NNNNNNN, like 12-3456789.",
    },
    testid: "sg-tax-id",
    domId: "tax-id",
    synonyms: ["Employer Identification Number", "Federal tax ID (EIN)", "EIN"],
    altPlaceholders: ["12-3456789", "9-digit EIN", "XX-XXXXXXX"],
  },
  countryOfIncorporation: {
    kind: "combobox",
    label: "Country of incorporation",
    required: true,
    options: SUPPLIER_COUNTRIES,
    placeholder: "Select a country",
    testid: "sg-incorporation-country",
    domId: "incorporation-country",
    synonyms: ["Country of registration", "Incorporated in", "Jurisdiction country"],
    altPlaceholders: ["Choose country", "Search countries", "Country"],
  },
  stateOfIncorporation: {
    kind: "text",
    label: "State / province of incorporation",
    required: true,
    maxLength: 80,
    placeholder: "e.g. Delaware",
    testid: "sg-incorporation-state",
    domId: "incorporation-state",
    synonyms: ["State of registration", "Incorporation state / province", "Region of incorporation"],
    altPlaceholders: ["State or province", "e.g. São Paulo", "Region"],
  },
  yearFounded: {
    kind: "year",
    label: "Year founded",
    required: true,
    placeholder: "YYYY",
    inputMode: "numeric",
    testid: "sg-year-founded",
    domId: "year-founded",
    synonyms: ["Year established", "Founded in", "Year of incorporation"],
    altPlaceholders: ["e.g. 2015", "4-digit year", "yyyy"],
  },
  website: {
    kind: "url",
    label: "Company website",
    placeholder: "https://",
    testid: "sg-website",
    domId: "website",
    synonyms: ["Website", "Corporate website", "Web address"],
    altPlaceholders: ["www.example.com", "Company URL", "https://www."],
  },
  employees: {
    kind: "combobox",
    label: "Number of employees",
    required: true,
    options: EMPLOYEE_RANGES,
    placeholder: "Select a range",
    testid: "sg-employees",
    domId: "employees",
    synonyms: ["Employee count", "Company size", "Headcount"],
    altPlaceholders: ["Choose a range", "Employees", "Pick one"],
  },
  annualRevenue: {
    kind: "combobox",
    label: "Annual revenue (USD)",
    required: true,
    options: REVENUE_RANGES,
    placeholder: "Select a range",
    testid: "sg-annual-revenue",
    domId: "annual-revenue",
    synonyms: ["Yearly revenue (USD)", "Revenue band (USD)", "Annual turnover (USD)"],
    altPlaceholders: ["Choose a range", "Revenue", "Pick one"],
  },
  entityType: {
    kind: "radio",
    label: "Entity type",
    required: true,
    options: ENTITY_TYPES,
    testid: "sg-entity-type",
    domId: "entity-type",
    synonyms: ["Business structure", "Legal structure", "Company type"],
  },
  dunsNumber: {
    kind: "text",
    label: "D-U-N-S number",
    placeholder: "9 digits",
    inputMode: "numeric",
    pattern: { source: "^\\d{2}-?\\d{3}-?\\d{4}$", message: "{label} must have 9 digits, like 12-345-6789." },
    testid: "sg-duns-number",
    domId: "duns-number",
    synonyms: ["DUNS number", "Dun & Bradstreet number", "D&B D-U-N-S"],
    altPlaceholders: ["12-345-6789", "Optional", "Nine digits"],
  },
  // Step 2: address
  street1: {
    kind: "text",
    label: "Street address",
    required: true,
    maxLength: 160,
    placeholder: "Street and number",
    testid: "sg-street1",
    domId: "street1",
    synonyms: ["Address line 1", "Street", "Registered address"],
    altPlaceholders: ["e.g. 500 Market Street", "Street name and number", "Line 1"],
  },
  street2: {
    kind: "text",
    label: "Address line 2",
    maxLength: 160,
    placeholder: "Suite, floor, building (optional)",
    testid: "sg-street2",
    domId: "street2",
    synonyms: ["Apartment, suite, etc.", "Additional address", "Address 2"],
    altPlaceholders: ["Optional", "Suite or floor", "Building"],
  },
  city: {
    kind: "text",
    label: "City",
    required: true,
    maxLength: 80,
    testid: "sg-city",
    domId: "city",
    synonyms: ["Town / city", "Municipality", "City / locality"],
  },
  state: {
    kind: "text",
    label: "State / province",
    required: true,
    maxLength: 80,
    testid: "sg-state",
    domId: "state",
    synonyms: ["Region", "State / region", "Province"],
  },
  postalCode: {
    kind: "text",
    label: "Postal code",
    required: true,
    pattern: {
      source: "^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$",
      message: "{label} must be 3 to 10 letters or digits.",
    },
    testid: "sg-postal-code",
    domId: "postal-code",
    synonyms: ["ZIP / postal code", "Postcode", "ZIP code"],
  },
  country: {
    kind: "combobox",
    label: "Country",
    required: true,
    options: SUPPLIER_COUNTRIES,
    placeholder: "Select a country",
    testid: "sg-country",
    domId: "country",
    synonyms: ["Country / region", "Address country", "Nation"],
    altPlaceholders: ["Choose country", "Search countries", "Country"],
  },
  remitSameAsAddress: {
    kind: "checkbox",
    label: "Remit-to address is the same",
    defaultValue: true,
    hint: "Payments will be sent to your business address.",
    testid: "sg-remit-same",
    domId: "remit-same",
    span: 2,
    synonyms: [
      "Use this address for remittance",
      "Remittance address is identical",
      "Send payments to this address",
    ],
  },
  remitStreet1: {
    kind: "text",
    label: "Remit-to street address",
    required: true,
    maxLength: 160,
    testid: "sg-remit-street1",
    domId: "remit-street1",
    showWhen: { key: "remitSameAsAddress", equals: false },
    synonyms: ["Remittance street", "Remit-to address line 1", "Payment address street"],
  },
  remitStreet2: {
    kind: "text",
    label: "Remit-to address line 2",
    maxLength: 160,
    testid: "sg-remit-street2",
    domId: "remit-street2",
    showWhen: { key: "remitSameAsAddress", equals: false },
    synonyms: ["Remittance address line 2", "Remit-to suite / floor", "Payment address line 2"],
  },
  remitCity: {
    kind: "text",
    label: "Remit-to city",
    required: true,
    maxLength: 80,
    testid: "sg-remit-city",
    domId: "remit-city",
    showWhen: { key: "remitSameAsAddress", equals: false },
    synonyms: ["Remittance city", "Payment address city", "Remit-to town / city"],
  },
  remitState: {
    kind: "text",
    label: "Remit-to state / province",
    required: true,
    maxLength: 80,
    testid: "sg-remit-state",
    domId: "remit-state",
    showWhen: { key: "remitSameAsAddress", equals: false },
    synonyms: ["Remittance state / province", "Payment address region", "Remit-to region"],
  },
  remitPostalCode: {
    kind: "text",
    label: "Remit-to postal code",
    required: true,
    pattern: {
      source: "^[A-Za-z0-9][A-Za-z0-9 -]{2,9}$",
      message: "{label} must be 3 to 10 letters or digits.",
    },
    testid: "sg-remit-postal-code",
    domId: "remit-postal-code",
    showWhen: { key: "remitSameAsAddress", equals: false },
    synonyms: ["Remittance postal code", "Remit-to ZIP code", "Payment address postcode"],
  },
  // Step 3: contacts
  primaryContactName: {
    kind: "text",
    label: "Primary contact name",
    required: true,
    maxLength: 120,
    testid: "sg-primary-name",
    domId: "primary-name",
    synonyms: ["Main contact name", "Primary contact full name", "Account manager name"],
  },
  primaryContactTitle: {
    kind: "text",
    label: "Primary contact title",
    required: true,
    maxLength: 120,
    placeholder: "e.g. Head of Sales",
    testid: "sg-primary-title",
    domId: "primary-title",
    synonyms: ["Primary contact job title", "Main contact role", "Primary contact position"],
    altPlaceholders: ["Job title", "Role", "e.g. Account Director"],
  },
  primaryContactEmail: {
    kind: "email",
    label: "Primary contact email",
    required: true,
    maxLength: 160,
    inputMode: "email",
    testid: "sg-primary-email",
    domId: "primary-email",
    synonyms: ["Main contact email", "Primary contact e-mail", "Primary email address"],
  },
  primaryContactPhone: {
    kind: "tel",
    label: "Primary contact phone",
    required: true,
    inputMode: "tel",
    placeholder: "+1 555 010 0000",
    testid: "sg-primary-phone",
    domId: "primary-phone",
    synonyms: ["Main contact phone", "Primary contact telephone", "Primary phone number"],
    altPlaceholders: ["Include country code", "Phone", "+44 20 7946 0000"],
  },
  arContactName: {
    kind: "text",
    label: "Accounts receivable name",
    required: true,
    maxLength: 120,
    testid: "sg-ar-name",
    domId: "ar-name",
    synonyms: ["AR contact name", "Billing contact name", "Receivables contact"],
  },
  arContactEmail: {
    kind: "email",
    label: "Accounts receivable email",
    required: true,
    maxLength: 160,
    inputMode: "email",
    testid: "sg-ar-email",
    domId: "ar-email",
    synonyms: ["AR contact email", "Billing email", "Remittance advice email"],
  },
  arContactPhone: {
    kind: "tel",
    label: "Accounts receivable phone",
    inputMode: "tel",
    testid: "sg-ar-phone",
    domId: "ar-phone",
    synonyms: ["AR contact phone", "Billing phone", "Receivables phone"],
  },
  salesContactName: {
    kind: "text",
    label: "Sales contact name",
    maxLength: 120,
    testid: "sg-sales-name",
    domId: "sales-name",
    synonyms: ["Sales representative", "Account executive name", "Sales rep name"],
  },
  salesContactEmail: {
    kind: "email",
    label: "Sales contact email",
    maxLength: 160,
    inputMode: "email",
    testid: "sg-sales-email",
    domId: "sales-email",
    synonyms: ["Sales representative email", "Account executive email", "Sales rep email"],
  },
  // Step 4: banking
  bankName: {
    kind: "text",
    label: "Bank name",
    required: true,
    maxLength: 120,
    testid: "sg-bank-name",
    domId: "bank-name",
    synonyms: ["Financial institution", "Name of bank", "Bank"],
  },
  accountHolder: {
    kind: "text",
    label: "Account holder name",
    required: true,
    maxLength: 160,
    testid: "sg-account-holder",
    domId: "account-holder",
    synonyms: ["Name on account", "Beneficiary name", "Account name"],
  },
  accountNumber: {
    kind: "text",
    label: "Account number",
    required: true,
    inputMode: "numeric",
    pattern: { source: "^\\d{4,17}$", message: "{label} must be 4 to 17 digits." },
    testid: "sg-account-number",
    domId: "account-number",
    synonyms: ["Bank account number", "Account no.", "Beneficiary account number"],
  },
  routingNumber: {
    kind: "text",
    label: "Routing number (ABA)",
    required: true,
    inputMode: "numeric",
    placeholder: "9 digits",
    pattern: { source: "^\\d{9}$", message: "{label} must be exactly 9 digits." },
    testid: "sg-routing-number",
    domId: "routing-number",
    synonyms: ["ABA routing number", "Bank routing number", "Routing / transit number"],
    altPlaceholders: ["Nine digits", "e.g. 021000021", "ABA"],
  },
  swiftBic: {
    kind: "text",
    label: "SWIFT / BIC",
    placeholder: "8 or 11 characters",
    pattern: {
      source: "^[A-Za-z]{6}[A-Za-z0-9]{2}([A-Za-z0-9]{3})?$",
      message: "{label} must be 8 or 11 characters, like BOFAUS3N.",
    },
    testid: "sg-swift",
    domId: "swift",
    synonyms: ["SWIFT code", "BIC code", "SWIFT / BIC code"],
    altPlaceholders: ["Optional", "e.g. BOFAUS3N", "International transfers only"],
  },
  currency: {
    kind: "combobox",
    label: "Currency",
    required: true,
    options: CURRENCIES,
    placeholder: "Select a currency",
    hint: "The currency you will invoice in.",
    testid: "sg-currency",
    domId: "currency",
    synonyms: ["Payment currency", "Invoice currency", "Remittance currency"],
    altPlaceholders: ["Choose currency", "e.g. USD", "Currency code"],
  },
  bankConfirm: {
    kind: "checkbox",
    label: "I confirm these banking details",
    required: true,
    requiredMessage: "Confirm your banking details to continue.",
    testid: "sg-bank-confirm",
    domId: "bank-confirm",
    span: 2,
    synonyms: [
      "I certify these banking details are correct",
      "The banking details above are accurate",
      "I confirm the account information",
    ],
  },
  // Step 5: compliance
  w9File: {
    kind: "file",
    label: "W-9 form",
    required: true,
    accept: ".pdf,application/pdf",
    hint: "PDF, up to 10 MB.",
    testid: "sg-w9",
    domId: "w9",
    synonyms: ["IRS Form W-9", "W-9 tax form", "Taxpayer form (W-9)"],
  },
  coiFile: {
    kind: "file",
    label: "Certificate of insurance",
    required: true,
    accept: ".pdf,application/pdf",
    hint: "PDF, up to 10 MB.",
    testid: "sg-coi",
    domId: "coi",
    synonyms: ["Insurance certificate", "Certificate of insurance (COI)", "Proof of insurance"],
  },
  diversity: {
    kind: "checkboxGroup",
    label: "Diversity classifications",
    options: DIVERSITY_OPTIONS,
    exclusiveOption: "None of these",
    hint: "Select all that apply.",
    testid: "sg-diversity",
    domId: "diversity",
    span: 2,
    synonyms: ["Supplier diversity", "Diversity certifications", "Business classifications"],
  },
  conflictOfInterest: {
    kind: "radio",
    label: "Conflict of interest",
    required: true,
    options: ["Yes", "No"],
    hint: "Does any employee of {buyer} have a financial interest in your company?",
    testid: "sg-conflict",
    domId: "conflict",
    span: 2,
    synonyms: [
      "Potential conflict of interest",
      "Conflict of interest declaration",
      "Related-party interest",
    ],
  },
  codeOfConduct: {
    kind: "checkbox",
    label: "I accept the Supplier Code of Conduct",
    required: true,
    requiredMessage: "Accept the Supplier Code of Conduct to continue.",
    testid: "sg-code-of-conduct",
    domId: "code-of-conduct",
    span: 2,
    synonyms: [
      "I agree to the Supplier Code of Conduct",
      "I have read and accept the Supplier Code of Conduct",
      "Accept Supplier Code of Conduct",
    ],
  },
  signatoryName: {
    kind: "text",
    label: "Signatory name",
    required: true,
    maxLength: 120,
    testid: "sg-signatory-name",
    domId: "signatory-name",
    synonyms: ["Authorized signatory", "Name of signatory", "Signed by"],
  },
  signatoryTitle: {
    kind: "text",
    label: "Signatory title",
    required: true,
    maxLength: 120,
    testid: "sg-signatory-title",
    domId: "signatory-title",
    synonyms: ["Signatory job title", "Title of signatory", "Signatory position"],
  },
} satisfies Record<string, Def>;

export type SupplierFieldKey = keyof typeof F;

function f(key: SupplierFieldKey, overrides: Partial<FieldDef> = {}): FieldDef {
  return { key, ...(F[key] as Def), ...overrides };
}

const REMIT_KEYS: SupplierFieldKey[] = [
  "remitStreet1",
  "remitStreet2",
  "remitCity",
  "remitState",
  "remitPostalCode",
];

function remitSection(): SectionDef {
  return {
    key: "remit",
    step: "address",
    title: "Remit-to address",
    description: "Where payments and remittance advice should be sent.",
    columns: 2,
    insertable: false,
    showWhen: { key: "remitSameAsAddress", equals: false },
    fields: REMIT_KEYS.map((k) => f(k)),
  };
}

function commonTail(): SectionDef[] {
  return [
    {
      key: "bank",
      step: "banking",
      columns: 2,
      fields: [
        f("bankName"),
        f("accountHolder"),
        f("accountNumber"),
        f("routingNumber"),
        f("swiftBic"),
        f("currency"),
        f("bankConfirm"),
      ],
    },
    {
      key: "documents",
      step: "compliance",
      title: "Documents",
      columns: 2,
      fields: [f("w9File"), f("coiFile")],
    },
    {
      key: "ethics",
      step: "compliance",
      title: "Diversity and ethics",
      columns: 2,
      fields: [f("diversity"), f("conflictOfInterest"), f("codeOfConduct")],
    },
    {
      key: "signature",
      step: "compliance",
      title: "Signature",
      description: "The person authorized to submit this registration.",
      columns: 2,
      fields: [f("signatoryName"), f("signatoryTitle")],
    },
  ];
}

/** Unmutated layout for a tenant, flattened across steps (each section carries its step). */
export function supplierBaseSections(tenant: TenantSlug): SectionDef[] {
  if (tenant === "globex") {
    return [
      {
        key: "company",
        step: "company",
        columns: 2,
        fields: [
          f("legalName"),
          f("taxId"),
          f("dunsNumber"),
          f("tradeName"),
          f("countryOfIncorporation"),
          f("stateOfIncorporation"),
          f("entityType", { span: 2 }),
          f("yearFounded"),
          f("employees"),
          f("annualRevenue"),
          f("website"),
        ],
      },
      {
        key: "address",
        step: "address",
        columns: 2,
        fields: [f("street1"), f("street2"), f("city"), f("state"), f("postalCode"), f("country")],
      },
      remitSection(),
      {
        key: "remittance",
        step: "address",
        title: "Remittance",
        columns: 2,
        insertable: false,
        fields: [f("remitSameAsAddress")],
      },
      {
        key: "primary",
        step: "contacts",
        title: "Primary contact",
        columns: 2,
        fields: [
          f("primaryContactName"),
          f("primaryContactEmail"),
          f("primaryContactPhone"),
          f("primaryContactTitle"),
        ],
      },
      {
        key: "ar",
        step: "contacts",
        title: "Accounts receivable",
        columns: 2,
        fields: [f("arContactName"), f("arContactPhone"), f("arContactEmail")],
      },
      {
        key: "sales",
        step: "contacts",
        title: "Sales contact",
        description: "Optional.",
        columns: 2,
        fields: [f("salesContactEmail"), f("salesContactName")],
      },
      ...commonTail(),
    ];
  }
  return [
    {
      key: "company",
      step: "company",
      columns: 2,
      fields: [
        f("legalName"),
        f("tradeName"),
        f("taxId"),
        f("countryOfIncorporation"),
        f("stateOfIncorporation"),
        f("yearFounded"),
        f("website"),
        f("employees"),
        f("annualRevenue"),
        f("entityType"),
      ],
    },
    {
      key: "address",
      step: "address",
      columns: 2,
      fields: [
        f("street1"),
        f("street2"),
        f("city"),
        f("state"),
        f("postalCode"),
        f("country"),
        f("remitSameAsAddress"),
      ],
    },
    remitSection(),
    {
      key: "primary",
      step: "contacts",
      title: "Primary contact",
      columns: 2,
      fields: [
        f("primaryContactName"),
        f("primaryContactTitle"),
        f("primaryContactEmail"),
        f("primaryContactPhone"),
      ],
    },
    {
      key: "ar",
      step: "contacts",
      title: "Accounts receivable",
      columns: 2,
      fields: [f("arContactName"), f("arContactEmail"), f("arContactPhone")],
    },
    {
      key: "sales",
      step: "contacts",
      title: "Sales contact",
      description: "Optional.",
      columns: 2,
      fields: [f("salesContactName"), f("salesContactEmail")],
    },
    ...commonTail(),
  ];
}

const OPTIONAL_CANDIDATES: FieldDef[] = [
  {
    key: "naicsCode",
    kind: "text",
    label: "NAICS code",
    placeholder: "6 digits",
    inputMode: "numeric",
    pattern: { source: "^\\d{6}$", message: "{label} must be 6 digits." },
    testid: "sg-naics-code",
    domId: "naics-code",
  },
  {
    key: "linkedinUrl",
    kind: "url",
    label: "Company LinkedIn page",
    placeholder: "linkedin.com/company/…",
    testid: "sg-linkedin-url",
    domId: "linkedin-url",
  },
];

const REQUIRED_FIELD: FieldDef = {
  key: "supplierCategory",
  kind: "combobox",
  label: "Supplier category",
  required: true,
  options: SUPPLIER_CATEGORIES,
  placeholder: "Select a category",
  testid: "sg-supplier-category",
  domId: "supplier-category",
};

export const SUPPLIER_MOVABLE_FIELDS: readonly string[] = [
  "website",
  "yearFounded",
  "tradeName",
  "street2",
  "primaryContactTitle",
  "salesContactEmail",
  "swiftBic",
  "signatoryTitle",
];

/** Effective (mutated) sections, flattened. Used by the server (validation) and client (render). */
export function supplierSections(tenant: TenantSlug, m: Mutator): SectionDef[] {
  return mutateSections(supplierBaseSections(tenant), m, {
    optionalCandidates: OPTIONAL_CANDIDATES,
    requiredField: REQUIRED_FIELD,
    radioEligible: ["currency"],
    movable: SUPPLIER_MOVABLE_FIELDS,
  });
}

export function supplierSteps(tenant: TenantSlug, m: Mutator): StepDef[] {
  const sections = supplierSections(tenant, m);
  return SUPPLIER_STEPS.map((meta) => ({ ...meta, sections: sections.filter((s) => s.step === meta.key) }));
}

export const SUPPLIER_ACTIONS = {
  start: {
    text: "Start registration",
    synonyms: ["Begin registration", "Get started", "Continue to registration"],
  },
  next: { text: "Next", synonyms: ["Continue", "Save and continue", "Next step"] },
  submit: {
    text: "Submit for approval",
    synonyms: ["Send for approval", "Submit registration", "Finish and submit"],
  },
} as const;

export const SUPPLIER_FILE_FIELDS = ["w9File", "coiFile"] as const;

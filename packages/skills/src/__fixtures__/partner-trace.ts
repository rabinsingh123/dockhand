// Hand-written trace of a first (computer-use) run on Caravela Partner Hub v1, deal registration.
// Deliberately messy: a screenshot and a misclick on the heading, Tab hops, a wrong field typed and
// cleared, a typo fixed by select-all and retype, a scroll, a mouse move and a wait, a combobox
// filtered by typing, a submit the commit guard blocked, request_commit, then the approved submit.

import type { CuAction, ParamSpec, ParamValue, Target, Trace, TraceStep } from "@dockhand/core";

export const PARTNER_PARAMS: Record<string, ParamValue> = {
  company: "Jabuticaba Tecnologia Ltda.",
  website: "jabuticaba.com.br",
  country: "Brazil",
  city: "São Paulo",
  contact_name: "Mariana Costa",
  contact_email: "mariana.costa@jabuticaba.com.br",
  contact_phone: "+5511987654321",
  product: "Tidewater Cloud Business",
  seats: 120,
  est_value: 86400,
  close_date: "2027-03-15",
  notes: "Pilot for the finance team",
};

export const PARTNER_PARAM_SPECS: ParamSpec[] = [
  { name: "company", type: "string", required: true, description: "End customer's legal company name" },
  { name: "website", type: "string", required: false, description: "End customer's website" },
  { name: "country", type: "enum", required: true, description: "End customer's country" },
  { name: "city", type: "string", required: true, description: "End customer's city" },
  { name: "contact_name", type: "string", required: true, description: "Customer contact's full name" },
  { name: "contact_email", type: "email", required: true, description: "Customer contact's email" },
  { name: "contact_phone", type: "phone", required: false, description: "Customer contact's phone" },
  { name: "product", type: "enum", required: true, description: "Tidewater Cloud product" },
  { name: "seats", type: "number", required: true, description: "Number of seats" },
  { name: "est_value", type: "number", required: false, description: "Estimated deal value in USD" },
  { name: "close_date", type: "date", required: true, description: "Expected close date" },
  { name: "notes", type: "string", required: false, description: "Notes for Caravela" },
  // Unused by the run below: compile drops it.
  { name: "referral_partner", type: "string", required: false, description: "Referral partner" },
];

interface FieldSpec {
  label: string;
  testId: string;
  domId: string;
  section: string;
  y: number;
  role?: "textbox" | "combobox" | "checkbox";
  inputType?: string;
  tag?: "input" | "textarea";
  placeholder?: string;
}

function field(f: FieldSpec): Target {
  const role = f.role ?? "textbox";
  const tag = f.tag ?? "input";
  return {
    candidates: [
      { by: "testid", value: f.testId },
      { by: "role", role, name: f.label, exact: true },
      ...(role === "combobox" ? [] : [{ by: "label" as const, value: f.label, exact: true }]),
      { by: "css", value: `#${f.domId}` },
    ],
    fingerprint: {
      tag,
      ...(tag === "input" ? { inputType: f.inputType ?? (role === "checkbox" ? "checkbox" : "text") } : {}),
      role,
      name: f.label,
      label: f.label,
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      testId: f.testId,
      domId: f.domId,
      section: f.section,
      bbox: { x: 296, y: f.y, w: role === "checkbox" ? 18 : 560, h: role === "checkbox" ? 18 : 40 },
    },
  };
}

export const T = {
  registerDeal: {
    candidates: [
      { by: "testid", value: "nw-register-deal" },
      { by: "role", role: "button", name: "Register a deal", exact: true },
    ],
    fingerprint: {
      tag: "button",
      role: "button",
      name: "Register a deal",
      text: "Register a deal",
      testId: "nw-register-deal",
      bbox: { x: 1012, y: 132, w: 164, h: 40 },
    },
  },
  heading: {
    candidates: [{ by: "text", value: "Register a deal", exact: true }],
    fingerprint: {
      tag: "h1",
      role: "heading",
      name: "Register a deal",
      text: "Register a deal",
      bbox: { x: 296, y: 118, w: 320, h: 36 },
    },
  },
  company: field({
    label: "End customer company",
    testId: "nw-company-name",
    domId: "company-name",
    section: "End customer",
    y: 262,
    placeholder: "e.g. Sabiá Foods Ltda.",
  }),
  website: field({
    label: "Company website",
    testId: "nw-company-website",
    domId: "company-website",
    section: "End customer",
    y: 338,
    placeholder: "e.g. sabiafoods.com.br",
  }),
  country: field({
    label: "Country",
    testId: "nw-country",
    domId: "country",
    section: "End customer",
    y: 414,
    role: "combobox",
    placeholder: "Select a country",
  }),
  brazil: {
    candidates: [
      { by: "testid", value: "nw-country-option-brazil" },
      { by: "role", role: "option", name: "Brazil", exact: true },
    ],
    fingerprint: {
      tag: "li",
      role: "option",
      name: "Brazil",
      text: "Brazil",
      testId: "nw-country-option-brazil",
      domId: "country-option-brazil",
      bbox: { x: 296, y: 494, w: 560, h: 36 },
    },
  },
  city: field({
    label: "City",
    testId: "nw-city",
    domId: "city",
    section: "End customer",
    y: 490,
    placeholder: "e.g. São Paulo",
  }),
  contactName: field({
    label: "Contact full name",
    testId: "nw-contact-name",
    domId: "contact-name",
    section: "Customer contact",
    y: 640,
    placeholder: "e.g. Mariana Costa",
  }),
  contactEmail: field({
    label: "Contact email",
    testId: "nw-contact-email",
    domId: "contact-email",
    section: "Customer contact",
    y: 716,
    inputType: "email",
    placeholder: "name@company.com",
  }),
  contactPhone: field({
    label: "Contact phone",
    testId: "nw-contact-phone",
    domId: "contact-phone",
    section: "Customer contact",
    y: 392,
    inputType: "tel",
    placeholder: "+55 11 91234 5678",
  }),
  product: field({
    label: "Product",
    testId: "nw-product",
    domId: "product",
    section: "Opportunity",
    y: 542,
    role: "combobox",
    placeholder: "Select a product",
  }),
  business: {
    candidates: [
      { by: "testid", value: "nw-product-option-tidewater-cloud-business" },
      { by: "role", role: "option", name: "Tidewater Cloud Business", exact: true },
    ],
    fingerprint: {
      tag: "li",
      role: "option",
      name: "Tidewater Cloud Business",
      text: "Tidewater Cloud Business",
      testId: "nw-product-option-tidewater-cloud-business",
      domId: "product-option-tidewater-cloud-business",
      bbox: { x: 296, y: 658, w: 560, h: 36 },
    },
  },
  seats: field({
    label: "Seats",
    testId: "nw-seats",
    domId: "seats",
    section: "Opportunity",
    y: 618,
    placeholder: "e.g. 25",
  }),
  estValue: field({
    label: "Estimated value (USD)",
    testId: "nw-estimated-value",
    domId: "estimated-value",
    section: "Opportunity",
    y: 694,
    placeholder: "e.g. 18000",
  }),
  closeDate: field({
    label: "Expected close date",
    testId: "nw-close-date",
    domId: "close-date",
    section: "Opportunity",
    y: 254,
    placeholder: "DD/MM/YYYY",
  }),
  referral: field({
    label: "Referral partner",
    testId: "nw-referral-partner",
    domId: "referral-partner",
    section: "Opportunity",
    y: 330,
    placeholder: "Partner or agent name (optional)",
  }),
  notes: field({
    label: "Notes",
    testId: "nw-notes",
    domId: "notes",
    section: "Additional information",
    y: 470,
    tag: "textarea",
    placeholder: "Anything Caravela should know about this opportunity",
  }),
  consent: field({
    label: "The end customer agreed to be contacted by Caravela",
    testId: "nw-consent",
    domId: "consent",
    section: "Additional information",
    y: 640,
    role: "checkbox",
  }),
  submit: {
    candidates: [
      { by: "testid", value: "nw-submit" },
      { by: "role", role: "button", name: "Submit registration", exact: true },
    ],
    fingerprint: {
      tag: "button",
      role: "button",
      name: "Submit registration",
      text: "Submit registration",
      testId: "nw-submit",
      bbox: { x: 690, y: 724, w: 190, h: 40 },
      formSubmit: true,
    },
  },
} satisfies Record<string, Target>;

const EMPTY_FORM: Record<string, string> = {
  "End customer company": "",
  "Company website": "",
  Country: "",
  City: "",
  "Contact full name": "",
  "Contact email": "",
  "Contact phone": "",
  Product: "",
  Seats: "",
  "Estimated value (USD)": "",
  "Expected close date": "",
  "Referral partner": "",
  Notes: "",
  "The end customer agreed to be contacted by Caravela": "false",
};

const REG_ID = "NW-REG-48213";

function confirmationText(): string {
  return [
    "Caravela Partner Hub",
    "Deal registrations",
    "Tidewater Cloud",
    "ana.souza",
    "Sign out",
    `Deal registrations / ${REG_ID}`,
    "Registration received",
    "Caravela's partner team reviews new registrations within 2 business days. Protected pricing applies once the registration is approved.",
    "Registration ID",
    REG_ID,
    "Status",
    "Pending review",
    "Submitted",
    "27 Oct 2026, 01:40",
    "Registration details",
    "End customer company",
    "Jabuticaba Tecnologia Ltda.",
    "Company website",
    "jabuticaba.com.br",
    "Country",
    "Brazil",
    "City",
    "Sao Paulo",
    "Contact full name",
    "Mariana Costa",
    "Contact email",
    "mariana.costa@jabuticaba.com.br",
    "Contact phone",
    "+55 11 98765-4321",
    "Product",
    "Tidewater Cloud Business",
    "Seats",
    "120",
    "Estimated value (USD)",
    "86400",
    "Expected close date",
    "15/03/2027",
    "Notes",
    "Pilot for the finance team",
    "The end customer agreed to be contacted by Caravela",
    "Yes",
    "Back to deals",
    "Register another deal",
    "Demo software. Fictional companies and data.",
  ].join("\n");
}

const SHOT = (n: number) => ({
  id: `01JTRACESHOT${String(n).padStart(14, "0")}`,
  sha256: `${String(n).padStart(2, "0")}`.repeat(32),
  mime: "image/png",
  bytes: 41_000 + n,
  relPath: `artifacts/${String(n).padStart(2, "0")}/shot-${n}.png`,
});

/** The trace, with every URL under `origin` (so integration tests can point it at a live portal). */
export function partnerTrace(origin = "http://127.0.0.1:4100"): Trace {
  const steps: TraceStep[] = [];
  const form = { ...EMPTY_FORM };
  let url = `${origin}/deals`;
  let ts = 1_793_000_000_000;

  type Extra = Partial<Pick<TraceStep, "target" | "fieldValueAfter" | "tags" | "upload">> & {
    to?: string;
    /** Form changes this action causes (applied after the snapshot is taken). */
    set?: Record<string, string>;
  };
  const act = (action: TraceStep["action"], extra: Extra = {}) => {
    const { to, set, tags, ...rest } = extra;
    const urlBefore = url;
    const urlAfter = to ? `${origin}${to}` : url;
    ts += 650;
    steps.push({
      i: steps.length,
      ts,
      action,
      ...rest,
      formSnapshotBefore: urlBefore.endsWith("/deals/new") ? { ...form } : {},
      urlBefore,
      urlAfter,
      tags: tags ?? [],
      ...(steps.length % 4 === 0 ? { screenshot: SHOT(steps.length) } : {}),
    });
    if (set) Object.assign(form, set);
    url = urlAfter;
  };
  const click = (t: Target, extra: Extra = {}) => {
    const b = t.fingerprint.bbox;
    act({ type: "click", x: Math.round(b.x + b.w / 2), y: Math.round(b.y + b.h / 2) } as CuAction, {
      target: t,
      ...extra,
    });
  };
  const type = (t: Target, text: string, label: string, after: string) =>
    act({ type: "type", text }, { target: t, fieldValueAfter: after, set: { [label]: after } });
  const key = (t: Target | undefined, keys: string[], extra: Extra = {}) =>
    act({ type: "keypress", keys }, { ...(t ? { target: t } : {}), ...extra });

  click(T.registerDeal, { to: "/deals/new", tags: ["navigation"] });
  act({ type: "screenshot" });
  click(T.heading);
  click(T.company, { fieldValueAfter: "" });
  type(T.company, "Jabuticaba Tecnologia Ltda.", "End customer company", "Jabuticaba Tecnologia Ltda.");
  key(T.company, ["TAB"]);
  type(T.website, "jabuticaba.com.br", "Company website", "jabuticaba.com.br");
  click(T.country, { fieldValueAfter: "" });
  type(T.country, "Bra", "Country", "Bra");
  click(T.brazil, { tags: ["option"], set: { Country: "Brazil" } });
  click(T.city, { fieldValueAfter: "" });
  type(T.city, "Sao Paulo", "City", "Sao Paulo");
  act({ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 420 });
  click(T.referral, { fieldValueAfter: "" });
  type(T.referral, "Mariana Costa", "Referral partner", "Mariana Costa");
  key(T.referral, ["CTRL", "A"], { fieldValueAfter: "Mariana Costa" });
  key(T.referral, ["BACKSPACE"], { fieldValueAfter: "", set: { "Referral partner": "" } });
  click(T.contactName, { fieldValueAfter: "" });
  type(T.contactName, "Mariana Costa", "Contact full name", "Mariana Costa");
  click(T.contactEmail, { fieldValueAfter: "" });
  type(T.contactEmail, "mariana.costa@jabuticaba.co", "Contact email", "mariana.costa@jabuticaba.co");
  key(T.contactEmail, ["CTRL", "A"], { fieldValueAfter: "mariana.costa@jabuticaba.co" });
  type(T.contactEmail, "mariana.costa@jabuticaba.com.br", "Contact email", "mariana.costa@jabuticaba.com.br");
  click(T.contactPhone, { fieldValueAfter: "" });
  type(T.contactPhone, "+55 11 98765-4321", "Contact phone", "+55 11 98765-4321");
  click(T.product, { fieldValueAfter: "" });
  click(T.business, { tags: ["option"], set: { Product: "Tidewater Cloud Business" } });
  click(T.seats, { fieldValueAfter: "" });
  type(T.seats, "120", "Seats", "120");
  click(T.estValue, { fieldValueAfter: "" });
  type(T.estValue, "86400", "Estimated value (USD)", "86400");
  click(T.closeDate, { fieldValueAfter: "" });
  type(T.closeDate, "15/03/2027", "Expected close date", "15/03/2027");
  act({ type: "move", x: 700, y: 500 });
  act({ type: "wait" });
  click(T.notes, { fieldValueAfter: "" });
  type(T.notes, "Pilot for the finance team", "Notes", "Pilot for the finance team");
  click(T.consent, {
    fieldValueAfter: "true",
    set: { "The end customer agreed to be contacted by Caravela": "true" },
  });
  click(T.submit, { tags: ["blocked"] });
  act({ type: "fn", name: "request_commit", args: { summary: "Submit the registration" } });
  click(T.submit, { tags: ["commit", "navigation"], to: `/deals/${REG_ID}` });

  return {
    runId: "01JTRACERUN0000000000000001",
    portalId: "partner",
    startUrl: `${origin}/deals`,
    viewport: { w: 1280, h: 800 },
    params: { ...PARTNER_PARAMS },
    steps,
    final: { url: `${origin}/deals/${REG_ID}`, text: confirmationText(), screenshot: SHOT(99) },
    outcome: "done",
  };
}

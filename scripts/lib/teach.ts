// What a good teach model should infer from the Caravela registration recording
// (fixtures/teach/caravela-register-deal.mp4): a SkillDraft plus grading hints.

import { PARTNER_COUNTRIES, PARTNER_PRODUCTS } from "../../apps/portals/src/index.ts";
import type { ParamSpec, SkillDraft } from "../../packages/core/src/contracts/skills.ts";
import { PARTNER_PORTAL_URL, TEACH_DEAL, TEACH_USERNAME } from "./data.ts";

export const TEACH_VIDEO = "fixtures/teach/caravela-register-deal.mp4";
export const TEACH_EXPECTED = "fixtures/teach/caravela-register-deal.expected.json";

interface ParamGrading {
  name: string;
  /** Canonical partner-portal field the param fills. */
  field: string;
  /** Form label shown in the video. */
  label: string;
  /** Other names a grader should accept. */
  aliases: string[];
  observed: string;
}

const PARAMS: (ParamSpec & { grading: Omit<ParamGrading, "name"> })[] = [
  {
    name: "company_name",
    type: "string",
    required: true,
    description: "End customer's legal company name.",
    grading: {
      field: "companyName",
      label: "End customer company",
      aliases: ["company", "end_customer_company", "customer_company", "customer_name", "end_customer"],
      observed: TEACH_DEAL.companyName,
    },
  },
  {
    name: "company_website",
    type: "string",
    required: false,
    description: "End customer's website, without https://.",
    grading: {
      field: "companyWebsite",
      label: "Company website",
      aliases: ["website", "customer_website", "company_url"],
      observed: TEACH_DEAL.companyWebsite,
    },
  },
  {
    name: "country",
    type: "enum",
    required: true,
    description: "End customer's country, picked from the Country combobox.",
    enumValues: [...PARTNER_COUNTRIES],
    grading: {
      field: "country",
      label: "Country",
      aliases: ["customer_country", "company_country"],
      observed: TEACH_DEAL.country,
    },
  },
  {
    name: "city",
    type: "string",
    required: true,
    description: "End customer's city.",
    grading: {
      field: "city",
      label: "City",
      aliases: ["customer_city", "company_city"],
      observed: TEACH_DEAL.city,
    },
  },
  {
    name: "contact_name",
    type: "string",
    required: true,
    description: "Full name of the contact at the end customer.",
    grading: {
      field: "contactName",
      label: "Contact full name",
      aliases: ["contact_full_name", "customer_contact", "contact"],
      observed: TEACH_DEAL.contactName,
    },
  },
  {
    name: "contact_email",
    type: "email",
    required: true,
    description: "Email of the contact at the end customer.",
    grading: {
      field: "contactEmail",
      label: "Contact email",
      aliases: ["email"],
      observed: TEACH_DEAL.contactEmail,
    },
  },
  {
    name: "contact_phone",
    type: "phone",
    required: false,
    description: "Phone of the contact, with country code.",
    grading: {
      field: "contactPhone",
      label: "Contact phone",
      aliases: ["phone", "contact_telephone"],
      observed: TEACH_DEAL.contactPhone,
    },
  },
  {
    name: "product",
    type: "enum",
    required: true,
    description: "Tidewater Cloud plan, picked from the Product combobox.",
    enumValues: [...PARTNER_PRODUCTS],
    grading: {
      field: "product",
      label: "Product",
      aliases: ["plan", "product_name"],
      observed: TEACH_DEAL.product,
    },
  },
  {
    name: "seats",
    type: "number",
    required: true,
    description: "Number of seats, a whole number.",
    grading: {
      field: "seats",
      label: "Seats",
      aliases: ["seat_count", "licenses", "users", "quantity"],
      observed: TEACH_DEAL.seats,
    },
  },
  {
    name: "estimated_value_usd",
    type: "number",
    required: false,
    description: "Estimated deal value in US dollars.",
    grading: {
      field: "estimatedValue",
      label: "Estimated value (USD)",
      aliases: ["estimated_value", "deal_value", "amount", "value_usd"],
      observed: TEACH_DEAL.estimatedValueUsd,
    },
  },
  {
    name: "expected_close_date",
    type: "date",
    required: true,
    description: "Expected close date, typed as DD/MM/YYYY; must be in the future.",
    grading: {
      field: "expectedCloseDate",
      label: "Expected close date",
      aliases: ["close_date", "closing_date", "expected_close"],
      observed: TEACH_DEAL.expectedCloseDate,
    },
  },
  {
    name: "referral_partner",
    type: "string",
    required: false,
    description: "Partner or agent who referred the deal.",
    grading: {
      field: "referralPartner",
      label: "Referral partner",
      aliases: ["referred_by", "partner", "referrer"],
      observed: TEACH_DEAL.referralPartner,
    },
  },
  {
    name: "notes",
    type: "string",
    required: false,
    description: "Free-text notes for Caravela.",
    grading: {
      field: "notes",
      label: "Notes",
      aliases: ["deal_notes", "comments"],
      observed: TEACH_DEAL.notes,
    },
  },
];

function paramSpec(p: (typeof PARAMS)[number]): ParamSpec {
  const { grading: _grading, ...spec } = p;
  return spec;
}

export function teachExpected() {
  const draft: SkillDraft = {
    name: "register_partner_deal",
    title: "Register a partner deal on Caravela Partner Hub",
    portalId: "caravela",
    startUrl: `${PARTNER_PORTAL_URL}/deals/new`,
    goal: "Register an end customer's opportunity with Caravela so Tidewater Cloud gets protected partner pricing, and return the registration ID.",
    steps: [
      "On Deal registrations, click Register a deal.",
      "Type {{company_name}} into End customer company.",
      "Type {{company_website}} into Company website.",
      "Open the Country combobox, type the first letters of {{country}} and pick {{country}}.",
      "Type {{city}} into City.",
      "Type {{contact_name}} into Contact full name.",
      "Type {{contact_email}} into Contact email.",
      "Type {{contact_phone}} into Contact phone.",
      "Open the Product combobox and pick {{product}}.",
      "Type {{seats}} into Seats.",
      "Type {{estimated_value_usd}} into Estimated value (USD).",
      "Type {{expected_close_date}} into Expected close date as DD/MM/YYYY.",
      "Type {{referral_partner}} into Referral partner.",
      "Type {{notes}} into Notes.",
      "Tick 'The end customer agreed to be contacted by Caravela'.",
      "Click Submit registration.",
      "Wait for 'Registration received' and read the Registration ID.",
    ],
    params: PARAMS.map(paramSpec),
    commitStep: "Submit registration",
    success:
      "A 'Registration received' page at /deals/<id> showing a Registration ID like NW-REG-48213 and the status Pending review.",
    observedValues: Object.fromEntries(PARAMS.map((p) => [p.name, p.grading.observed])),
  };
  return {
    fixture: "fixtures/teach/caravela-register-deal.mp4",
    synthetic: true,
    recording: {
      portal: "Caravela Partner Hub",
      portalVersion: "v1",
      mutation: null,
      viewport: { width: 1280, height: 800 },
      signedInAs: TEACH_USERNAME,
      startsOn: "/deals",
      cursorOverlay: "an arrow drawn into the page moves to each target before the click; clicks show a ring",
      addressBar:
        "not visible (viewport-only recording), so startUrl comes from the portal config, not the video",
      maxDurationSeconds: 60,
    },
    draft,
    grading: {
      requiredParams: PARAMS.filter((p) => p.required).map((p) => ({ name: p.name, ...p.grading })),
      optionalParams: PARAMS.filter((p) => !p.required).map((p) => ({ name: p.name, ...p.grading })),
      comboboxParams: ["country", "product"],
      fixedSteps: [
        "Tick the consent checkbox 'The end customer agreed to be contacted by Caravela' (a boolean param named consent is also acceptable).",
      ],
      commitStep: "Submit registration",
      success: {
        textPattern: "Registration received",
        idRegex: "NW-REG-\\d{5}",
        urlPattern: "/deals/NW-REG-\\d{5}",
      },
      observedValuesMustNotReachRuns: true,
    },
  };
}

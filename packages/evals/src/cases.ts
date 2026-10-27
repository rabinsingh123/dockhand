// Eval cases: realistic pt-BR values (accents, long names, local phones, future dates) for every param of a
// skill, and the canonical submission each case must produce. Pure: same arguments, same cases.

import type { EvalCase, EvalSuite, ParamValue, PortalSession, Skill } from "@dockhand/core";
import {
  addDaysIso,
  type CanonicalField,
  MUTATION_OPERATORS,
  type MutationOperator,
  operatorsFor,
} from "@dockhand/portals";
import { base, en, Faker, pt_BR } from "@faker-js/faker";
import { expectedFields, fieldBindings } from "./bindings.ts";
import { FIXTURE_DOCS, fixtureFile } from "./files.ts";
import { type PortalDef, portalOfSkill } from "./portals.ts";

export interface GenerateOptions {
  /** The portal's calendar date (ISO); close dates are generated after it. Default: today, local time. */
  today?: string;
}

type Group = { ui: PortalSession["ui"]; operator: MutationOperator | null };

function localToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const SUITE_SALT: Record<EvalSuite, number> = { replay: 1, mutation: 2, repair: 3, agentic: 4, ablation: 5 };

function categoryOf(op: MutationOperator) {
  return MUTATION_OPERATORS.find((o) => o.id === op)?.category;
}

/** Which UI/mutation combinations a suite covers on this portal. */
function groupsFor(suite: EvalSuite, def: PortalDef): Group[] {
  const ops = operatorsFor(def.kind);
  switch (suite) {
    case "replay":
    case "agentic":
    case "ablation":
      return [{ ui: "v1", operator: null }];
    case "mutation":
      return ops.map((operator) => ({ ui: "v1", operator }));
    case "repair": {
      const healModel = ops.filter((op) => categoryOf(op) === "heal_model");
      return [
        ...(def.hasV2 ? [{ ui: "v2" as const, operator: null }] : []),
        ...healModel.map((operator) => ({ ui: "v1" as const, operator })),
      ];
    }
  }
}

/**
 * `n` cases for replay and agentic; for mutation and repair, ceil(n / groups) seeds per group (every operator
 * that applies to the portal, or v2 plus each heal_model operator), so every group is covered.
 */
export function generateCases(
  suite: EvalSuite,
  skill: Skill,
  n: number,
  seed: number,
  opts: GenerateOptions = {},
): EvalCase[] {
  const def = portalOfSkill(skill);
  const today = opts.today ?? localToday();
  const groups = groupsFor(suite, def);
  const perGroup = groups.length === 1 ? n : Math.max(1, Math.ceil(n / groups.length));
  const cases: EvalCase[] = [];
  groups.forEach((g, gi) => {
    for (let j = 0; j < perGroup; j++) {
      const idx = cases.length;
      const faker = new Faker({ locale: [pt_BR, en, base] });
      faker.seed([seed, SUITE_SALT[suite], gi, j]);
      const params = generateParams(skill, def, faker, today);
      const tag = g.operator ? `${g.operator}-` : g.ui === "v2" ? "v2-" : "";
      const id = `${suite}-${def.key}-s${seed}-${tag}${String(g.operator || g.ui === "v2" ? j : idx).padStart(3, "0")}`;
      const category = g.operator ? categoryOf(g.operator) : undefined;
      cases.push({
        id,
        suite,
        skill: skill.name,
        version: skill.version,
        portalId: def.portalId,
        ...(def.key === "supplier" ? { tenant: "acme" } : {}),
        portal: {
          ui: g.ui,
          mutation: g.operator ? { seed: seed * 1000 + j, operators: [g.operator] } : null,
          runId: id,
        },
        ...(category ? { expectedCategory: category } : {}),
        params,
        expected: expectedFields(skill, def, params),
      });
    }
  });
  return cases;
}

/**
 * Adds the rep's answer for a field the skill has no step for (e.g. the inserted "Partner tier"): askRep
 * answers from it, and the ground truth must then hold it.
 */
export function withRepAnswer(c: EvalCase, field: CanonicalField, answer: string): EvalCase {
  return {
    ...c,
    id: `${c.id}-answered`,
    portal: { ...c.portal, runId: `${c.id}-answered` },
    params: { ...c.params, [answerParamName(field.label)]: answer },
    expected: { ...c.expected, [field.key]: answer },
  };
}

/** The param name askRep looks up for a question about `label` ("Partner tier" -> "partner_tier"). */
export function answerParamName(label: string): string {
  return (
    label
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "answer"
  );
}

// ---------- values ----------

interface Identity {
  company: string;
  legalName: string;
  domain: string;
  people: { first: string; last: string; full: string }[];
}

const ACCENTED_WORDS = [
  "Indústria",
  "Comércio",
  "Logística",
  "Distribuição",
  "Alimentação",
  "Tecnologia",
  "Serviços",
  "Construções",
  "Agropecuária",
  "Educação",
  "Saúde",
  "Mineração",
];
const ACCENTED_CITIES = [
  "São Paulo",
  "Florianópolis",
  "Goiânia",
  "Maceió",
  "Belém",
  "Vitória",
  "São Luís",
  "Ribeirão Preto",
  "Jundiaí",
  "Uberlândia",
  "Cuiabá",
  "Niterói",
  "Petrópolis",
  "Foz do Iguaçu",
];
const LONG_TAILS = [
  "dos Produtores Rurais do Vale do São Francisco",
  "de Soluções Integradas para Gestão Pública e Privada",
  "e Representações Comerciais do Sul de Minas Gerais",
  "de Equipamentos Hospitalares e Laboratoriais do Nordeste",
];
const SUFFIXES = ["Ltda.", "S.A.", "EIRELI", "ME", "Ltda"];
const BANKS = [
  "Banco Exemplo S.A.",
  "Banco Horizonte S.A.",
  "Banco Maré Alta S.A.",
  "Cooperativa de Crédito Ipê",
  "Banco Araucária S.A.",
];
const UFS = ["SP", "RJ", "MG", "PR", "SC", "RS", "BA", "PE", "CE", "GO", "DF", "PA"];
const MIDDLE = ["de", "da", "dos", "e"];

function ascii(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max + 1);
  return cut.slice(0, cut.lastIndexOf(" ")).replace(/[\s,.-]+$/, "");
}

function personOf(f: Faker): Identity["people"][number] {
  const first = f.person.firstName();
  let last = f.person.lastName();
  // One in five has a long, multi-part surname ("Gonçalves de Albuquerque Simões").
  if (f.number.int(4) === 0)
    last = `${last} ${f.helpers.arrayElement(MIDDLE)} ${f.person.lastName()} ${f.person.lastName()}`;
  return { first, last, full: `${first} ${last}` };
}

function identityOf(f: Faker): Identity {
  const roll = f.number.int(9);
  let company = f.company.name().replace(/\s+(LTDA|EIRELI|S\.A\.|e Associados)$/i, "");
  if (roll < 5) company = `${f.helpers.arrayElement(ACCENTED_WORDS)} ${company}`;
  if (roll === 9)
    company = `${f.helpers.arrayElement(ACCENTED_WORDS)} ${company} ${f.helpers.arrayElement(LONG_TAILS)}`;
  const legalName = clip(`${company} ${f.helpers.arrayElement(SUFFIXES)}`, 110);
  const slug = ascii(company).split("-").slice(0, 3).join("-") || "empresa";
  return {
    company: clip(company, 70),
    legalName,
    domain: `${slug}.${f.helpers.arrayElement(["com.br", "com", "net.br", "ind.br"])}`,
    people: [personOf(f), personOf(f), personOf(f), personOf(f)],
  };
}

function emailOf(p: Identity["people"][number], domain: string): string {
  return `${ascii(p.first)}.${ascii(p.last).split("-")[0]}@${domain}`;
}

function phoneOf(f: Faker): string {
  const ddd = f.number.int({ min: 11, max: 99 });
  const body = `9${f.string.numeric(4)}-${f.string.numeric(4)}`;
  return f.helpers.arrayElement([`+55 ${ddd} ${body}`, `(${ddd}) ${body}`, `+55 (${ddd}) ${body}`]);
}

function cityOf(f: Faker): string {
  return f.number.int(1) === 0 ? f.helpers.arrayElement(ACCENTED_CITIES) : clip(f.location.city(), 60);
}

type Gen = (f: Faker, id: Identity, today: string, field: CanonicalField) => ParamValue;

const pick: Gen = (f, _id, _t, field) => f.helpers.arrayElement([...(field.options ?? [])]);

/** Generators by canonical field key (both portals). */
const BY_KEY: Record<string, Gen> = {
  // partner
  companyName: (_f, id) => id.legalName,
  companyWebsite: (f, id) => f.helpers.arrayElement([id.domain, `www.${id.domain}`, `https://${id.domain}`]),
  city: (f) => cityOf(f),
  contactName: (_f, id) => id.people[0]?.full ?? "",
  contactEmail: (_f, id) => emailOf(id.people[0] as Identity["people"][number], id.domain),
  contactPhone: (f) => phoneOf(f),
  seats: (f) =>
    f.number.int(9) === 0 ? f.number.int({ min: 5000, max: 100000 }) : f.number.int({ min: 1, max: 2500 }),
  estimatedValue: (f) =>
    f.number.int(3) === 0
      ? Math.round(f.number.float({ min: 1000, max: 900000 }) * 100) / 100
      : f.number.int({ min: 1, max: 400 }) * 1000,
  expectedCloseDate: (f, _id, today) => addDaysIso(today, f.number.int({ min: 7, max: 365 })),
  referralPartner: (f) =>
    `${f.helpers.arrayElement(["Agência", "Consultoria", "Integração"])} ${f.person.lastName()}`,
  notes: (f, id) =>
    f.helpers.arrayElement([
      `Cliente quer começar com a equipe de ${id.people[1]?.first ?? "operações"}; decisão até o fim do trimestre.`,
      `Concorrência com outro fornecedor. Preço é o critério principal (orçamento já aprovado).`,
      `Expansão para a filial de ${cityOf(f)} após o piloto.`,
    ]),
  // supplier
  legalName: (_f, id) => id.legalName,
  tradeName: (_f, id) => id.company,
  taxId: (f) => `${f.string.numeric(2)}-${f.string.numeric(7)}`,
  stateOfIncorporation: (f) => f.location.state(),
  yearFounded: (f, _id, today) => f.number.int({ min: 1950, max: Number(today.slice(0, 4)) - 1 }),
  website: (_f, id) => `https://${id.domain}`,
  street1: (f) =>
    `${f.helpers.arrayElement(["Rua", "Avenida", "Alameda", "Travessa"])} ${f.person.lastName()}, ${f.number.int({ min: 1, max: 4999 })}`,
  street2: (f) =>
    f.helpers.arrayElement([
      `Conjunto ${f.number.int(200)}`,
      `Sala ${f.number.int(900)}`,
      `${f.number.int(30)}º andar`,
    ]),
  state: (f) => f.helpers.arrayElement(UFS),
  postalCode: (f) => `${f.string.numeric(5)}-${f.string.numeric(3)}`,
  primaryContactName: (_f, id) => id.people[0]?.full ?? "",
  primaryContactTitle: (f) =>
    f.helpers.arrayElement([
      "Diretora Comercial",
      "Gerente de Contas",
      "Head of Partnerships",
      "Coordenador Financeiro",
    ]),
  primaryContactEmail: (_f, id) => emailOf(id.people[0] as Identity["people"][number], id.domain),
  primaryContactPhone: (f) => phoneOf(f),
  arContactName: (_f, id) => id.people[1]?.full ?? "",
  arContactEmail: (f, id) =>
    `${f.helpers.arrayElement(["contas.receber", "financeiro", "faturamento"])}@${id.domain}`,
  arContactPhone: (f) => phoneOf(f),
  salesContactName: (_f, id) => id.people[2]?.full ?? "",
  salesContactEmail: (_f, id) => emailOf(id.people[2] as Identity["people"][number], id.domain),
  bankName: (f) => f.helpers.arrayElement(BANKS),
  accountHolder: (_f, id) => clip(id.legalName.toLocaleUpperCase("pt-BR"), 80),
  accountNumber: (f) => f.string.numeric({ length: { min: 6, max: 12 } }),
  routingNumber: (f) => f.string.numeric(9),
  swiftBic: (f) =>
    `${f.string.alpha({ length: 4, casing: "upper" })}BR${f.string.alphanumeric({ length: 2, casing: "upper" })}`,
  signatoryName: (_f, id) => id.people[3]?.full ?? "",
  signatoryTitle: (f) =>
    f.helpers.arrayElement(["Diretora Financeira", "Chief Financial Officer", "Sócio-administrador"]),
  w9File: () => fixtureFile(FIXTURE_DOCS.w9),
  coiFile: () => fixtureFile(FIXTURE_DOCS.coi),
};

/** Params the URL (not a field) carries. */
const BY_PARAM: Record<string, (f: Faker) => ParamValue> = {
  tenant: () => "acme",
  invite_code: (f) => `ACME-${f.string.numeric(4)}`,
};

function generatorFor(field: CanonicalField): Gen {
  const g = BY_KEY[field.key];
  if (g) return g;
  if (field.type === "combobox" || field.type === "radio") return pick;
  throw new Error(`no value generator for field ${field.key} (${field.type})`);
}

function generateParams(skill: Skill, def: PortalDef, f: Faker, today: string): Record<string, ParamValue> {
  const identity = identityOf(f);
  const { bindings } = fieldBindings(skill, def);
  const params: Record<string, ParamValue> = {};
  for (const spec of skill.params) {
    // Optional params are left out a quarter of the time: the runner must skip their steps.
    if (!spec.required && f.number.int(3) === 0) continue;
    const field = bindings.find((b) => b.params.includes(spec.name))?.field;
    if (field) params[spec.name] = generatorFor(field)(f, identity, today, field);
    else if (BY_PARAM[spec.name]) params[spec.name] = (BY_PARAM[spec.name] as (f: Faker) => ParamValue)(f);
    else throw new Error(`no value generator for param ${spec.name} (it fills no known field)`);
  }
  return params;
}

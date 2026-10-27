// Quotes for Tidewater Cloud (fictional): a synthetic price book, pure pricing, and a one-page PDF.

import { createHash } from "node:crypto";
import type { ArtifactRef, ArtifactStore, Clock, Quote, QuoteRequest, QuoteService } from "@dockhand/core";
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { addDaysIso, todayIso } from "../time.ts";

export type PlanId = "starter" | "business" | "enterprise";

/** QuoteRequest plus an optional plan; without one the plan follows the team size. */
export interface PricedQuoteRequest extends QuoteRequest {
  plan?: PlanId;
}

export interface PricePlan {
  id: PlanId;
  sku: string;
  name: string;
  /** Per seat per month, minor units. */
  monthly: { BRL: number; USD: number };
  includes: { "pt-BR": string[]; en: string[] };
}

export const PRICE_BOOK: Record<PlanId, PricePlan> = {
  starter: {
    id: "starter",
    sku: "TWC-STR",
    name: "Tidewater Cloud Starter",
    monthly: { BRL: 5_900, USD: 1_200 },
    includes: {
      "pt-BR": ["Escalas e ponto digital", "Aplicativo móvel para a equipe", "Suporte por e-mail"],
      en: ["Scheduling and digital timesheets", "Mobile app for the whole team", "Email support"],
    },
  },
  business: {
    id: "business",
    sku: "TWC-BUS",
    name: "Tidewater Cloud Business",
    monthly: { BRL: 11_900, USD: 2_400 },
    includes: {
      "pt-BR": [
        "Tudo do Starter",
        "Login único (SSO) e trilha de auditoria",
        "Integração com folha de pagamento",
        "Suporte em português, SLA de 99,9%",
      ],
      en: [
        "Everything in Starter",
        "Single sign-on (SSO) and audit trail",
        "Payroll integration",
        "Priority support, 99.9% uptime SLA",
      ],
    },
  },
  enterprise: {
    id: "enterprise",
    sku: "TWC-ENT",
    name: "Tidewater Cloud Enterprise",
    monthly: { BRL: 19_900, USD: 3_900 },
    includes: {
      "pt-BR": [
        "Tudo do Business",
        "Gerente de sucesso dedicado",
        "Ambiente de homologação e API dedicada",
        "SLA de 99,95% com créditos",
      ],
      en: [
        "Everything in Business",
        "Dedicated customer success manager",
        "Sandbox environment and dedicated API",
        "99.95% uptime SLA with credits",
      ],
    },
  },
};

/** Volume discount on the subscription line, by seat count (first match wins). */
export const VOLUME_TIERS = [
  { minSeats: 500, pct: 20 },
  { minSeats: 100, pct: 15 },
  { minSeats: 25, pct: 10 },
  { minSeats: 1, pct: 0 },
] as const;

export const TERM_MONTHS = 12;
export const QUOTE_VALID_DAYS = 30;

/** Plan for a team size when the rep did not name one. */
export function defaultPlan(seats: number): PlanId {
  if (seats >= 250) return "enterprise";
  if (seats >= 10) return "business";
  return "starter";
}

/** Matches "Business", "tidewater cloud enterprise", "plano starter"... to a plan id. */
export function planFromText(text: string | null | undefined): PlanId | undefined {
  const t = (text ?? "").toLowerCase();
  if (t.includes("enterprise")) return "enterprise";
  if (t.includes("business")) return "business";
  if (t.includes("starter")) return "starter";
  return undefined;
}

export function volumeDiscountPct(seats: number): number {
  return VOLUME_TIERS.find((t) => seats >= t.minSeats)?.pct ?? 0;
}

/** Pure: same request and day, same quote. */
export function priceQuote(r: PricedQuoteRequest, today: string): Quote {
  if (!Number.isInteger(r.seats) || r.seats < 1)
    throw new RangeError(`seats must be a positive integer, got ${r.seats}`);
  const plan = PRICE_BOOK[r.plan ?? defaultPlan(r.seats)];
  const annualPerSeat = plan.monthly[r.currency] * TERM_MONTHS;
  const subtotal = annualPerSeat * r.seats;
  const pct = volumeDiscountPct(r.seats);
  const lines: Quote["lines"] = [
    {
      sku: plan.sku,
      description: `${plan.name} (${TERM_MONTHS} months, per seat)`,
      qty: r.seats,
      unitMinor: annualPerSeat,
      totalMinor: subtotal,
    },
  ];
  if (pct > 0) {
    const discount = -Math.round((subtotal * pct) / 100);
    lines.push({
      sku: `VOL-${pct}`,
      description: `Volume discount ${pct}% (${r.seats} seats)`,
      qty: 1,
      unitMinor: discount,
      totalMinor: discount,
    });
  }
  const digest = createHash("sha256")
    .update([r.company.trim().toLowerCase(), r.seats, r.startDate, r.currency, plan.id].join("|"))
    .digest("hex")
    .slice(0, 4)
    .toUpperCase();
  return {
    number: `TWC-${today.replaceAll("-", "")}-${digest}`,
    validUntil: addDaysIso(today, QUOTE_VALID_DAYS),
    currency: r.currency,
    totalMinor: lines.reduce((sum, l) => sum + l.totalMinor, 0),
    lines,
  };
}

// ---------- formatting ----------

export function formatMoney(minor: number, currency: string, language: QuoteRequest["language"]): string {
  return new Intl.NumberFormat(language === "pt-BR" ? "pt-BR" : "en-US", { style: "currency", currency })
    .format(minor / 100)
    .replace(/[  ]/g, " ");
}

export function formatDate(iso: string, language: QuoteRequest["language"]): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  return language === "pt-BR"
    ? new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(date)
    : new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        month: "long",
        day: "numeric",
        year: "numeric",
      }).format(date);
}

const TEXT = {
  "pt-BR": {
    title: "Proposta comercial",
    number: "Proposta",
    date: "Data",
    validUntil: "Válida até",
    billTo: "Cliente",
    description: "Descrição",
    qty: "Qtd.",
    unit: "Preço unitário",
    total: "Total",
    grandTotal: "Total do contrato (12 meses)",
    monthly: "Equivalente mensal",
    includes: "Inclui",
    terms: (start: string) =>
      `Início em ${start}. Prazo de 12 meses, cobrança mensal. Valores sem impostos. Proposta sujeita a aprovação de crédito.`,
    footer: "Tidewater Cloud é uma empresa fictícia. Documento de demonstração.",
  },
  en: {
    title: "Quote",
    number: "Quote",
    date: "Date",
    validUntil: "Valid until",
    billTo: "Customer",
    description: "Description",
    qty: "Qty",
    unit: "Unit price",
    total: "Total",
    grandTotal: "Contract total (12 months)",
    monthly: "Monthly equivalent",
    includes: "Includes",
    terms: (start: string) =>
      `Starts ${start}. 12-month term, billed monthly. Prices exclude taxes. Subject to credit approval.`,
    footer: "Tidewater Cloud is a fictional company. Demo document.",
  },
} as const;

/** Line descriptions in the quote's language. */
function lineDescription(sku: string, description: string, language: QuoteRequest["language"]): string {
  if (language !== "pt-BR") return description;
  const plan = Object.values(PRICE_BOOK).find((p) => p.sku === sku);
  if (plan) return `${plan.name} (12 meses, por usuário)`;
  const vol = /^VOL-(\d+)$/.exec(sku);
  if (vol) return `Desconto por volume de ${vol[1]}%`;
  return description;
}

// ---------- PDF ----------

const INK = rgb(0.07, 0.13, 0.2);
const MUTED = rgb(0.42, 0.47, 0.53);
const BRAND = rgb(0.04, 0.19, 0.28);
const ACCENT = rgb(0.0, 0.55, 0.6);
const RULE = rgb(0.86, 0.89, 0.92);

export async function renderQuotePdf(q: Quote, r: QuoteRequest, createdAtMs: number): Promise<Uint8Array> {
  const t = TEXT[r.language];
  const doc = await PDFDocument.create();
  doc.setTitle(`${t.title} ${q.number}`);
  doc.setAuthor("Tidewater Cloud");
  doc.setCreator("Dockhand");
  doc.setProducer("Dockhand");
  doc.setCreationDate(new Date(createdAtMs));
  doc.setModificationDate(new Date(createdAtMs));
  const page = doc.addPage([595.28, 841.89]); // A4
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();
  const left = 48;
  const right = width - 48;
  const today = todayIso(createdAtMs, "America/Sao_Paulo");

  // Header band
  page.drawRectangle({ x: 0, y: height - 96, width, height: 96, color: BRAND });
  text(page, bold, "Tidewater Cloud", left, height - 56, 22, rgb(1, 1, 1));
  text(page, regular, "Workforce cloud for growing teams", left, height - 76, 10, rgb(0.78, 0.86, 0.9));
  textRight(page, bold, t.title.toUpperCase(), right, height - 56, 14, rgb(1, 1, 1));
  textRight(page, regular, q.number, right, height - 76, 10, rgb(0.78, 0.86, 0.9));

  // Meta and customer
  let y = height - 140;
  text(page, bold, t.billTo, left, y, 9, MUTED);
  text(page, bold, r.company, left, y - 18, 14, INK);
  text(page, regular, [r.city, r.country].filter(Boolean).join(", "), left, y - 34, 10, MUTED);
  const meta: [string, string][] = [
    [t.number, q.number],
    [t.date, formatDate(today, r.language)],
    [t.validUntil, formatDate(q.validUntil, r.language)],
  ];
  meta.forEach(([label, value], i) => {
    textRight(page, regular, `${label}: ${value}`, right, y - i * 16, 10, i === 0 ? INK : MUTED);
  });

  // Table
  y -= 80;
  const cols = { desc: left, qty: 345, unit: 450, total: right };
  page.drawRectangle({
    x: left - 8,
    y: y - 8,
    width: right - left + 16,
    height: 26,
    color: rgb(0.95, 0.97, 0.98),
  });
  text(page, bold, t.description, cols.desc, y, 9, MUTED);
  textRight(page, bold, t.qty, cols.qty, y, 9, MUTED);
  textRight(page, bold, t.unit, cols.unit, y, 9, MUTED);
  textRight(page, bold, t.total, cols.total, y, 9, MUTED);
  y -= 30;
  for (const line of q.lines) {
    text(page, regular, lineDescription(line.sku, line.description, r.language), cols.desc, y, 10, INK, 265);
    textRight(page, regular, String(line.qty), cols.qty, y, 10, INK);
    textRight(page, regular, formatMoney(line.unitMinor, q.currency, r.language), cols.unit, y, 10, INK);
    textRight(page, regular, formatMoney(line.totalMinor, q.currency, r.language), cols.total, y, 10, INK);
    y -= 22;
    page.drawLine({
      start: { x: left - 8, y: y + 10 },
      end: { x: right + 8, y: y + 10 },
      thickness: 0.6,
      color: RULE,
    });
  }

  // Totals
  y -= 14;
  text(page, bold, t.grandTotal, cols.desc, y, 12, INK);
  textRight(page, bold, formatMoney(q.totalMinor, q.currency, r.language), cols.total, y, 14, ACCENT);
  y -= 20;
  text(page, regular, t.monthly, cols.desc, y, 10, MUTED);
  textRight(
    page,
    regular,
    formatMoney(Math.round(q.totalMinor / TERM_MONTHS), q.currency, r.language),
    cols.total,
    y,
    10,
    MUTED,
  );

  // What the plan includes
  const plan = Object.values(PRICE_BOOK).find((p) => q.lines.some((l) => l.sku === p.sku));
  if (plan) {
    y -= 44;
    text(page, bold, `${t.includes}: ${plan.name}`, left, y, 11, INK);
    for (const item of plan.includes[r.language]) {
      y -= 18;
      page.drawCircle({ x: left + 3, y: y + 3.5, size: 2, color: ACCENT });
      text(page, regular, item, left + 14, y, 10, INK);
    }
  }

  // Terms and footer
  y -= 40;
  for (const line of wrap(regular, t.terms(formatDate(r.startDate, r.language)), 10, right - left)) {
    text(page, regular, line, left, y, 10, MUTED);
    y -= 15;
  }
  page.drawLine({ start: { x: left, y: 64 }, end: { x: right, y: 64 }, thickness: 0.6, color: RULE });
  text(page, regular, t.footer, left, 48, 8, MUTED);
  textRight(page, regular, "tidewater.example", right, 48, 8, MUTED);

  return doc.save();
}

/** Standard fonts encode WinAnsi only: map spaces, drop what cannot be drawn, truncate to a width. */
function drawable(font: PDFFont, s: string, size: number, maxWidth?: number): string {
  let out = "";
  for (const ch of s.replace(/[   ]/g, " ")) {
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  if (maxWidth === undefined || font.widthOfTextAtSize(out, size) <= maxWidth) return out;
  while (out.length > 1 && font.widthOfTextAtSize(`${out}...`, size) > maxWidth) out = out.slice(0, -1);
  return `${out}...`;
}

function wrap(font: PDFFont, s: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of drawable(font, s, size).split(" ")) {
    const next = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(next, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

function text(
  page: PDFPage,
  font: PDFFont,
  s: string,
  x: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
  maxWidth?: number,
): void {
  page.drawText(drawable(font, s, size, maxWidth), { x, y, size, font, color });
}

function textRight(
  page: PDFPage,
  font: PDFFont,
  s: string,
  right: number,
  y: number,
  size: number,
  color: ReturnType<typeof rgb>,
): void {
  const safe = drawable(font, s, size);
  page.drawText(safe, { x: right - font.widthOfTextAtSize(safe, size), y, size, font, color });
}

// ---------- service ----------

export interface QuoteServiceDeps {
  artifacts: ArtifactStore;
  clock: Clock;
  /** Replaces the pdf-lib renderer (tests). */
  renderPdf?: (q: Quote, r: QuoteRequest) => Promise<Uint8Array>;
  tz?: string;
}

export function createQuoteService(deps: QuoteServiceDeps): QuoteService {
  const tz = deps.tz ?? "America/Sao_Paulo";
  return {
    price: (r) => priceQuote(r, todayIso(deps.clock.now(), tz)),
    async renderPdf(q, r): Promise<ArtifactRef> {
      const bytes = deps.renderPdf
        ? await deps.renderPdf(q, r)
        : await renderQuotePdf(q, r, deps.clock.now());
      return deps.artifacts.put(bytes, "application/pdf", {
        kind: "quote_pdf",
        filename: quoteFilename(q, r),
      });
    },
  };
}

export function quoteFilename(q: Quote, r: QuoteRequest): string {
  const company = r.company
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${q.number}-${company || "quote"}.pdf`;
}

import { createFixedClock, createMemoryArtifactStore, type QuoteRequest } from "@dockhand/core";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import {
  createQuoteService,
  defaultPlan,
  formatDate,
  formatMoney,
  planFromText,
  priceQuote,
  quoteFilename,
  volumeDiscountPct,
} from "./quotes.ts";

const REQ: QuoteRequest = {
  company: "Sabiá Foods Ltda.",
  city: "São Paulo",
  country: "Brazil",
  seats: 25,
  startDate: "2027-01-01",
  currency: "BRL",
  language: "pt-BR",
};

describe("pricing", () => {
  it("prices Business for 25 seats in BRL with the 10% volume tier", () => {
    const q = priceQuote(REQ, "2026-10-27");
    expect(q.lines).toEqual([
      {
        sku: "TWC-BUS",
        description: "Tidewater Cloud Business (12 months, per seat)",
        qty: 25,
        unitMinor: 11_900 * 12,
        totalMinor: 11_900 * 12 * 25,
      },
      {
        sku: "VOL-10",
        description: "Volume discount 10% (25 seats)",
        qty: 1,
        unitMinor: -357_000,
        totalMinor: -357_000,
      },
    ]);
    expect(q.totalMinor).toBe(3_570_000 - 357_000);
    expect(q.currency).toBe("BRL");
    expect(q.validUntil).toBe("2026-11-26");
    expect(q.number).toMatch(/^TWC-20261027-[0-9A-F]{4}$/);
  });

  it("is deterministic for the same request and day", () => {
    expect(priceQuote(REQ, "2026-10-27")).toEqual(priceQuote(REQ, "2026-10-27"));
    expect(priceQuote({ ...REQ, seats: 26 }, "2026-10-27").number).not.toBe(
      priceQuote(REQ, "2026-10-27").number,
    );
  });

  it("picks volume tiers and default plans by seat count", () => {
    expect([1, 24, 25, 99, 100, 499, 500].map(volumeDiscountPct)).toEqual([0, 0, 10, 10, 15, 15, 20]);
    expect([3, 10, 249, 250].map(defaultPlan)).toEqual(["starter", "business", "business", "enterprise"]);
    expect(planFromText("Plano Enterprise")).toBe("enterprise");
    expect(planFromText(null)).toBeUndefined();
  });

  it("prices USD and an explicit plan", () => {
    const q = priceQuote(
      { ...REQ, currency: "USD", language: "en", seats: 5, plan: "enterprise" },
      "2026-10-27",
    );
    expect(q.lines).toHaveLength(1);
    expect(q.totalMinor).toBe(3_900 * 12 * 5);
  });

  it("rejects a non-positive seat count", () => {
    expect(() => priceQuote({ ...REQ, seats: 0 }, "2026-10-27")).toThrow(RangeError);
  });
});

describe("formatting", () => {
  it("formats pt-BR and en money and dates", () => {
    expect(formatMoney(3_213_000, "BRL", "pt-BR")).toBe("R$ 32.130,00");
    expect(formatMoney(120_000, "USD", "en")).toBe("$1,200.00");
    expect(formatDate("2027-01-01", "pt-BR")).toBe("01/01/2027");
    expect(formatDate("2027-01-01", "en")).toBe("January 1, 2027");
  });

  it("builds a safe filename", () => {
    expect(quoteFilename(priceQuote(REQ, "2026-10-27"), REQ)).toMatch(
      /^TWC-20261027-[0-9A-F]{4}-Sabia-Foods-Ltda\.pdf$/,
    );
  });
});

describe("quote service", () => {
  it("renders a one-page PDF into the artifact store", async () => {
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 15, 0, 0));
    const artifacts = createMemoryArtifactStore(clock);
    const quotes = createQuoteService({ artifacts, clock });
    const q = quotes.price(REQ);
    const ref = await quotes.renderPdf(q, REQ);
    expect(ref.mime).toBe("application/pdf");
    const bytes = await artifacts.read(ref);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe(`Proposta comercial ${q.number}`);
  });

  it("draws names WinAnsi cannot encode instead of throwing", async () => {
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 15, 0, 0));
    const quotes = createQuoteService({ artifacts: createMemoryArtifactStore(clock), clock });
    const r: QuoteRequest = { ...REQ, company: "Kaveri Looms 🧵 कावेरी", language: "en", currency: "USD" };
    await expect(quotes.renderPdf(quotes.price(r), r)).resolves.toMatchObject({ mime: "application/pdf" });
  });

  it("renders the same bytes for the same quote and clock", async () => {
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 15, 0, 0));
    const artifacts = createMemoryArtifactStore(clock);
    const quotes = createQuoteService({ artifacts, clock });
    const q = quotes.price(REQ);
    const a = await quotes.renderPdf(q, REQ);
    const b = await quotes.renderPdf(q, REQ);
    expect(a.sha256).toBe(b.sha256);
  });
});

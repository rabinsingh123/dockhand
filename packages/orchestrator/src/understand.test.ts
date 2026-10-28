import { describe, expect, it } from "vitest";
import { receiptCaption, receiptHtml, seconds, usd } from "./tools/receipts.ts";
import { blankUnderstanding, normalizeUnderstanding, understandingRequest } from "./understand.ts";

describe("understanding request", () => {
  it("tells the model today's date in the rep's time zone and lists known skills", () => {
    // 01:30 UTC on Oct 28 is still Oct 27 in São Paulo.
    const req = understandingRequest({
      rep: { tz: "America/Sao_Paulo" },
      nowMs: Date.UTC(2026, 9, 28, 1, 30),
      inputs: [{ kind: "voice", text: "pricing for 25 people starting January" }],
      skills: [
        {
          name: "register_partner_deal",
          title: "Register a deal",
          params: [{ name: "seats", type: "number", required: true, description: "" }],
        },
      ],
    });
    expect(req.instructions).toContain("Today is Tue 2026-10-27 in America/Sao_Paulo");
    expect(req.model).toBe("muse-spark-1.3");
    expect(req.effort).toBe("low");
    const text = req.input[0]?.type === "text" ? req.input[0].text : "";
    expect(text).toContain("register_partner_deal (Register a deal); params: seats: number");
    expect(text).toContain("[1] Voice note (transcript): pricing for 25 people starting January");
  });
});

describe("normalizeUnderstanding", () => {
  it("nulls malformed values and canonicalizes the rest", () => {
    const u = normalizeUnderstanding({
      ...blankUnderstanding("register_deal"),
      company: "  Café Aurora ",
      country: "Brasil",
      seats: 0,
      closeDate: "29/01/2027",
      startDate: "2027-01-01",
      contactEmail: "julia at cafeaurora",
      inviteCode: "acme-7731",
      tenant: "ACME",
      estValue: -5,
      missing: [" seats ", ""],
    });
    expect(u).toMatchObject({
      company: "Café Aurora",
      country: "Brazil",
      seats: null,
      closeDate: null,
      startDate: "2027-01-01",
      contactEmail: null,
      inviteCode: "ACME-7731",
      tenant: "acme",
      estValue: null,
      missing: ["seats"],
    });
  });
});

describe("receipts", () => {
  const view = {
    title: "Register a partner deal",
    tier: "replay" as const,
    headline: "NW-REG-48219",
    lines: ["Submitted <after> approval"],
    seconds: 6.42,
    execCostUsd: 0,
    intakeCostUsd: 0.0041,
    skill: { name: "register_partner_deal", version: 2 },
    verified: { matched: 12, checked: 12 },
  };

  it("shows execution and intake cost separately, escapes text, credits Spark Open only when used", () => {
    const html = receiptHtml(view);
    expect(html).toContain("$0.00");
    expect(html).toContain("$0.004");
    expect(html).toContain("12/12");
    expect(html).toContain("Submitted &#60;after&#62; approval");
    expect(html).not.toContain("Built with Muse Spark Open");
    expect(receiptHtml({ ...view, usedOpenWeights: true })).toContain("Built with Muse Spark Open");
  });

  it("captions the receipt with the same facts", () => {
    const caption = receiptCaption(
      {
        jobId: "J",
        ...view,
        lines: ["NW-REG-48219"],
        image: { id: "I", sha256: "", mime: "image/png", bytes: 1, relPath: "" },
      },
      true,
    );
    expect(caption.split("\n")).toEqual([
      "*Register a partner deal*",
      "`NW-REG-48219`",
      "Replay · compiled skill · 6.4 s",
      "12/12 fields verified · register_partner_deal v2",
      "Cost: execution $0.00 + intake $0.004",
      "Built with Muse Spark Open",
    ]);
  });

  it("formats money and time the same way everywhere", () => {
    expect([0, 0.00004, 0.0041, 0.0149, 1.5].map(usd)).toEqual([
      "$0.00",
      "<$0.001",
      "$0.004",
      "$0.01",
      "$1.50",
    ]);
    expect([0.04, 3.12, 59.96, 125].map(seconds)).toEqual(["0.0 s", "3.1 s", "1 min 0 s", "2 min 5 s"]);
  });
});

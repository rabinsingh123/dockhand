import type { ParamValue } from "@dockhand/core";
import { describe, expect, it } from "vitest";
import {
  matchValue,
  parseNumberCandidates,
  parseTemplate,
  renameTemplateParams,
  renderRegexTemplate,
  renderTemplate,
  renderUrlTemplate,
  templateParams,
  templateUrl,
  templateValue,
  valuesEquivalent,
} from "./template.ts";

const params: Record<string, ParamValue> = {
  company: "Jabuticaba Tecnologia Ltda.",
  city: "São Paulo",
  close_date: "2027-03-15",
  seats: 120000,
  est_value: 1234.56,
  phone: "+5511987654321",
  tenant: "acme",
  invite_code: "ACME-7731",
  consent: true,
  w9: {
    file: { id: "a1", sha256: "x", mime: "application/pdf", bytes: 10, relPath: "ab/x.pdf" },
    filename: "w9.pdf",
  },
};

describe("renderTemplate", () => {
  it.each([
    ["{{company}}", "Jabuticaba Tecnologia Ltda."],
    ["{{close_date|date:DD/MM/YYYY}}", "15/03/2027"],
    ["{{close_date|date:MM/DD/YYYY}}", "03/15/2027"],
    ["{{close_date|date:YYYY-MM-DD}}", "2027-03-15"],
    ["{{seats|number:pt-BR}}", "120.000"],
    ["{{seats|number:en-US}}", "120,000"],
    ["{{est_value|number:pt-BR}}", "1.234,56"],
    ["{{est_value|number:en-US}}", "1,234.56"],
    ["{{seats}}", "120000"],
    ["{{consent}}", "true"],
    ["{{w9}}", "w9.pdf"],
    ["Deal for {{company}} in {{city}}", "Deal for Jabuticaba Tecnologia Ltda. in São Paulo"],
    ["no placeholders", "no placeholders"],
  ])("%s -> %s", (t, expected) => {
    expect(renderTemplate(t, params)).toBe(expected);
  });

  it("pads non-integer decimals to two places", () => {
    expect(renderTemplate("{{x|number:pt-BR}}", { x: 1234.5 })).toBe("1.234,50");
    expect(renderTemplate("{{x|number:en-US}}", { x: "-9876543.1" })).toBe("-9,876,543.10");
  });

  it("throws NEEDS_INPUT for a missing param", () => {
    expect(() => renderTemplate("{{nope}}", params)).toThrow(
      expect.objectContaining({ code: "NEEDS_INPUT" }),
    );
  });

  it("throws ASSERT_FAILED for a value that does not fit the filter", () => {
    expect(() => renderTemplate("{{company|date:DD/MM/YYYY}}", params)).toThrow(
      expect.objectContaining({ code: "ASSERT_FAILED" }),
    );
    expect(() => renderTemplate("{{city|number:pt-BR}}", params)).toThrow(
      expect.objectContaining({ code: "ASSERT_FAILED" }),
    );
  });

  it.each(["{{Company}}", "{{company|upper}}", "{{company|date:DD-MM-YYYY}}", "{{company|number:fr-FR}}"])(
    "rejects %s (outside the grammar)",
    (t) => {
      expect(() => parseTemplate(t)).toThrow(expect.objectContaining({ code: "ASSERT_FAILED" }));
    },
  );

  it("encodes values for URLs and escapes them for regexes", () => {
    expect(renderUrlTemplate("/t/{{x}}/invite", { x: "acme group" })).toBe("/t/acme%20group/invite");
    expect(renderRegexTemplate("Deal for {{x}}", { x: "A.B (1)" })).toBe("Deal for A\\.B \\(1\\)");
  });

  it("lists and renames params, keeping filters", () => {
    expect(templateParams("{{a}} {{b|number:pt-BR}} {{a}}")).toEqual(["a", "b"]);
    expect(renameTemplateParams("{{a|date:DD/MM/YYYY}} and {{b}}", { a: "close_date" })).toBe(
      "{{close_date|date:DD/MM/YYYY}} and {{b}}",
    );
  });
});

describe("matchValue", () => {
  const cases: [
    string,
    string,
    Record<string, ParamValue>,
    { param: string; filter: string | null; match: string }[],
  ][] = [
    [
      "date DD/MM",
      "15/03/2027",
      { d: "2027-03-15" },
      [{ param: "d", filter: "date:DD/MM/YYYY", match: "exact" }],
    ],
    [
      "date MM/DD",
      "03/15/2027",
      { d: "2027-03-15" },
      [{ param: "d", filter: "date:MM/DD/YYYY", match: "exact" }],
    ],
    [
      "ISO date prefers the plain placeholder",
      "2027-03-15",
      { d: "2027-03-15" },
      [
        { param: "d", filter: null, match: "exact" },
        { param: "d", filter: "date:YYYY-MM-DD", match: "exact" },
      ],
    ],
    [
      "ambiguous day/month",
      "03/03/2027",
      { d: "2027-03-03" },
      [
        { param: "d", filter: "date:DD/MM/YYYY", match: "exact" },
        { param: "d", filter: "date:MM/DD/YYYY", match: "exact" },
      ],
    ],
    [
      "loose date",
      "5/3/2027",
      { d: "2027-03-05" },
      [{ param: "d", filter: "date:DD/MM/YYYY", match: "normalized" }],
    ],
    ["pt-BR thousands", "120.000", { n: 120000 }, [{ param: "n", filter: "number:pt-BR", match: "exact" }]],
    ["pt-BR decimals", "1.234,56", { n: 1234.56 }, [{ param: "n", filter: "number:pt-BR", match: "exact" }]],
    ["en-US thousands", "120,000", { n: 120000 }, [{ param: "n", filter: "number:en-US", match: "exact" }]],
    ["plain number", "120000", { n: 120000 }, [{ param: "n", filter: null, match: "exact" }]],
    [
      "numeric string param",
      "120.000",
      { n: "120000" },
      [{ param: "n", filter: "number:pt-BR", match: "exact" }],
    ],
    [
      "pt-BR money with cents",
      "18.000,00",
      { n: 18000 },
      [{ param: "n", filter: "number:pt-BR", match: "normalized" }],
    ],
    [
      "currency symbol",
      "R$ 18.000",
      { n: 18000 },
      [{ param: "n", filter: "number:pt-BR", match: "normalized" }],
    ],
    [
      "phone digits",
      "+55 11 98765-4321",
      { p: "+5511987654321" },
      [{ param: "p", filter: null, match: "normalized" }],
    ],
    [
      "phone without country code",
      "(11) 98765-4321",
      { p: "+55 11 98765 4321" },
      [{ param: "p", filter: null, match: "normalized" }],
    ],
    ["accents", "Sao Paulo", { c: "São Paulo" }, [{ param: "c", filter: null, match: "normalized" }]],
    ["case", "ACME LTDA", { c: "Acme Ltda" }, [{ param: "c", filter: null, match: "normalized" }]],
    [
      "option name",
      "Tidewater Cloud Business",
      { p: "tidewater cloud business" },
      [{ param: "p", filter: null, match: "normalized" }],
    ],
    [
      "email case",
      "Mariana@Example.com",
      { e: "mariana@example.com" },
      [{ param: "e", filter: null, match: "normalized" }],
    ],
    ["boolean", "true", { b: true }, [{ param: "b", filter: null, match: "exact" }]],
    ["no match", "Referral", { c: "São Paulo", n: 5 }, []],
    ["empty", "", { c: "" }, []],
    ["different number", "120.001", { n: 120000 }, []],
    ["different date", "16/03/2027", { d: "2027-03-15" }, []],
    ["short digits are not phones", "4321", { p: "+5511987654321" }, []],
  ];

  it.each(cases)("%s", (_name, raw, p, expected) => {
    expect(matchValue(raw, p).map(({ param, filter, match }) => ({ param, filter, match }))).toEqual(
      expected,
    );
  });

  it("returns bindings for every param sharing the value", () => {
    const b = matchValue("Ana Souza", { contact_name: "Ana Souza", signer_name: "Ana Souza" });
    expect(b.map((x) => x.param)).toEqual(["contact_name", "signer_name"]);
  });

  it("never matches file params", () => {
    expect(matchValue("w9.pdf", { w9: params.w9 as ParamValue })).toEqual([]);
  });
});

describe("templateValue", () => {
  it("uses the placeholder's date format when the day is ambiguous", () => {
    expect(templateValue("03/04/2027", { d: "2027-04-03" }).template).toBe("{{d|date:DD/MM/YYYY}}");
    expect(templateValue("03/03/2027", { d: "2027-03-03" }, { formatHint: "mm/dd/yyyy" }).template).toBe(
      "{{d|date:MM/DD/YYYY}}",
    );
  });

  it("prefers the param named like the field and reports the alternatives", () => {
    const r = templateValue(
      "ana@x.example",
      { contact_email: "ana@x.example", notification_email: "ana@x.example" },
      { label: "Notification email" },
    );
    expect(r.template).toBe("{{notification_email}}");
    expect(r.alternatives.map((a) => a.param)).toEqual(["contact_email"]);
  });

  it("keeps a literal when nothing matches", () => {
    expect(templateValue("Referral", params)).toEqual({
      template: "Referral",
      binding: null,
      alternatives: [],
    });
  });
});

describe("templateUrl", () => {
  it.each([
    [
      "http://127.0.0.1:4100/t/acme/invite/ACME-7731",
      "http://127.0.0.1:4100/t/{{tenant}}/invite/{{invite_code}}",
    ],
    ["/t/acme/register/company", "/t/{{tenant}}/register/company"],
    ["http://h:1/deals/new?tenant=acme#top", "http://h:1/deals/new?tenant={{tenant}}#top"],
    ["http://h:1/deals/new", "http://h:1/deals/new"],
  ])("%s", (url, expected) => {
    expect(templateUrl(url, params).template).toBe(expected);
  });

  it("renders back to the original URL", () => {
    const url = "http://127.0.0.1:4100/t/acme/invite/ACME-7731";
    expect(renderUrlTemplate(templateUrl(url, params).template, params)).toBe(url);
  });
});

describe("valuesEquivalent", () => {
  it.each([
    ["São Paulo", "sao paulo", true],
    ["Brazil", "Brazil", true],
    ["18000", "18,000.00", true],
    ["120000", "120.000", true],
    ["+5511987654321", "+55 (11) 98765-4321", true],
    ["São Paulo", "Rio de Janeiro", false],
    ["18000", "18001", false],
    ["+5511987654321", "+55 (11) 98765-4320", false],
    ["Gold", "", false],
  ])("%s vs %s -> %s", (a, b, expected) => {
    expect(valuesEquivalent(a, b)).toBe(expected);
  });
});

describe("parseNumberCandidates", () => {
  it.each([
    ["120.000", [120, 120000]],
    ["1.234,56", [1234.56]],
    ["1,234.56", [1234.56]],
    ["1,234", [1.234, 1234]],
    ["abc", []],
  ])("%s", (raw, values) => {
    expect(parseNumberCandidates(raw).map((c) => c.value)).toEqual(values);
  });
});

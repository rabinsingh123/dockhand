// Supplier params from the company profile: a compiled skill names its values freely, so a renamed value is found by
// the example its first run recorded, even when two profile fields hold that same value.

import { describe, expect, it } from "vitest";
import { paramsFromProfile } from "./params.ts";

const ctx = { tenant: "globex", inviteCode: "INV-1", files: {} };
const spec = (name: string, example?: string) => ({
  name,
  type: "string" as const,
  required: true,
  description: name,
  ...(example ? { example } : {}),
});

describe("paramsFromProfile", () => {
  const profile = {
    city: "São Paulo",
    stateOfIncorporation: "São Paulo",
    legalName: "Tidewater Cloud Ltda.",
  };

  it("matches by name, and by example after a rename", () => {
    const m = paramsFromProfile(
      [spec("legal_name"), spec("business_name", "Tidewater Cloud Ltda.")],
      profile,
      ctx,
    );
    expect(m.missing).toEqual([]);
    expect(m.params).toMatchObject({
      legal_name: "Tidewater Cloud Ltda.",
      business_name: "Tidewater Cloud Ltda.",
    });
  });

  it("finds a renamed value that two profile fields share", () => {
    const m = paramsFromProfile([spec("business_city", "São Paulo")], profile, ctx);
    expect(m.missing).toEqual([]);
    expect(m.params.business_city).toBe("São Paulo");
  });

  it("still reports a value the profile no longer holds", () => {
    const m = paramsFromProfile([spec("business_city", "Recife")], profile, ctx);
    expect(m.missing.map((s) => s.name)).toEqual(["business_city"]);
  });
});

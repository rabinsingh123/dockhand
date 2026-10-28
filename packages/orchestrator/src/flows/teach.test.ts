import type { SkillDraft } from "@dockhand/core";
import { type PortalHandle, startPartnerPortal } from "@dockhand/portals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PORTAL_DEFAULTS, type PortalDirectory } from "../portals.ts";
import { reachableStart } from "./teach.ts";

let partner: PortalHandle;
let portals: PortalDirectory;

beforeAll(async () => {
  partner = await startPartnerPortal({ port: 0, latencyMs: [0, 0] });
  portals = {
    caravela: {
      ...(PORTAL_DEFAULTS.caravela as (typeof PORTAL_DEFAULTS)[string]),
      url: partner.url,
      session: async () => [],
      writeGuardAllow: [],
    },
  };
});
afterAll(async () => {
  await partner?.close();
});

const draft = (startUrl: string): SkillDraft => ({
  name: "register_deal",
  title: "Register a deal",
  portalId: "caravela",
  startUrl,
  goal: "Register the deal.",
  steps: [],
  params: [],
  commitStep: "Submit registration",
  success: "Registration received",
});

describe("reachableStart", () => {
  it("replaces a start path the portal does not have (live Wonder guessed /deal-registrations)", async () => {
    expect((await reachableStart(draft(`${partner.url}/deal-registrations`), portals)).startUrl).toBe(
      `${partner.url}/deals/new`,
    );
  });

  it("keeps a start page that exists", async () => {
    expect((await reachableStart(draft(`${partner.url}/deals`), portals)).startUrl).toBe(
      `${partner.url}/deals`,
    );
  });
});

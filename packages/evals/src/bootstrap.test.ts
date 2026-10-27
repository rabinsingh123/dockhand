// Bootstrap without any Meta model: scripted computer use through the real loop, compiled, cached.

import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PortalHandle } from "@dockhand/portals";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fieldBindings } from "./bindings.ts";
import { bootstrapSkill, skillCachePath } from "./bootstrap.ts";
import { PORTALS } from "./portals.ts";

let portal: PortalHandle;
const cacheDir = mkdtempSync(join(tmpdir(), "dockhand-eval-skills-"));

beforeAll(async () => {
  portal = await PORTALS.caravela.start({ latencyMs: [10, 30] });
});
afterAll(async () => {
  await portal?.close();
});

describe("bootstrapSkill", () => {
  it("records the Caravela deal with the scripted model, compiles it unannotated, and caches it", async () => {
    const skill = await bootstrapSkill("caravela", { portal, cacheDir });
    expect(existsSync(skillCachePath("caravela", cacheDir))).toBe(true);
    expect(skill).toMatchObject({ name: "caravela_register_deal", version: 1, parentVersion: null });
    expect(skill.createdFrom.kind).toBe("goal");
    expect(skill.steps.filter((s) => (s.op === "click" || s.op === "press") && s.commit)).toHaveLength(1);
    expect(skill.success.extract[0]?.regex).toBe("NW-REG-\\d{5}");
    // Every form field the script wrote is bound to its own param (dates keep their typed format).
    const { bindings, unmapped } = fieldBindings(skill, PORTALS.caravela);
    expect(unmapped).toEqual([]);
    expect(bindings.find((b) => b.key === "expectedCloseDate")?.template).toBe(
      "{{expected_close_date|date:DD/MM/YYYY}}",
    );
    expect(bindings.find((b) => b.key === "consent")?.template).toBe("true");
    expect(portal.submissions()).toHaveLength(1); // the bootstrap run's own registration

    const again = await bootstrapSkill("caravela", { portal, cacheDir }); // from cache: no second run
    expect(again).toEqual(skill);
    expect(portal.submissions()).toHaveLength(1);
  });
});

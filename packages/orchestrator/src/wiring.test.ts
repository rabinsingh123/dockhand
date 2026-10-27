import {
  createFixedClock,
  createLogger,
  createMemoryArtifactStore,
  loadConfig,
  openDb,
} from "@dockhand/core";
import { createFakeModelGateway } from "@dockhand/meta";
import { describe, expect, it } from "vitest";
import { createRecordingWhatsApp } from "./testing/fake-wa.ts";
import { createOrchestratorFromDev, portalDirectory } from "./wiring.ts";

describe("createOrchestratorFromDev", () => {
  it("builds a working orchestrator from the dev process parts", async () => {
    const db = openDb(":memory:");
    const clock = createFixedClock(Date.UTC(2026, 9, 27, 13, 0, 0));
    const whatsapp = createRecordingWhatsApp();
    const config = loadConfig({ REP_ALLOWLIST: "5511999990001", LOG_LEVEL: "silent" });
    const wired = createOrchestratorFromDev(
      {
        config,
        db,
        clock,
        log: createLogger({ level: "silent" }),
        artifacts: createMemoryArtifactStore(clock),
        whatsapp,
      },
      { models: createFakeModelGateway() },
    );
    try {
      await wired.orchestrator.recover();
      await wired.orchestrator.handle({
        waId: "wamid.1",
        from: "5511999990001",
        ts: clock.now(),
        kind: "text",
        text: "/skills",
      });
      await wired.orchestrator.drain();
      expect(whatsapp.sent.at(-1)).toMatchObject({
        type: "text",
        body: expect.stringContaining("No skills yet"),
      });
      // Numbers outside REP_ALLOWLIST are ignored even if a caller forgets to filter them.
      await wired.orchestrator.handle({
        waId: "wamid.2",
        from: "5511000000000",
        ts: clock.now(),
        kind: "text",
        text: "/skills",
      });
      expect(whatsapp.sent).toHaveLength(1);
    } finally {
      await wired.close();
      db.close();
    }
  });

  it("points at the configured ports when the portals run in another process", () => {
    const dir = portalDirectory(loadConfig({ PARTNER_PORTAL_PORT: "5101", SUPPLIER_PORTAL_PORT: "5102" }));
    expect(dir.caravela?.url).toBe("http://127.0.0.1:5101");
    expect(dir.supplier?.startPath).toBe("/t/{{tenant}}/invite/{{invite_code}}");
    expect(dir.supplier?.writeGuardAllow).toContain("/start");
  });
});

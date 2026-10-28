// `pnpm dev`: the single dev process (gateway + emulator in emulator mode + both mock portals + orchestrator).
// Routes are listed in dev-process.ts.

import { createLedger, loadConfig, modeBanner } from "@dockhand/core";
import { createModelGateway } from "@dockhand/meta";
import {
  createFakeCrm,
  createOrchestratorFromDev,
  type FromDevOptions,
  type Wired,
} from "@dockhand/orchestrator";
import { createStandInGateway, standInComputerUse } from "@dockhand/orchestrator/stand-ins";
import { Hono } from "hono";
import { type DevProcess, startDevProcess } from "./dev-process.ts";

const FAKE_MODE_NOTE =
  "Fake mode: fixture answers and scripted computer use stand in for every model call ($0, no keys). Not for recording.";

async function main(): Promise<void> {
  let dev: DevProcess;
  let wired: Wired;
  try {
    const config = loadConfig();
    process.stdout.write(`${modeBanner(config)}\n`);
    // The in-memory CRM (CRM_MODE=fake) is readable at GET /__dev/crm, so checks can see what was written.
    const crm = config.crm.mode === "fake" ? createFakeCrm() : undefined;
    const tools = new Hono();
    if (crm) tools.get("/__dev/crm", (c) => c.json(crm.state()));
    dev = await startDevProcess({ config, routes: tools });
    const ledger = createLedger(dev.db, dev.clock);
    // META_MODE=fake runs the whole demo for free: teach, first runs, heals and replays all work end to end.
    const fake = config.meta.mode === "fake";
    const models: FromDevOptions["models"] = fake
      ? createStandInGateway({ ledger, clock: dev.clock })
      : createModelGateway({ config, ledger, artifacts: dev.artifacts, clock: dev.clock, log: dev.log });
    wired = createOrchestratorFromDev(dev, {
      models,
      firstRunModel: process.env.FIRST_RUN_MODEL,
      ...(crm ? { crm } : {}),
      ...(fake
        ? {
            cu: standInComputerUse("cu_first_run", { ledger }),
            repairCu: standInComputerUse("cu_repair", { ledger }),
          }
        : {}),
    });
    if (fake) process.stdout.write(`${FAKE_MODE_NOTE}\n`);
    await wired.orchestrator.recover();
    dev.wire(async (messages) => {
      for (const m of messages) await wired.orchestrator.handle(m);
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }

  const lines = [
    `Gateway          ${dev.urls.gateway}  (webhook ${dev.urls.webhook}, health ${dev.urls.gateway}/__health)`,
  ];
  if (dev.urls.devChat) {
    lines.push(`Dev chat         ${dev.urls.devChat.replace("127.0.0.1", "localhost")}`);
    lines.push(`Fake Graph API   ${dev.urls.graph}/${dev.config.whatsapp.graphVersion}/...`);
  }
  if (dev.portals) {
    lines.push(`Partner portal   ${dev.portals.partner.url}`);
    lines.push(`Supplier portal  ${dev.portals.supplier.url}`);
  }
  if (dev.config.reps.allowlist.length === 0) {
    lines.push("WARNING: REP_ALLOWLIST is empty, so every sender gets the refusal. Set it in .env (digits).");
  }
  process.stdout.write(`${lines.join("\n")}\nCtrl+C to stop.\n`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) process.exit(1); // second Ctrl+C: do not wait
    stopping = true;
    dev.log.info("shutting down", { signal });
    setTimeout(() => process.exit(1), 10_000).unref();
    await wired.close();
    await dev.close();
    process.exit(0);
  };
  // SIGBREAK is Ctrl+Break on Windows; Ctrl+C does not always reach grandchildren of pnpm there.
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const)
    process.on(signal, () => void stop(signal));
  // A parent that spawned this process with an IPC channel (pnpm demo:check) stops it cleanly this way:
  // Windows has no signals a parent can send, and a hard kill would orphan the portal browser.
  if (process.send) {
    process.on("message", (m) => {
      if (m === "shutdown") void stop("ipc");
    });
    process.on("disconnect", () => void stop("parent exited"));
    process.send("ready");
  }
}

void main();

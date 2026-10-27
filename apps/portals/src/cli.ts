// Usage: tsx apps/portals/src/cli.ts partner|supplier|both [--port N] [--host H] [--version v1|v2]
//        [--mutation-seed N] [--mutation-ops label_synonym,testid_churn] [--latency MIN,MAX]
// With `both`, --port sets the partner port and the supplier gets port+1.

import {
  type PortalHandle,
  type StartOptions,
  startPartnerPortal,
  startSupplierPortal,
  TENANTS,
} from "./index.ts";
import type { MutationConfig, PortalVersion } from "./shared/types.ts";

function usage(message?: string): never {
  if (message) console.error(`error: ${message}`);
  console.error(
    "usage: tsx apps/portals/src/cli.ts partner|supplier|both [--port N] [--host H] [--version v1|v2]\n" +
      "       [--mutation-seed N] [--mutation-ops op1,op2] [--latency MIN,MAX]",
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv: string[]) {
  const [which, ...rest] = argv;
  if (which === "-h" || which === "--help") usage();
  if (which !== "partner" && which !== "supplier" && which !== "both")
    usage("first argument must be partner, supplier or both");
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) usage(`unexpected argument ${arg}`);
    const [key, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    const value = inline ?? rest[++i];
    if (value === undefined) usage(`--${key} needs a value`);
    flags[key] = value;
  }
  return { which, flags };
}

function intFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) usage(`--${name} must be a non-negative integer`);
  return n;
}

async function main() {
  const { which, flags } = parseArgs(process.argv.slice(2));
  const version = (flags.version ?? "v1") as PortalVersion;
  if (version !== "v1" && version !== "v2") usage("--version must be v1 or v2");
  const seed = intFlag(flags["mutation-seed"], "mutation-seed");
  const ops = flags["mutation-ops"]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const mutation: MutationConfig | null =
    seed !== undefined ? { seed, ...(ops ? { operators: ops as MutationConfig["operators"] } : {}) } : null;
  let latencyMs: [number, number] | undefined;
  if (flags.latency) {
    const [min, max] = flags.latency.split(",").map(Number);
    if (min === undefined || max === undefined || !(min >= 0) || !(max >= min))
      usage("--latency must be MIN,MAX");
    latencyMs = [min, max];
  }
  const port = intFlag(flags.port, "port");
  const host = flags.host;
  const base: StartOptions = { ...(host ? { host } : {}), mutation, ...(latencyMs ? { latencyMs } : {}) };

  const handles: PortalHandle[] = [];
  if (which === "partner" || which === "both") {
    const partnerPort = port ?? Number(process.env.PARTNER_PORTAL_PORT ?? 5101);
    const h = await startPartnerPortal({ ...base, port: partnerPort, version });
    handles.push(h);
    const cfg = h.config();
    console.log(`Caravela Partner Hub    ${h.url}`);
    console.log(
      `  sign in with any username and password · version ${cfg.version} · mutation ${cfg.operators.join(", ") || "none"}`,
    );
    console.log(`  register a deal:      ${h.url}/deals/new`);
  }
  if (which === "supplier" || which === "both") {
    const supplierPort =
      which === "both" && port !== undefined
        ? port + 1
        : (port ?? Number(process.env.SUPPLIER_PORTAL_PORT ?? 5102));
    const h = await startSupplierPortal({ ...base, port: supplierPort });
    handles.push(h);
    const cfg = h.config();
    console.log(`Supplier portal         ${h.url}`);
    console.log(`  mutation ${cfg.operators.join(", ") || "none"}`);
    for (const t of Object.values(TENANTS)) {
      console.log(`  ${`${t.name} invite:`.padEnd(29)}${h.url}/t/${t.slug}/invite/${t.sampleInviteCode}`);
    }
  }
  console.log(
    '\nControl: POST /api/__admin/version {"version":"v2"} · POST /api/__admin/mutation {"seed":42} · ' +
      "GET /api/__test/submissions · POST /api/__test/reset",
  );

  const shutdown = async () => {
    await Promise.all(handles.map((h) => h.close()));
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// `pnpm doctor`: environment checklist before a dev session or a recorded take. Exit code 1 on any failure.
import { formatReport, runDoctor } from "./doctor-checks.ts";

const results = await runDoctor();
process.stdout.write(`${formatReport(results)}\n`);
// exitCode, not exit(): exiting right after a write can drop piped stdout on Windows.
process.exitCode = results.some((r) => r.status === "fail") ? 1 : 0;

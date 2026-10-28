// Shared setup for the live scripts in scripts/live: the real ModelGateway (META_MODE from the env, so
// prefix commands with META_MODE=live or META_MODE=record), a ledger in DOCKHAND_VAR_DIR (default
// var/agent-live), and a wire log of request and response bodies with base64 media and secrets stripped.
// Usage from a script: const live = await openLive("probe"); ...; live.report(); live.close();

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Config,
  createArtifactStore,
  createLedger,
  createLogger,
  type Db,
  type Ledger,
  loadConfig,
  type ModelGateway,
  openDb,
  systemClock,
  workspaceRoot,
} from "../../packages/core/src/index.ts";
import { createModelGateway, redact } from "../../packages/meta/src/index.ts";

export const LIVE_VAR_DIR = join(workspaceRoot(), "var", "agent-live");

export interface Live {
  config: Config;
  db: Db;
  ledger: Ledger;
  artifacts: ReturnType<typeof createArtifactStore>;
  models: ModelGateway;
  /** USD of every real (provider meta/baseten) call in this var dir's ledger, all scripts and sessions. */
  spentUsd(): number;
  /** One line per purpose/model of the calls this process made. */
  report(): string;
  close(): void;
}

/** Strips data URLs, long base64 runs and the API key from a wire log line. */
function scrub(text: string, secrets: string[]): string {
  return redact(text, secrets);
}

export function openLive(tag: string, opts: { cassetteDir?: string } = {}): Live {
  process.env.DOCKHAND_VAR_DIR ||= LIVE_VAR_DIR;
  const config = loadConfig();
  if (config.meta.mode === "fake") {
    throw new Error("scripts/live need META_MODE=live, record or cassette (prefix the command)");
  }
  const dir = process.env.DOCKHAND_VAR_DIR;
  mkdirSync(join(dir, "wire"), { recursive: true });
  const wireFile = join(dir, "wire", `${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  const secrets = [config.meta.apiKey, config.openWeights.apiKey].filter((s): s is string => Boolean(s));

  const wireFetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const started = Date.now();
    const body = typeof init?.body === "string" ? init.body : init?.body ? "<binary/multipart>" : "";
    const res = await fetch(input, init);
    const text = await res.clone().text();
    appendFileSync(
      wireFile,
      `${JSON.stringify({
        at: new Date(started).toISOString(),
        ms: Date.now() - started,
        url: new URL(url).pathname,
        status: res.status,
        request: scrub(body, secrets),
        response: scrub(text, secrets),
      })}\n`,
    );
    return res;
  };

  const db = openDb(join(dir, "dockhand.sqlite"));
  const ledger = createLedger(db);
  const artifacts = createArtifactStore(db, dir);
  const startedAt = Date.now();
  const models = createModelGateway({
    config,
    ledger,
    artifacts,
    clock: systemClock,
    log: createLogger({ level: process.env.LOG_LEVEL ?? "warn", fields: { script: tag } }),
    fetch: wireFetch,
    ...(opts.cassetteDir ? { cassetteDir: opts.cassetteDir } : {}),
  });

  return {
    config,
    db,
    ledger,
    artifacts,
    models,
    spentUsd() {
      const row = db.raw
        .prepare(
          "SELECT COALESCE(SUM(cost_usd), 0) AS usd FROM model_calls WHERE provider IN ('meta', 'baseten')",
        )
        .get() as { usd: number };
      return row.usd;
    },
    report() {
      const rows = db.raw
        .prepare(
          `SELECT purpose, model, provider, status, COUNT(*) AS calls, SUM(input_tokens) AS input,
                  SUM(cached_input_tokens) AS cached, SUM(output_tokens) AS output,
                  SUM(COALESCE(reasoning_tokens, 0)) AS reasoning, SUM(images) AS images,
                  SUM(latency_ms) AS ms, SUM(cost_usd) AS usd
           FROM model_calls WHERE ts >= ? GROUP BY purpose, model, provider, status ORDER BY purpose`,
        )
        .all(startedAt) as Record<string, number | string>[];
      const lines = rows.map(
        (r) =>
          `${r.purpose} ${r.model} ${r.provider} ${r.status}: ${r.calls} calls, in ${r.input} (cached ${r.cached}), out ${r.output} (reasoning ${r.reasoning}), ${r.images} images, ${r.ms} ms, $${Number(r.usd).toFixed(4)}`,
      );
      lines.push(`wire log: ${wireFile}`);
      lines.push(`ledger total (all live calls in ${dir}): $${this.spentUsd().toFixed(4)}`);
      return lines.join("\n");
    },
    close() {
      db.close();
    },
  };
}

import { join } from "node:path";
import {
  type ArtifactStore,
  type Clock,
  DockhandError,
  type Ledger,
  type Logger,
  type ModelGateway,
  workspaceRoot,
} from "@dockhand/core";
import type { ZodType } from "zod";
import { createCassettes, type TapeMode } from "./cassette.ts";
import { type CuState, createMetaComputerUseModel } from "./computer-use.ts";
import type { MetaConfig } from "./config.ts";
import { openWeightsPrices } from "./cost.ts";
import type { GatewayEnv } from "./env.ts";
import { createFakeModelGateway } from "./fake.ts";
import { createFileUploader } from "./files.ts";
import { createProviderClient, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./http.ts";
import { toWireSchema, type WireSchema } from "./schema.ts";
import { runStructured } from "./structured.ts";
import { transcribeWav } from "./transcribe.ts";

export interface ModelGatewayDeps {
  config: MetaConfig;
  ledger: Ledger;
  artifacts: ArtifactStore;
  clock: Clock;
  log: Logger;
  fetch?: typeof fetch;
  /** Where record mode writes and cassette mode reads. Default: `<workspace root>/fixtures/cassettes`. */
  cassetteDir?: string;
  /** Send `parallel_tool_calls: false` on computer-use requests (one tool call per turn). Default: omitted. */
  disableParallelToolCalls?: boolean;
  /**
   * stateless (default) replays each computer-use session's history with store:false; chained uses
   * previous_response_id. Live, chained turns took 9-11 s against 2.4-3.2 s stateless (meta-api-notes.md).
   */
  computerUseState?: CuState;
  /** A computer-use turn slower than this is abandoned and sent once more. Default 40 s; 0 turns it off. */
  computerUseSlowMs?: number;
  /** Transport retry tuning (tests pass a no-op sleep). */
  retry?: Partial<RetryPolicy>;
}

/**
 * Routes by META_MODE: live calls Meta (and Baseten for the open-weights model), record does the same and
 * writes every response to fixtures/cassettes, cassette replays them without network, fake answers from
 * createFakeModelGateway (handlers can be wired by calling that directly).
 */
export function createModelGateway(deps: ModelGatewayDeps): ModelGateway {
  const { config } = deps;
  const mode = config.meta.mode;
  const log = deps.log.child({ mod: "meta" });
  if (mode === "fake") return createFakeModelGateway({ ledger: deps.ledger, clock: deps.clock });
  if ((mode === "live" || mode === "record") && !config.meta.apiKey) {
    throw new DockhandError("MODEL_ERROR", `META_MODE=${mode} needs MODEL_API_KEY`);
  }

  const tapeMode: TapeMode = mode === "record" ? "record" : mode === "cassette" ? "replay" : "off";
  const retry = deps.retry ?? {};
  const clientBase = { log, fetch: deps.fetch, retry };
  const meta = createProviderClient({
    ...clientBase,
    provider: "meta",
    baseUrl: config.meta.baseUrl,
    apiKey: config.meta.apiKey,
  });
  const baseten = createProviderClient({
    ...clientBase,
    provider: "baseten",
    baseUrl: config.openWeights.baseUrl,
    apiKey: config.openWeights.apiKey,
  });
  const schemas = new WeakMap<ZodType, WireSchema>();
  const env: GatewayEnv = {
    config,
    ledger: deps.ledger,
    artifacts: deps.artifacts,
    clock: deps.clock,
    log,
    cassettes: createCassettes({
      mode: tapeMode,
      dir: deps.cassetteDir ?? join(workspaceRoot(), "fixtures", "cassettes"),
      clock: deps.clock,
      log,
    }),
    meta,
    baseten,
    files: createFileUploader(meta, log),
    wireSchema(schema) {
      let wire = schemas.get(schema);
      if (!wire) {
        wire = toWireSchema(schema);
        schemas.set(schema, wire);
      }
      return wire;
    },
    sleep: retry.sleep ?? DEFAULT_RETRY_POLICY.sleep,
    disableParallelToolCalls: deps.disableParallelToolCalls ?? false,
    computerUseState: deps.computerUseState ?? "stateless",
    computerUseSlowMs: deps.computerUseSlowMs ?? 40_000,
  };

  if (config.openWeights.apiKey && !openWeightsPrices(config.openWeights)) {
    log.warn(
      "OPEN_WEIGHTS_PRICE_IN/OUT unset: Baseten calls are recorded at $0 until set to Baseten's real price",
    );
  }

  return {
    structured: (req, ctx) => runStructured(env, req, ctx),
    transcribe: (wav, opts, ctx) => transcribeWav(env, wav, opts, ctx),
    computerUse: (opts) => createMetaComputerUseModel(env, opts),
    // Replay needs no key, so in cassette mode rung 2 is on whenever a model tag is configured.
    hasOpenWeights: () =>
      mode === "cassette"
        ? config.openWeights.model !== ""
        : config.openWeights.model !== "" && Boolean(config.openWeights.apiKey),
  };
}

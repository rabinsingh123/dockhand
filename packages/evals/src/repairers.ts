// Heal-ladder rungs 2-3 for eval runs: none (free heals only), fake (a deterministic stand-in for the
// open-weights picker, labeled "fake" in the ledger so it never counts as a model result), or live (Muse
// Spark Open on Baseten and Muse computer use through the real gateway, when the keys exist).

import { runComputerUse } from "@dockhand/browser";
import {
  type ArtifactStore,
  type Config,
  createLogger,
  type HealRung,
  type Ledger,
  type ModelGateway,
  type Repairer,
  type StructuredRequest,
  systemClock,
  type WriteGuardConfig,
} from "@dockhand/core";
import { createFakeModelGateway, createModelGateway } from "@dockhand/meta";
import { createCuRepairer, createOpenWeightsRepairer } from "@dockhand/skills";

export type RepairMode = "none" | "fake" | "live";
export const REPAIR_MODES: readonly RepairMode[] = ["none", "fake", "live"];

/** What a case's repairers may use: the run's own artifact store and write guard. */
export interface RepairerContext {
  artifacts: ArtifactStore;
  writeGuard: WriteGuardConfig;
}

export interface RepairSetup {
  mode: RepairMode;
  rungs: HealRung[];
  build(ctx: RepairerContext): Repairer[];
}

/** Computer-use repair model (docs/ARCHITECTURE.md §5). */
export const CU_REPAIR_MODEL = "muse-wonder-1.0";

const words = (s: string | undefined) =>
  new Set(
    (s ?? "")
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2),
  );

interface Brief {
  index?: number;
  name?: string;
  label?: string;
  placeholder?: string;
  section?: string;
  text?: string;
}

/**
 * Deterministic stand-in for the rung-2 model: the listed element sharing the most words with the old
 * element (name, label, placeholder) and the step intent; null on a tie or no overlap.
 */
export function fakeElementPick(req: StructuredRequest<unknown>): {
  index: number | null;
  confidence: number;
  reason: string;
} {
  const lines = req.input.flatMap((p) => (p.type === "text" ? p.text.split("\n") : []));
  const prefix = "Element the step used before the change: ";
  const oldLine = lines.find((l) => l.startsWith(prefix));
  const listAt = lines.indexOf("Elements of the same kind on the page now:");
  const intent = lines.find((l) => l.startsWith("Step: "))?.slice(6);
  if (!oldLine || listAt < 0) return { index: null, confidence: 0, reason: "unreadable prompt" };
  const old = JSON.parse(oldLine.slice(prefix.length)) as Brief;
  const list = JSON.parse(lines[listAt + 1] ?? "[]") as Brief[];
  const want = new Set([
    ...words(old.name),
    ...words(old.label),
    ...words(old.placeholder),
    ...words(intent),
  ]);
  const scored = list
    .map((e) => {
      const have = new Set([...words(e.name), ...words(e.label), ...words(e.placeholder), ...words(e.text)]);
      let score = 0;
      for (const w of have) if (want.has(w)) score++;
      return { e, score };
    })
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (!best || best.score === 0 || (second && second.score === best.score)) {
    return { index: null, confidence: 0, reason: "no single element shares words with the old one" };
  }
  return {
    index: best.e.index ?? null,
    confidence: 0.6,
    reason: `shares ${best.score} words with the old element`,
  };
}

export function repairSetup(
  mode: RepairMode,
  deps: { ledger: Ledger; artifacts: ArtifactStore; config?: Config },
): RepairSetup {
  if (mode === "none") return { mode, rungs: [], build: () => [] };
  if (mode === "fake") {
    const gateway = createFakeModelGateway({
      ledger: deps.ledger,
      openWeights: true,
      structured: fakeElementPick,
    });
    return {
      mode,
      rungs: ["open_weights"],
      build: () => [createOpenWeightsRepairer(gateway, { model: "fake-open-weights", ledger: deps.ledger })],
    };
  }
  const config = deps.config;
  const live = config && config.meta.mode === "live" && config.meta.apiKey;
  if (!config || !live) {
    throw new Error(
      "--repair live needs META_MODE=live with MODEL_API_KEY in .env (BASETEN_API_KEY adds rung 2)",
    );
  }
  const gateway: ModelGateway = createModelGateway({
    config,
    ledger: deps.ledger,
    artifacts: deps.artifacts,
    clock: systemClock,
    log: createLogger({ level: config.logLevel, fields: { mod: "evals" } }),
  });
  const openWeights = gateway.hasOpenWeights();
  return {
    mode,
    rungs: [...(openWeights ? (["open_weights"] as const) : []), "computer_use"],
    build: (ctx) => [
      ...(openWeights
        ? [createOpenWeightsRepairer(gateway, { model: config.openWeights.model, ledger: deps.ledger })]
        : []),
      createCuRepairer({
        model: gateway.computerUse({ model: CU_REPAIR_MODEL }),
        runComputerUse,
        artifacts: ctx.artifacts,
        writeGuard: ctx.writeGuard,
        ledger: deps.ledger,
      }),
    ],
  };
}

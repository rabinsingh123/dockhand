// Test helpers for the computer-use loop (not exported from index.ts).

import {
  type CallCtx,
  type ComputerUseModel,
  type CuHooks,
  type CuReply,
  type CuRunInput,
  type CuTurn,
  createMemoryArtifactStore,
  type Decision,
} from "@dockhand/core";
import type { Page } from "playwright";
import { FIXTURE_ORIGIN } from "../test-support.ts";

export const CTX: CallCtx = { purpose: "cu_first_run", runId: "run-test", timeoutMs: 30_000 };

export function cuInput(page: Page, overrides: Partial<CuRunInput> = {}): CuRunInput {
  return {
    page,
    portalId: "fixture",
    runId: "run-test",
    goal: "Register the deal for Sabiá Foods",
    guidance: [],
    params: {},
    attachments: {},
    commitPolicy: "gate",
    commitHints: [],
    writeGuard: { origins: [FIXTURE_ORIGIN], allow: [] },
    limits: { maxActions: 80, maxWallMs: 120_000, maxCostUsd: 1, rolloverAfterImages: 50 },
    artifacts: createMemoryArtifactStore(),
    ...overrides,
  };
}

export interface RecordingHooks extends CuHooks {
  commits: Parameters<CuHooks["approveCommit"]>[0][];
  safety: Parameters<CuHooks["approveSafety"]>[0][];
  progressed: { action: number; note: string }[];
}

export function recordingHooks(commit: Decision = "approved", safety: Decision = "approved"): RecordingHooks {
  const h: RecordingHooks = {
    commits: [],
    safety: [],
    progressed: [],
    async approveCommit(r) {
      h.commits.push(r);
      return commit;
    },
    async approveSafety(r) {
      h.safety.push(r);
      return safety;
    },
    progress(r) {
      h.progressed.push(r);
    },
  };
  return h;
}

/** A model that answers each send with the next canned turn list (then a final message). */
export function cannedModel(turns: CuTurn[][]): ComputerUseModel & { replies: CuReply[] } {
  const replies: CuReply[] = [];
  let i = 0;
  let images = 0;
  return {
    provider: "fake",
    model: "canned",
    replies,
    open: () => ({
      imagesInChain: () => images,
      async send(reply) {
        replies.push(reply);
        images = reply.kind === "start" || reply.kind === "rollover" ? 1 : images + 1;
        return turns[i++] ?? [{ kind: "final", text: "Done." }];
      },
    }),
  };
}

import {
  type ArtifactRef,
  type CallCtx,
  type Clock,
  type ComputerUseModel,
  DockhandError,
  type ErrorCode,
  type Ledger,
  type ModelCallRecord,
  type ModelGateway,
  type StructuredRequest,
  systemClock,
  type Transcript,
} from "@dockhand/core";
import { z } from "zod";
import { ASR_MODEL } from "./config.ts";
import { countImages } from "./inputs.ts";

export interface FakeGatewayOptions {
  /** The "model's" answer to a structured call. It is validated against req.schema like a real reply. */
  structured?: (req: StructuredRequest<unknown>, ctx: CallCtx) => unknown | Promise<unknown>;
  transcribe?: (
    wav: ArtifactRef,
    opts: { languageBias?: string[]; keywords?: string[] },
    ctx: CallCtx,
  ) => Transcript | Promise<Transcript>;
  /** Returned as is: the scripted model (packages/browser) records its own ledger rows. */
  computerUse?: ComputerUseModel;
  openWeights?: boolean;
  /** When set, structured and transcribe calls record rows with provider "fake" and cost 0. */
  ledger?: Ledger;
  clock?: Clock;
}

/** A ModelGateway for other packages' tests and META_MODE=fake. No network, no cost. */
export function createFakeModelGateway(opts: FakeGatewayOptions = {}): ModelGateway {
  const clock = opts.clock ?? systemClock;

  async function recorded<T>(
    ctx: CallCtx,
    model: string,
    extra: { images?: number },
    run: () => Promise<T>,
    audioMsOf?: (result: T) => number,
  ): Promise<T> {
    const startedAt = clock.now();
    let errorCode: ErrorCode | undefined;
    let audioMs: number | undefined;
    try {
      const result = await run();
      audioMs = audioMsOf?.(result);
      return result;
    } catch (err) {
      errorCode = err instanceof DockhandError ? err.code : "MODEL_ERROR";
      throw err;
    } finally {
      const row: ModelCallRecord = {
        purpose: ctx.purpose,
        provider: "fake",
        model,
        ...(ctx.jobId !== undefined ? { jobId: ctx.jobId } : {}),
        ...(ctx.runId !== undefined ? { runId: ctx.runId } : {}),
        ...(ctx.stepIdx !== undefined ? { stepIdx: ctx.stepIdx } : {}),
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        images: extra.images ?? 0,
        ...(audioMs !== undefined ? { audioMs } : {}),
        latencyMs: Math.max(0, clock.now() - startedAt),
        costUsd: 0,
        status: errorCode === undefined ? "ok" : errorCode === "MODEL_TIMEOUT" ? "timeout" : "error",
        ...(errorCode !== undefined ? { errorCode } : {}),
      };
      opts.ledger?.record(row);
    }
  }

  return {
    structured(req, ctx) {
      return recorded(ctx, req.model, { images: countImages(req.input) }, async () => {
        if (!opts.structured) {
          throw new DockhandError(
            "MODEL_ERROR",
            `fake gateway has no structured handler (purpose ${ctx.purpose})`,
          );
        }
        const raw = await opts.structured(req as StructuredRequest<unknown>, ctx);
        const parsed = req.schema.safeParse(raw);
        if (!parsed.success) {
          throw new DockhandError(
            "MODEL_INVALID_OUTPUT",
            `fake ${req.schemaName} output failed validation: ${z.prettifyError(parsed.error)}`,
          );
        }
        return parsed.data;
      });
    },
    transcribe(wav, transcribeOpts, ctx) {
      return recorded(
        ctx,
        ASR_MODEL,
        {},
        async () => {
          if (!opts.transcribe) {
            throw new DockhandError(
              "MODEL_ERROR",
              `fake gateway has no transcribe handler (purpose ${ctx.purpose})`,
            );
          }
          return opts.transcribe(wav, transcribeOpts, ctx);
        },
        (t) => t.audioMs,
      );
    },
    computerUse(cuOpts) {
      if (opts.computerUse) return opts.computerUse;
      return {
        provider: "fake",
        model: cuOpts.model,
        open: () => ({
          imagesInChain: () => 0,
          send: async () => {
            throw new DockhandError("MODEL_ERROR", "fake gateway has no computer-use model");
          },
        }),
      };
    },
    hasOpenWeights: () => opts.openWeights ?? false,
  };
}

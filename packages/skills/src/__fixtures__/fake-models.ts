// Minimal local ModelGateway for tests: structured() answers from a handler and validates with the
// request's schema, like the real gateway. Nothing else is implemented.

import type { CallCtx, ModelGateway, StructuredRequest } from "@dockhand/core";

export interface RecordedCall {
  req: StructuredRequest<unknown>;
  ctx: CallCtx;
}

export type FakeHandler = (req: StructuredRequest<unknown>, ctx: CallCtx) => unknown | Promise<unknown>;

export function createLocalFakeGateway(
  handler: FakeHandler,
  opts: { openWeights?: boolean } = {},
): ModelGateway & { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async structured<T>(req: StructuredRequest<T>, ctx: CallCtx): Promise<T> {
      calls.push({ req: req as StructuredRequest<unknown>, ctx });
      return req.schema.parse(await handler(req as StructuredRequest<unknown>, ctx));
    },
    async transcribe() {
      throw new Error("fake gateway: transcribe is not implemented");
    },
    computerUse() {
      throw new Error("fake gateway: computerUse is not implemented");
    },
    hasOpenWeights: () => opts.openWeights ?? true,
  };
}

/** The text input of a structured request (the prompt). */
export function promptText(req: StructuredRequest<unknown>): string {
  return req.input.map((p) => (p.type === "text" ? p.text : "")).join("\n");
}

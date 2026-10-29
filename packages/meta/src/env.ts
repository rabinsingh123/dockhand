import type { ArtifactStore } from "@dockhand/core";
import type { ZodType } from "zod";
import type { RecorderDeps } from "./call.ts";
import type { Cassettes } from "./cassette.ts";
import type { CuState } from "./computer-use.ts";
import type { MetaConfig } from "./config.ts";
import type { FileUploader } from "./files.ts";
import type { ProviderClient } from "./http.ts";
import type { WireSchema } from "./schema.ts";

/** Everything one gateway instance shares between its calls (built once in createModelGateway). */
export interface GatewayEnv extends RecorderDeps {
  config: MetaConfig;
  artifacts: ArtifactStore;
  cassettes: Cassettes;
  meta: ProviderClient;
  baseten: ProviderClient;
  files: FileUploader;
  /** zod -> wire JSON Schema, converted once per schema object. */
  wireSchema(schema: ZodType): WireSchema;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  disableParallelToolCalls: boolean;
  /** How computer-use sessions keep their conversation unless a session asks otherwise. */
  computerUseState: CuState;
  /** A computer-use turn slower than this is sent once more (0: never). */
  computerUseSlowMs: number;
  /** An extract or understand request slower than this is sent once more (0: never). */
  structuredSlowMs: number;
}

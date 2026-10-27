import type { Config } from "@dockhand/core";

/**
 * The slice of core's Config the gateway reads. `config.openWeights.priceInPerM` / `priceOutPerM`
 * (OPEN_WEIGHTS_PRICE_IN / OPEN_WEIGHTS_PRICE_OUT, USD per 1M tokens) must be set to Baseten's real price
 * for the model before any cost number is reported; while unset, Baseten calls are recorded at $0.
 */
export type MetaConfig = Pick<Config, "meta" | "openWeights">;

/** The Voice Transcribe model (the transcribe contract takes no model id). */
export const ASR_MODEL = "muse-voice-transcribe-1.0";

/** Documented hard cap on images in one Responses request (more returns HTTP 400). */
export const MAX_IMAGES_PER_REQUEST = 50;

/** Baseten's per-request image limit for Muse Spark Open. */
export const MAX_OPEN_WEIGHTS_IMAGES = 8;

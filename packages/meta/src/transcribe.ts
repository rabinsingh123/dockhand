import { type ArtifactRef, type CallCtx, DockhandError, type Transcript } from "@dockhand/core";
import { z } from "zod";
import { openScope, recordCall } from "./call.ts";
import { cassetteKey } from "./cassette.ts";
import { ASR_MODEL } from "./config.ts";
import { audioCostUsd } from "./cost.ts";
import type { GatewayEnv } from "./env.ts";
import { providerErrorDetail } from "./http.ts";
import { baseMime } from "./media.ts";
import { assertTranscribable, parseWav } from "./wav.ts";

const WAV_MIMES = new Set(["audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave"]);

/** TranscribeResponse from https://dev.meta.ai/docs/api-reference/voice/schemas. */
const TranscribeResponse = z.looseObject({
  sessionId: z.string(),
  transcript: z.string(),
  audioDurationMs: z.number().optional(),
  turns: z
    .array(
      z.looseObject({
        turnId: z.number().optional(),
        startMs: z.number(),
        endMs: z.number(),
        transcript: z.string(),
        speaker: z.string().optional(),
      }),
    )
    .default([]),
});

export interface TranscribeOptions {
  languageBias?: string[];
  keywords?: string[];
}

/**
 * POST /v1/asr/transcribe, multipart with a JSON `request` part and the WAV as `audio`
 * (https://dev.meta.ai/docs/speech-to-text). Mode ENDPOINTING, because PUSH_TO_TALK returns no turns.
 * Callers convert to WAV first (mono 16-bit PCM, 16 or 24 kHz); anything else is MEDIA_UNSUPPORTED.
 * audioMs comes from the WAV header; failed requests are not billed, so they cost 0.
 */
export async function transcribeWav(
  env: GatewayEnv,
  wav: ArtifactRef,
  opts: TranscribeOptions,
  ctx: CallCtx,
): Promise<Transcript> {
  if (!WAV_MIMES.has(baseMime(wav.mime))) {
    throw new DockhandError(
      "MEDIA_UNSUPPORTED",
      `transcribe takes WAV only (got ${wav.mime}); convert with ffmpeg first`,
    );
  }
  const bytes = await env.artifacts.read(wav);
  const info = parseWav(bytes);
  assertTranscribable(info, bytes.byteLength);

  const languageBias = cleanList(opts.languageBias);
  const keywords = cleanList(opts.keywords);
  const request = {
    model: ASR_MODEL,
    audioEncoding: "WAV",
    mode: "ENDPOINTING",
    ...(languageBias.length > 0 ? { languageBias } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
  const tape = env.cassettes.tape(
    ctx.purpose,
    cassetteKey(ctx.purpose, { model: ASR_MODEL, wav: wav.sha256, languageBias, keywords }),
  );
  const scope = openScope(ctx);
  try {
    return await recordCall(
      env,
      {
        ctx,
        provider: tape.replaying ? "cassette" : "meta",
        model: ASR_MODEL,
        normalize: (err) => {
          // 400 = unsupported WAV or over 10 minutes, 413 = body over 32 MB: both are about the media.
          const detail = providerErrorDetail(err);
          if (detail && (detail.status === 400 || detail.status === 413)) {
            return new DockhandError("MEDIA_UNSUPPORTED", (err as Error).message, detail);
          }
          return scope.normalize(err);
        },
        // responseId is set only once a transcript came back; a request that failed before that is not billed.
        price: (rec) => (rec.responseId !== undefined ? audioCostUsd(ASR_MODEL, info.audioMs) : 0),
      },
      async (rec) => {
        rec.audioMs = info.audioMs;
        const raw = await tape.next(() =>
          env.meta.postMultipart(
            "/asr/transcribe",
            [
              { name: "request", value: JSON.stringify(request), contentType: "application/json" },
              { name: "audio", value: bytes, filename: "audio.wav", contentType: "audio/wav" },
            ],
            scope,
            { accept: "application/json" },
          ),
        );
        const parsed = TranscribeResponse.safeParse(raw);
        if (!parsed.success) throw new DockhandError("MODEL_ERROR", "transcribe returned an unexpected body");
        rec.responseId = parsed.data.sessionId;
        return {
          text: parsed.data.transcript.trim(),
          // A turn the clip ended part-way through carries an empty transcript: nothing to keep.
          turns: parsed.data.turns
            .filter((t) => t.transcript.trim() !== "")
            .map((t) => ({ startMs: t.startMs, endMs: t.endMs, text: t.transcript.trim() })),
          audioMs: info.audioMs,
        };
      },
    );
  } finally {
    await tape.save();
  }
}

function cleanList(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter((v) => v !== ""))];
}

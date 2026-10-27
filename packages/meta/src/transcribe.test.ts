import { afterEach, describe, expect, it } from "vitest";
import { ASR_MODEL } from "./config.ts";
import { ctx, docFixture, META_KEY, makeWorld, type World, wavBytes } from "./test-support/world.ts";
import { assertTranscribable, parseWav } from "./wav.ts";

let world: World;
afterEach(async () => {
  await world?.close();
});

describe("transcribe (Voice Transcribe file endpoint)", () => {
  it("posts the documented multipart: a JSON request part, then the WAV as audio", async () => {
    world = await makeWorld();
    const bytes = wavBytes({ ms: 1_500 });
    const wav = await world.put(bytes, "audio/wav", "audio_wav");
    world.server.on("/v1/asr/transcribe", { json: docFixture("speech-to-text.transcribe-response.json") });

    await world.gateway.transcribe(
      wav,
      { languageBias: ["Portuguese", "English"], keywords: ["Caravela", " ", "Caravela"] },
      ctx("transcribe"),
    );

    const [req] = world.server.requestsTo("/v1/asr/transcribe");
    expect(req?.method).toBe("POST");
    expect(req?.headers.authorization).toBe(`Bearer ${META_KEY}`);
    expect(req?.headers.accept).toBe("application/json");
    const parts = req?.parts ?? [];
    expect(parts.map((p) => p.name)).toEqual(["request", "audio"]);
    expect(parts[0]?.contentType).toBe("application/json");
    expect(parts[0]?.filename).toBeUndefined();
    const requestPart = JSON.parse(parts[0]?.text ?? "{}") as Record<string, unknown>;
    expect(requestPart).toEqual({
      model: "muse-voice-transcribe-1.0",
      audioEncoding: "WAV",
      mode: "ENDPOINTING",
      languageBias: ["Portuguese", "English"],
      keywords: ["Caravela"],
    });
    // Field names and values as documented (request part, language biasing, keywords).
    const documented = {
      ...docFixture("speech-to-text.transcribe-request-part.json"),
      ...docFixture("speech-to-text.language-bias.json"),
      ...docFixture("speech-to-text.keywords.json"),
    };
    expect(Object.keys(requestPart).sort()).toEqual(Object.keys(documented).sort());
    expect(requestPart.audioEncoding).toBe(documented.audioEncoding);
    expect(parts[1]).toMatchObject({ name: "audio", filename: "audio.wav", contentType: "audio/wav" });
    expect(parts[1]?.data.equals(bytes)).toBe(true);
  });

  it("parses turns with timestamps, takes audioMs from the WAV header and bills whole seconds", async () => {
    world = await makeWorld();
    const wav = await world.put(wavBytes({ ms: 90_500 }), "audio/wav", "audio_wav");
    world.server.on("/v1/asr/transcribe", { json: docFixture("speech-to-text.transcribe-response.json") });

    const transcript = await world.gateway.transcribe(wav, {}, ctx("transcribe"));

    expect(transcript).toEqual({
      text: "How is the weather? It is raining.",
      turns: [
        { startMs: 1520, endMs: 4640, text: "How is the weather?" },
        { startMs: 5900, endMs: 8240, text: "It is raining." },
      ],
      audioMs: 90_500,
    });
    const requestPart = JSON.parse(
      world.server.requestsTo("/v1/asr/transcribe")[0]?.parts?.[0]?.text ?? "{}",
    );
    expect(requestPart).not.toHaveProperty("languageBias");
    expect(requestPart).not.toHaveProperty("keywords");
    expect(world.ledger.rows).toHaveLength(1);
    const row = world.ledger.rows[0];
    expect(row).toMatchObject({
      purpose: "transcribe",
      provider: "meta",
      model: ASR_MODEL,
      responseId: "9f1c...",
      audioMs: 90_500,
      inputTokens: 0,
      outputTokens: 0,
      status: "ok",
    });
    // 90.5 s is billed as 90 s: 90 / 3600 h * $0.18
    expect(row?.costUsd).toBeCloseTo(0.0045, 12);
  });

  it("drops turns the clip ended part-way through (empty transcript)", async () => {
    world = await makeWorld();
    const wav = await world.put(wavBytes(), "audio/wav", "audio_wav");
    world.server.on("/v1/asr/transcribe", {
      json: {
        sessionId: "s1",
        transcript: "Oi, tudo bem?",
        audioDurationMs: 1500,
        turns: [
          { turnId: 1, startMs: 0, endMs: 900, transcript: "Oi, tudo bem?" },
          { turnId: 2, startMs: 1200, endMs: 1500, transcript: "" },
        ],
      },
    });

    const t = await world.gateway.transcribe(wav, {}, ctx("transcribe"));
    expect(t.turns).toEqual([{ startMs: 0, endMs: 900, text: "Oi, tudo bem?" }]);
  });

  it("rejects non-WAV and unsupported WAV formats with MEDIA_UNSUPPORTED before any request", async () => {
    world = await makeWorld();
    const ogg = await world.put(
      new TextEncoder().encode("OggS fake voice note"),
      "audio/ogg",
      "inbound_media",
    );
    const stereo = await world.put(wavBytes({ channels: 2 }), "audio/wav", "audio_wav");
    const cd = await world.put(wavBytes({ sampleRate: 44_100 }), "audio/wav", "audio_wav");
    const notRiff = await world.put(
      new TextEncoder().encode("definitely not a wav"),
      "audio/wav",
      "audio_wav",
    );

    for (const ref of [ogg, stereo, cd, notRiff]) {
      await expect(world.gateway.transcribe(ref, {}, ctx("transcribe"))).rejects.toMatchObject({
        code: "MEDIA_UNSUPPORTED",
      });
    }
    expect(world.server.requests).toHaveLength(0);
    expect(world.ledger.rows).toHaveLength(0);
  });

  it("maps a server 400 to MEDIA_UNSUPPORTED at no cost, and retries a 429", async () => {
    world = await makeWorld();
    const wav = await world.put(wavBytes(), "audio/wav", "audio_wav");
    world.server.on(
      "/v1/asr/transcribe",
      {
        status: 400,
        json: {
          error: {
            message: "Audio is not a supported WAV file",
            type: "invalid_request_error",
            param: null,
            code: null,
          },
        },
      },
      { status: 429, json: docFixture("errors.rate-limit.json"), headers: { "retry-after": "1" } },
      { json: docFixture("speech-to-text.transcribe-response.json") },
    );

    await expect(world.gateway.transcribe(wav, {}, ctx("transcribe"))).rejects.toMatchObject({
      code: "MEDIA_UNSUPPORTED",
    });
    expect(world.ledger.rows[0]).toMatchObject({
      status: "error",
      errorCode: "MEDIA_UNSUPPORTED",
      costUsd: 0,
      audioMs: 1500,
    });

    const t = await world.gateway.transcribe(wav, {}, ctx("transcribe"));
    expect(t.text).toBe("How is the weather? It is raining.");
    expect(world.sleeps).toEqual([1000]);
    expect(world.server.requestsTo("/v1/asr/transcribe")).toHaveLength(3);
  });
});

describe("parseWav", () => {
  it("reads format, channels, rate, bit depth and duration", () => {
    expect(parseWav(wavBytes({ sampleRate: 24_000, ms: 2_000 }))).toEqual({
      audioFormat: 1,
      channels: 1,
      sampleRate: 24_000,
      bitsPerSample: 16,
      dataBytes: 96_000,
      audioMs: 2_000,
    });
  });

  it("handles streamed data sizes (0xFFFFFFFF) and extra chunks before data", () => {
    const plain = Buffer.from(wavBytes({ ms: 1_000 }));
    const list = Buffer.from("LIST\x04\x00\x00\x00INFO", "latin1");
    const withList = Buffer.concat([plain.subarray(0, 36), list, plain.subarray(36)]);
    withList.writeUInt32LE(0xffffffff, 36 + list.length + 4);
    const info = parseWav(new Uint8Array(withList));
    expect(info.dataBytes).toBe(32_000);
    expect(info.audioMs).toBe(1_000);
  });

  it("resolves WAVE_FORMAT_EXTENSIBLE to its PCM sub-format", () => {
    const plain = Buffer.from(wavBytes({ ms: 500 }));
    const fmt = Buffer.alloc(8 + 40);
    fmt.write("fmt ", 0, "ascii");
    fmt.writeUInt32LE(40, 4);
    plain.copy(fmt, 8, 20, 36); // the 16 classic fmt bytes
    fmt.writeUInt16LE(0xfffe, 8);
    fmt.writeUInt16LE(22, 24); // cbSize
    fmt.writeUInt16LE(1, 32); // sub-format GUID starts with the PCM code
    const file = Buffer.concat([plain.subarray(0, 12), fmt, plain.subarray(36)]);
    const info = parseWav(new Uint8Array(file));
    expect(info.audioFormat).toBe(1);
    expect(() => assertTranscribable(info, file.length)).not.toThrow();
  });

  it("rejects audio longer than 10 minutes", () => {
    const info = {
      audioFormat: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataBytes: 0,
      audioMs: 601_000,
    };
    expect(() => assertTranscribable(info, 1_000)).toThrow(/max 600 s/);
  });
});

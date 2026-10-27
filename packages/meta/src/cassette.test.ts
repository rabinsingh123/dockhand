import { existsSync, readFileSync } from "node:fs";
import type { InputPart } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { type CassetteFile, cassetteKey, cassettePath } from "./cassette.ts";
import { structuredKeyMaterial } from "./inputs.ts";
import {
  ctx,
  docFixture,
  makeWorld,
  messageItem,
  OPEN_WEIGHTS_MODEL,
  pngBytes,
  responseBody,
  tempDir,
  type World,
  wavBytes,
} from "./test-support/world.ts";

const Fields = z.object({ company: z.string(), seats: z.number() });
const noNetwork: typeof fetch = async () => {
  throw new Error("network used in cassette mode");
};

let dir: Awaited<ReturnType<typeof tempDir>>;
const worlds: World[] = [];
beforeEach(async () => {
  dir = await tempDir();
});
afterEach(async () => {
  for (const w of worlds.splice(0)) await w.close();
  await dir.remove();
});

async function world(
  mode: "record" | "cassette",
  extra: Parameters<typeof makeWorld>[0] = {},
): Promise<World> {
  const w = await makeWorld({
    mode,
    cassetteDir: dir.path,
    ...(mode === "cassette" ? { fetch: noNetwork } : {}),
    ...extra,
  });
  worlds.push(w);
  return w;
}

function readCassette(purpose: string, key: string): CassetteFile {
  return JSON.parse(readFileSync(cassettePath(dir.path, purpose, key), "utf8")) as CassetteFile;
}

describe("cassettes", () => {
  it("record writes fixtures/cassettes/<purpose>/<key>.json; cassette mode replays it without network", async () => {
    const recorder = await world("record");
    const image = await recorder.put(pngBytes(7), "image/png");
    const req = {
      model: "muse-spark-1.3",
      instructions: "Extract the fields.",
      input: [
        { type: "text", text: "Referral from Caravela" },
        { type: "image", image },
      ] as InputPart[],
      schemaName: "Fields",
      schema: Fields,
    };
    const reply = responseBody([messageItem('{"company":"Acme Group","seats":25}')], { id: "resp_rec" });
    recorder.server.on("/v1/responses", { json: reply });

    const recorded = await recorder.gateway.structured(req, ctx("extract"));

    const key = cassetteKey("extract", structuredKeyMaterial(req));
    expect(key).toMatch(/^extract-[0-9a-f]{16}$/);
    const file = readCassette("extract", key);
    expect(file).toMatchObject({ key, purpose: "extract", recordedAt: "2026-10-27T12:00:00.000Z" });
    expect(file.exchanges).toEqual([{ response: reply }]);
    expect(recorder.ledger.rows[0]?.provider).toBe("meta");

    const player = await world("cassette");
    const sameImage = await player.put(pngBytes(7), "image/png");
    const replayed = await player.gateway.structured(
      { ...req, input: [req.input[0] as InputPart, { type: "image", image: sameImage }] },
      ctx("extract"),
    );

    expect(replayed).toEqual(recorded);
    expect(player.server.requests).toHaveLength(0);
    expect(player.ledger.rows[0]).toMatchObject({
      provider: "cassette",
      responseId: "resp_rec",
      inputTokens: 1200,
      images: 1,
    });
    expect(player.ledger.rows[0]?.costUsd).toBeCloseTo(0.002555, 12);
  });

  it("a cassette miss is a MODEL_ERROR that names the key", async () => {
    const player = await world("cassette");
    const req = {
      model: "muse-spark-1.3",
      instructions: "x",
      input: [{ type: "text" as const, text: "never recorded" }],
      schemaName: "Fields",
      schema: Fields,
    };
    const key = cassetteKey("understand", structuredKeyMaterial(req));

    const failure = player.gateway.structured(req, ctx("understand"));

    await expect(failure).rejects.toMatchObject({ code: "MODEL_ERROR" });
    await expect(player.gateway.structured(req, ctx("understand"))).rejects.toThrow(key);
    expect(player.ledger.rows[0]).toMatchObject({
      provider: "cassette",
      status: "error",
      errorCode: "MODEL_ERROR",
    });
  });

  it("records a validation retry as two exchanges and replays both attempts", async () => {
    const recorder = await world("record");
    recorder.server.on(
      "/v1/responses",
      { json: responseBody([messageItem("not json")]) },
      { json: responseBody([messageItem('{"company":"Globex Industrial","seats":40}')]) },
    );
    const req = {
      model: "muse-spark-1.3",
      instructions: "x",
      input: [{ type: "text" as const, text: "40 seats" }],
      schemaName: "Fields",
      schema: Fields,
    };
    await recorder.gateway.structured(req, ctx("understand"));
    expect(
      readCassette("understand", cassetteKey("understand", structuredKeyMaterial(req))).exchanges,
    ).toHaveLength(2);

    const player = await world("cassette");
    expect(await player.gateway.structured(req, ctx("understand"))).toEqual({
      company: "Globex Industrial",
      seats: 40,
    });
    expect(player.ledger.rows.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("records computer-use sessions turn by turn and replays them in sequence", async () => {
    const recorder = await world("record");
    recorder.server.on(
      "/v1/responses",
      { json: responseBody([docFixture("computer-use.computer_call.json")], { id: "resp_1" }) },
      {
        json: responseBody(
          [
            {
              type: "function_call",
              call_id: "call_fn",
              name: "request_commit",
              arguments: '{"summary":"s"}',
            },
          ],
          {
            id: "resp_2",
          },
        ),
      },
      { json: responseBody([messageItem("Registered: REG-1042")], { id: "resp_3" }) },
    );
    const functions = [
      {
        name: "request_commit",
        description: "Ask for approval",
        parameters: { type: "object", properties: {} },
      },
    ];
    const recModel = recorder.gateway.computerUse({ model: "muse-spark-1.3" });
    const session = recModel.open({ instructions: "Operate the portal.", functions });
    const task = "Register the Acme Group deal on Caravela Partner Hub";
    const key = cassetteKey("cu_first_run", {
      model: "muse-spark-1.3",
      instructions: "Operate the portal.",
      functions,
      first: task,
    });

    const t1 = await session.send({ kind: "start", task, screenshot: pngBytes(1) }, ctx("cu_first_run"));
    expect(readCassette("cu_first_run", key).exchanges.map((e) => e.label)).toEqual(["start"]);
    const t2 = await session.send(
      { kind: "computer_output", callId: "call_abc123", screenshot: pngBytes(2), acknowledged: [] },
      ctx("cu_first_run"),
    );
    const t3 = await session.send(
      { kind: "function_output", callId: "call_fn", output: "approved" },
      ctx("cu_first_run"),
    );
    expect(readCassette("cu_first_run", key).exchanges.map((e) => e.label)).toEqual([
      "start",
      "computer_output",
      "function_output",
    ]);

    const player = await world("cassette");
    const playModel = player.gateway.computerUse({ model: "muse-spark-1.3" });
    expect(playModel.provider).toBe("cassette");
    const replay = playModel.open({ instructions: "Operate the portal.", functions });
    // Screenshots differ between runs (fonts, timing): the session key does not depend on pixels.
    expect(await replay.send({ kind: "start", task, screenshot: pngBytes(99) }, ctx("cu_first_run"))).toEqual(
      t1,
    );
    expect(
      await replay.send(
        { kind: "computer_output", callId: "call_abc123", screenshot: pngBytes(98), acknowledged: [] },
        ctx("cu_first_run"),
      ),
    ).toEqual(t2);
    expect(
      await replay.send(
        { kind: "function_output", callId: "call_fn", output: "approved" },
        ctx("cu_first_run"),
      ),
    ).toEqual(t3);
    expect(player.ledger.rows.map((r) => r.provider)).toEqual(["cassette", "cassette", "cassette"]);
    expect(player.server.requests).toHaveLength(0);

    const diverged = playModel.open({ instructions: "Operate the portal.", functions });
    await diverged.send({ kind: "start", task, screenshot: pngBytes() }, ctx("cu_first_run"));
    await expect(
      diverged.send({ kind: "function_output", callId: "call_abc123", output: "x" }, ctx("cu_first_run")),
    ).rejects.toThrow(/recorded for "computer_output"/);
  });

  it("records and replays transcriptions keyed by the WAV hash and biasing options", async () => {
    const recorder = await world("record");
    const wav = await recorder.put(wavBytes(), "audio/wav", "audio_wav");
    recorder.server.on("/v1/asr/transcribe", { json: docFixture("speech-to-text.transcribe-response.json") });
    const recorded = await recorder.gateway.transcribe(
      wav,
      { languageBias: ["Portuguese"] },
      ctx("transcribe"),
    );
    const key = cassetteKey("transcribe", {
      model: "muse-voice-transcribe-1.0",
      wav: wav.sha256,
      languageBias: ["Portuguese"],
      keywords: [],
    });
    expect(existsSync(cassettePath(dir.path, "transcribe", key))).toBe(true);

    const player = await world("cassette");
    const sameWav = await player.put(wavBytes(), "audio/wav", "audio_wav");
    expect(
      await player.gateway.transcribe(sameWav, { languageBias: ["Portuguese"] }, ctx("transcribe")),
    ).toEqual(recorded);
    // 1.5 s billed as 1 s: 1 / 3600 h * $0.18
    expect(player.ledger.rows[0]).toMatchObject({ provider: "cassette", audioMs: 1500 });
    expect(player.ledger.rows[0]?.costUsd).toBeCloseTo(0.00005, 12);
    await expect(
      player.gateway.transcribe(sameWav, { languageBias: ["English"] }, ctx("transcribe")),
    ).rejects.toMatchObject({
      code: "MODEL_ERROR",
    });
  });

  it("cassette mode keeps rung 2 available without a Baseten key and replays Baseten calls", async () => {
    const recorder = await world("record");
    recorder.server.on("/baseten/v1/chat/completions", {
      json: {
        id: "chatcmpl-9",
        choices: [{ message: { content: '{"company":"Acme Group","seats":3}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      },
    });
    const req = {
      model: OPEN_WEIGHTS_MODEL,
      instructions: "x",
      input: [{ type: "text" as const, text: "pick" }],
      schemaName: "Fields",
      schema: Fields,
    };
    await recorder.gateway.structured(req, ctx("heal_match"));

    const player = await world("cassette", { openWeights: { apiKey: undefined } });
    expect(player.gateway.hasOpenWeights()).toBe(true);
    expect(await player.gateway.structured(req, ctx("heal_match"))).toEqual({
      company: "Acme Group",
      seats: 3,
    });
    expect(player.ledger.rows[0]).toMatchObject({
      provider: "cassette",
      model: OPEN_WEIGHTS_MODEL,
      responseId: "chatcmpl-9",
    });
  });
});

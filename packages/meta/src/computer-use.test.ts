import { type CuSession, DockhandError, type FunctionTool } from "@dockhand/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  b64,
  ctx,
  docFixture,
  jpegBytes,
  makeWorld,
  messageItem,
  must,
  pdfBytes,
  pngBytes,
  reasoningItem,
  responseBody,
  shapeOf,
  type World,
} from "./test-support/world.ts";

const INSTRUCTIONS = "You operate one browser tab, 1280x800.";
const REQUEST_COMMIT: FunctionTool = {
  name: "request_commit",
  description: "Ask the rep to approve the final submit.",
  parameters: {
    type: "object",
    properties: { summary: { type: "string" } },
    required: ["summary"],
    additionalProperties: false,
  },
};
const WONDER_USAGE = {
  input_tokens: 2000,
  input_tokens_details: { cached_tokens: 1000 },
  output_tokens: 100,
  output_tokens_details: { reasoning_tokens: 40 },
  total_tokens: 2100,
};

let world: World;
afterEach(async () => {
  await world?.close();
});

function computerCall(callId: string, o: { action?: unknown; actions?: unknown[]; checks?: unknown[] } = {}) {
  return {
    type: "computer_call",
    id: `cc_${callId}`,
    call_id: callId,
    ...(o.action ? { action: o.action } : {}),
    ...(o.actions ? { actions: o.actions } : {}),
    pending_safety_checks: o.checks ?? [],
    status: "completed",
  };
}

function functionCall(callId: string, name: string, args: string) {
  return {
    type: "function_call",
    id: `fc_${callId}`,
    call_id: callId,
    name,
    arguments: args,
    status: "completed",
  };
}

function open(model = "muse-wonder-1.0"): CuSession {
  return world.gateway
    .computerUse({ model, effort: "low" })
    .open({ instructions: INSTRUCTIONS, functions: [REQUEST_COMMIT] });
}

function bodies(): Record<string, unknown>[] {
  return world.server.requestsTo("/v1/responses").map((r) => r.json as Record<string, unknown>);
}

describe("computer use (live)", () => {
  it("first send: task + screenshot as a user message, computer tool plus function tools, store true", async () => {
    world = await makeWorld();
    const shot = pngBytes(1);
    world.server.on("/v1/responses", {
      json: responseBody([reasoningItem(), computerCall("call_1", { action: { type: "screenshot" } })], {
        id: "resp_1",
      }),
    });

    const model = world.gateway.computerUse({ model: "muse-wonder-1.0", effort: "low" });
    expect(model.provider).toBe("meta");
    const session = model.open({ instructions: INSTRUCTIONS, functions: [REQUEST_COMMIT] });
    await session.send(
      { kind: "start", task: "Register the Acme Group deal", screenshot: shot },
      ctx("cu_first_run"),
    );

    const [first] = bodies();
    expect(first).toEqual({
      model: "muse-wonder-1.0",
      instructions: INSTRUCTIONS,
      tools: [
        { type: "computer" },
        {
          type: "function",
          name: "request_commit",
          description: REQUEST_COMMIT.description,
          parameters: REQUEST_COMMIT.parameters,
          strict: false,
        },
      ],
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Register the Acme Group deal" },
            { type: "input_image", image_url: `data:image/png;base64,${b64(shot)}` },
          ],
        },
      ],
      reasoning: { effort: "low" },
      store: true,
    });
    // Documented first request: same input structure; we add store, reasoning and function tools.
    const documented = docFixture<Record<string, unknown>>("computer-use.first-request.json");
    expect(shapeOf(first?.input)).toEqual(shapeOf(documented.input));
    expect((must(first).tools as unknown[])[0]).toEqual((documented.tools as unknown[])[0]);
    // Same flat function-tool layout as the tool-calling page.
    const documentedTool = docFixture<Record<string, unknown>>("tool-calling.function-tool.json");
    const sentTool = (must(first).tools as Record<string, unknown>[])[1] ?? {};
    expect(
      Object.keys(sentTool)
        .filter((k) => k !== "strict")
        .sort(),
    ).toEqual(Object.keys(documentedTool).sort());
  });

  it("normalizes a singular action, keeps pending safety checks, skips reasoning", async () => {
    world = await makeWorld();
    const check = {
      id: "csc_123",
      code: "malicious_instructions",
      message: "Potentially unsafe action detected.",
    };
    world.server.on("/v1/responses", {
      json: responseBody([
        reasoningItem(),
        computerCall("call_1", {
          action: { type: "click", button: "left", x: 412, y: 315 },
          checks: [check],
        }),
      ]),
    });

    const turns = await open().send(
      { kind: "start", task: "t", screenshot: pngBytes() },
      ctx("cu_first_run"),
    );

    expect(turns).toEqual([
      {
        kind: "computer_call",
        callId: "call_1",
        actions: [{ type: "click", button: "left", x: 412, y: 315 }],
        safetyChecks: [check],
      },
    ]);
  });

  it("parses the documented computer_call example", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", { json: responseBody([docFixture("computer-use.computer_call.json")]) });

    const turns = await open().send(
      { kind: "start", task: "t", screenshot: pngBytes() },
      ctx("cu_first_run"),
    );

    expect(turns).toEqual([
      {
        kind: "computer_call",
        callId: "call_abc123",
        actions: [
          { type: "click", button: "left", x: 412, y: 315 },
          { type: "type", text: "quarterly revenue" },
          { type: "keypress", keys: ["Enter"] },
        ],
        safetyChecks: [],
      },
    ]);
  });

  it("next send: computer_call_output with acknowledged checks, chained by previous_response_id, settings re-sent", async () => {
    world = await makeWorld();
    const check = {
      id: "csc_123",
      code: "malicious_instructions",
      message: "Potentially unsafe action detected.",
    };
    world.server.on(
      "/v1/responses",
      {
        json: responseBody([computerCall("call_def456", { actions: [{ type: "wait" }], checks: [check] })], {
          id: "resp_1",
        }),
      },
      { json: responseBody([messageItem("Registered: REG-1042")], { id: "resp_2" }) },
    );
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes(1) }, ctx("cu_first_run"));

    const shot = jpegBytes();
    const turns = await session.send(
      { kind: "computer_output", callId: "call_def456", screenshot: shot, acknowledged: [check] },
      ctx("cu_first_run"),
    );

    expect(turns).toEqual([{ kind: "final", text: "Registered: REG-1042" }]);
    const second = bodies()[1];
    expect(second?.previous_response_id).toBe("resp_1");
    expect(second?.instructions).toBe(INSTRUCTIONS);
    expect(second?.tools).toEqual(bodies()[0]?.tools);
    expect(second?.reasoning).toEqual({ effort: "low" });
    expect(second?.store).toBe(true);
    expect(second?.input).toEqual([
      {
        type: "computer_call_output",
        call_id: "call_def456",
        acknowledged_safety_checks: [check],
        output: { type: "computer_screenshot", image_url: `data:image/jpeg;base64,${b64(shot)}` },
      },
    ]);
    const documented = docFixture("computer-use.computer_call_output.safety-ack.json");
    expect(shapeOf((must(second).input as unknown[])[0])).toEqual(shapeOf(documented));
    expect(shapeOf(docFixture<Record<string, unknown>>("computer-use.next-request.json").input)).toEqual(
      shapeOf(
        ((second?.input as Record<string, unknown>[]) ?? []).map((item) => ({
          ...item,
          acknowledged_safety_checks: [],
        })),
      ),
    );
  });

  it("sends a harness note as a user input_text message after the computer_call_output", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      {
        json: responseBody([computerCall("call_1", { actions: [{ type: "click", x: 600, y: 700 }] })], {
          id: "resp_1",
        }),
      },
      {
        json: responseBody([functionCall("call_2", "request_commit", '{"summary":"ok"}')], { id: "resp_2" }),
      },
    );
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));

    const shot = pngBytes(2);
    await session.send(
      {
        kind: "computer_output",
        callId: "call_1",
        screenshot: shot,
        acknowledged: [],
        note: "Submitting is gated: call request_commit first",
      },
      ctx("cu_first_run"),
    );

    expect(bodies()[1]?.input).toEqual([
      {
        type: "computer_call_output",
        call_id: "call_1",
        acknowledged_safety_checks: [],
        output: { type: "computer_screenshot", image_url: `data:image/png;base64,${b64(shot)}` },
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "Submitting is gated: call request_commit first" }],
      },
    ]);
    expect(session.imagesInChain()).toBe(2);
  });

  it("function_call -> function_call_output, with the screenshot as a user input_image message", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      {
        json: responseBody([functionCall("call_9", "request_commit", '{"summary":"Acme Group, 25 seats"}')], {
          id: "resp_1",
        }),
      },
      {
        json: responseBody([computerCall("call_10", { actions: [{ type: "click", x: 1, y: 2 }] })], {
          id: "resp_2",
        }),
      },
      { json: responseBody([messageItem("done")], { id: "resp_3" }) },
    );
    const session = open();

    const turns = await session.send(
      { kind: "start", task: "t", screenshot: pngBytes() },
      ctx("cu_first_run"),
    );
    expect(turns).toEqual([
      {
        kind: "function_call",
        callId: "call_9",
        name: "request_commit",
        argsJson: '{"summary":"Acme Group, 25 seats"}',
      },
    ]);

    const shot = pngBytes(3);
    await session.send(
      {
        kind: "function_output",
        callId: "call_9",
        output: 'approved: click "Submit registration" now',
        screenshot: shot,
      },
      ctx("cu_first_run"),
    );
    expect(bodies()[1]?.previous_response_id).toBe("resp_1");
    expect(bodies()[1]?.input).toEqual([
      {
        type: "function_call_output",
        call_id: "call_9",
        output: 'approved: click "Submit registration" now',
      },
      { role: "user", content: [{ type: "input_image", image_url: `data:image/png;base64,${b64(shot)}` }] },
    ]);
    const documented = docFixture("tool-calling.function-call-output.json");
    expect(shapeOf((must(bodies()[1]).input as unknown[])[0])).toEqual(shapeOf(documented));
    expect(session.imagesInChain()).toBe(2);

    await session.send(
      { kind: "function_output", callId: "call_10", output: "not_ready: Phone is empty" },
      ctx("cu_first_run"),
    );
    expect(bodies()[2]?.input).toEqual([
      { type: "function_call_output", call_id: "call_10", output: "not_ready: Phone is empty" },
    ]);
    expect(session.imagesInChain()).toBe(2);
  });

  it("returns the assistant message as final and skips commentary", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", {
      json: responseBody([
        messageItem("Let me open the form first.", { phase: "commentary" }),
        computerCall("call_1", { actions: [{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 300 }] }),
        messageItem("Registration REG-77 is shown."),
      ]),
    });

    const turns = await open().send(
      { kind: "start", task: "t", screenshot: pngBytes() },
      ctx("cu_first_run"),
    );

    expect(turns).toEqual([
      {
        kind: "computer_call",
        callId: "call_1",
        actions: [{ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 300 }],
        safetyChecks: [],
      },
      { kind: "final", text: "Registration REG-77 is shown." },
    ]);
  });

  it("rollover starts a new chain: no previous_response_id, summary + screenshot, image count reset", async () => {
    world = await makeWorld();
    const next = (id: string) => ({
      json: responseBody([computerCall(`call_${id}`, { actions: [{ type: "wait" }] })], { id }),
    });
    world.server.on("/v1/responses", next("resp_1"), next("resp_2"), next("resp_3"), next("resp_4"));
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));
    await session.send(
      { kind: "computer_output", callId: "call_resp_1", screenshot: pngBytes(), acknowledged: [] },
      ctx("cu_first_run"),
    );
    expect(session.imagesInChain()).toBe(2);

    const shot = pngBytes(4);
    await session.send(
      { kind: "rollover", summary: "Fields done: Company=Acme Group. Remaining: Seats.", screenshot: shot },
      ctx("cu_first_run"),
    );

    const rollover = bodies()[2];
    expect(rollover?.previous_response_id).toBeUndefined();
    expect(rollover?.input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Fields done: Company=Acme Group. Remaining: Seats." },
          { type: "input_image", image_url: `data:image/png;base64,${b64(shot)}` },
        ],
      },
    ]);
    expect(session.imagesInChain()).toBe(1);

    await session.send(
      { kind: "computer_output", callId: "call_resp_3", screenshot: pngBytes(), acknowledged: [] },
      ctx("cu_first_run"),
    );
    expect(bodies()[3]?.previous_response_id).toBe("resp_3");
  });

  it("incomplete: returns only the incomplete turn and does not advance the chain", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      { json: responseBody([computerCall("call_1", { actions: [{ type: "wait" }] })], { id: "resp_1" }) },
      {
        json: responseBody(
          [
            reasoningItem(),
            { ...computerCall("call_2", { actions: [{ type: "click", x: 5, y: 5 }] }), status: "incomplete" },
          ],
          {
            id: "resp_2",
            status: "incomplete",
            incomplete: "max_output_tokens",
          },
        ),
      },
      { json: responseBody([messageItem("done")], { id: "resp_3" }) },
    );
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));
    const reply = {
      kind: "computer_output" as const,
      callId: "call_1",
      screenshot: pngBytes(),
      acknowledged: [],
    };

    const turns = await session.send(reply, ctx("cu_first_run"));
    expect(turns).toEqual([{ kind: "incomplete", reason: "max_output_tokens" }]);
    expect(session.imagesInChain()).toBe(1);
    expect(world.ledger.rows[1]).toMatchObject({ status: "incomplete", errorCode: "MODEL_INCOMPLETE" });

    await session.send(reply, ctx("cu_first_run"));
    expect(bodies()[2]?.previous_response_id).toBe("resp_1");
    expect(session.imagesInChain()).toBe(2);
  });

  it("records one ledger row per turn at Muse Wonder's Standard price", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      {
        json: responseBody([computerCall("call_1", { actions: [{ type: "wait" }] })], {
          id: "resp_1",
          usage: WONDER_USAGE,
        }),
      },
      { json: responseBody([messageItem("done")], { id: "resp_2", usage: WONDER_USAGE }) },
    );
    const session = open();
    await session.send(
      { kind: "start", task: "t", screenshot: pngBytes() },
      ctx("cu_repair", { runId: "run-3", stepIdx: 4 }),
    );
    await session.send(
      { kind: "computer_output", callId: "call_1", screenshot: pngBytes(), acknowledged: [] },
      ctx("cu_repair", { runId: "run-3", stepIdx: 4 }),
    );

    expect(world.ledger.rows).toHaveLength(2);
    for (const [i, row] of world.ledger.rows.entries()) {
      expect(row).toMatchObject({
        purpose: "cu_repair",
        provider: "meta",
        model: "muse-wonder-1.0",
        runId: "run-3",
        stepIdx: 4,
        responseId: `resp_${i + 1}`,
        inputTokens: 2000,
        cachedInputTokens: 1000,
        outputTokens: 100,
        reasoningTokens: 40,
        images: 1,
        status: "ok",
      });
      // (2000 - 1000) * 4.00 + 1000 * 0.20 + 100 * 20.00 = 6200 per 1M tokens
      expect(row.costUsd).toBeCloseTo(0.0062, 12);
    }
  });

  it("sends parallel_tool_calls: false only when the gateway option is set", async () => {
    world = await makeWorld({ disableParallelToolCalls: true });
    world.server.on("/v1/responses", { json: responseBody([messageItem("done")]) });
    await open().send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));
    expect(bodies()[0]?.parallel_tool_calls).toBe(false);
  });

  it("refuses a 51st image in one chain with TOO_MANY_IMAGES (roll over first)", async () => {
    world = await makeWorld();
    const replies = Array.from({ length: 50 }, (_, i) => ({
      json: responseBody([computerCall(`call_${i}`, { actions: [{ type: "wait" }] })], { id: `resp_${i}` }),
    }));
    world.server.on("/v1/responses", ...replies);
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));
    for (let i = 0; i < 49; i++) {
      await session.send(
        { kind: "computer_output", callId: `call_${i}`, screenshot: pngBytes(), acknowledged: [] },
        ctx("cu_first_run"),
      );
    }
    expect(session.imagesInChain()).toBe(50);

    await expect(
      session.send(
        { kind: "computer_output", callId: "call_49", screenshot: pngBytes(), acknowledged: [] },
        ctx("cu_first_run"),
      ),
    ).rejects.toMatchObject({ code: "TOO_MANY_IMAGES" });
    expect(world.server.requestsTo("/v1/responses")).toHaveLength(50);
  });

  it("retries once when a chained previous_response_id is not persisted yet", async () => {
    world = await makeWorld();
    world.server.on(
      "/v1/responses",
      { json: responseBody([computerCall("call_1", { actions: [{ type: "wait" }] })], { id: "resp_1" }) },
      {
        status: 400,
        json: {
          error: {
            message: "Previous response with id 'resp_1' not found.",
            type: "invalid_request_error",
            param: "previous_response_id",
            code: null,
          },
        },
      },
      { json: responseBody([messageItem("done")], { id: "resp_2" }) },
    );
    const session = open();
    await session.send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run"));

    const turns = await session.send(
      { kind: "computer_output", callId: "call_1", screenshot: pngBytes(), acknowledged: [] },
      ctx("cu_first_run"),
    );

    expect(turns).toEqual([{ kind: "final", text: "done" }]);
    expect(world.sleeps).toEqual([1000]);
    expect(world.ledger.rows).toHaveLength(2);
  });

  it("rejects unknown actions, bad screenshots, bad function names and sends before start", async () => {
    world = await makeWorld();
    world.server.on("/v1/responses", {
      json: responseBody([computerCall("call_1", { actions: [{ type: "teleport", x: 1, y: 1 }] })]),
    });

    await expect(
      open().send({ kind: "start", task: "t", screenshot: pngBytes() }, ctx("cu_first_run")),
    ).rejects.toMatchObject({
      code: "MODEL_INVALID_OUTPUT",
    });
    expect(world.ledger.rows[0]).toMatchObject({ status: "error", errorCode: "MODEL_INVALID_OUTPUT" });

    await expect(
      open().send({ kind: "start", task: "t", screenshot: pdfBytes() }, ctx("cu_first_run")),
    ).rejects.toMatchObject({
      code: "MEDIA_UNSUPPORTED",
    });
    await expect(
      open().send(
        { kind: "computer_output", callId: "c", screenshot: pngBytes(), acknowledged: [] },
        ctx("cu_first_run"),
      ),
    ).rejects.toBeInstanceOf(DockhandError);
    expect(() =>
      world.gateway
        .computerUse({ model: "muse-wonder-1.0" })
        .open({ instructions: "x", functions: [{ ...REQUEST_COMMIT, name: "a.b.c" }] }),
    ).toThrow(/not allowed/);
    expect(world.server.requestsTo("/v1/responses")).toHaveLength(1);
  });
});

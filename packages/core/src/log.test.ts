import { afterEach, describe, expect, it } from "vitest";
import { DockhandError } from "./contracts/base.ts";
import { createLogger } from "./log.ts";

function capture(level?: string, fields?: Record<string, unknown>) {
  const lines: Record<string, unknown>[] = [];
  const log = createLogger({ level, fields, write: (line) => lines.push(JSON.parse(line)) });
  return { log, lines };
}

describe("createLogger", () => {
  const savedLevel = process.env.LOG_LEVEL;
  afterEach(() => {
    if (savedLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = savedLevel;
  });

  it("writes one JSON object per line with ts, level, msg and fields", () => {
    const { log, lines } = capture("debug", { svc: "gateway" });
    log.info("webhook received", { messages: 2 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: "info", msg: "webhook received", svc: "gateway", messages: 2 });
    expect(Object.keys(lines[0] ?? {}).slice(0, 3)).toEqual(["ts", "level", "msg"]);
    expect(new Date(String(lines[0]?.ts)).toISOString()).toBe(lines[0]?.ts);
  });

  it("child loggers add fields and keep the level", () => {
    const { log, lines } = capture("warn", { svc: "gateway" });
    const child = log.child({ jobId: "J1" }).child({ step: 3 });
    child.info("dropped");
    child.warn("kept", { extra: true });
    expect(lines).toEqual([
      expect.objectContaining({ msg: "kept", svc: "gateway", jobId: "J1", step: 3, extra: true }),
    ]);
  });

  it("filters by level; silent mutes; unknown levels fall back to info", () => {
    const warn = capture("warn");
    warn.log.debug("a");
    warn.log.info("b");
    warn.log.warn("c");
    warn.log.error("d");
    expect(warn.lines.map((l) => l.msg)).toEqual(["c", "d"]);

    const silent = capture("silent");
    silent.log.error("x");
    expect(silent.lines).toHaveLength(0);

    const fallback = capture("loud");
    fallback.log.debug("hidden");
    fallback.log.info("shown");
    expect(fallback.lines.map((l) => l.msg)).toEqual(["shown"]);
  });

  it("reads LOG_LEVEL when no level is given", () => {
    process.env.LOG_LEVEL = "error";
    const { log, lines } = capture();
    log.warn("hidden");
    log.error("shown");
    expect(lines.map((l) => l.msg)).toEqual(["shown"]);
  });

  it("never dumps bytes or huge strings, and serializes errors", () => {
    const { log, lines } = capture("debug");
    log.error("boom", {
      err: new DockhandError("TOOL_ERROR", "graph said no"),
      image: new Uint8Array(4096),
      buffer: Buffer.alloc(10),
      body: "x".repeat(5000),
      big: 10n,
    });
    const line = lines[0] ?? {};
    expect(line.err).toMatchObject({ name: "DockhandError", message: "graph said no", code: "TOOL_ERROR" });
    expect(line.image).toEqual({ bytes: 4096 });
    expect(line.buffer).toEqual({ bytes: 10 });
    expect(String(line.body).length).toBeLessThan(2100);
    expect(String(line.body)).toContain("(+3000 chars)");
    expect(line.big).toBe("10");
  });

  it("survives circular fields", () => {
    const { log, lines } = capture("debug");
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    log.info("circular", { loop });
    expect(lines[0]).toMatchObject({ level: "info", msg: "circular" });
    expect(String(lines[0]?.logError)).toContain("not serializable");
  });

  it("cannot overwrite ts, level or msg through fields", () => {
    const { log, lines } = capture("debug", { level: "fake" });
    log.info("real", { msg: "fake" });
    expect(lines[0]).toMatchObject({ level: "info", msg: "real" });
  });
});

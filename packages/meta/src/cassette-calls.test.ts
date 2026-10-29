import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFixedClock, createLogger } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CassetteFile, cassetteKey, cassettePath, createCassettes } from "./cassette.ts";

const clock = createFixedClock(Date.UTC(2026, 9, 29, 20, 0, 0));
const log = createLogger({ level: "silent" });
const KEY = cassetteKey("extract", { photo: "sha-of-the-same-photo" });
const noNetwork = async (): Promise<unknown> => {
  throw new Error("network used in replay");
};

let dir: string;
let previousVarDir: string | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dockhand-cassettes-"));
  previousVarDir = process.env.DOCKHAND_VAR_DIR;
  process.env.DOCKHAND_VAR_DIR = join(dir, "var");
});
afterEach(async () => {
  if (previousVarDir === undefined) delete process.env.DOCKHAND_VAR_DIR;
  else process.env.DOCKHAND_VAR_DIR = previousVarDir;
  await rm(dir, { recursive: true, force: true });
});

/** One logical call: open a tape, run one exchange, save. */
async function call(cassettes: ReturnType<typeof createCassettes>, response: unknown, material?: unknown) {
  const tape = cassettes.tape("extract", KEY, material);
  const got = await tape.next(async () => response);
  await tape.save();
  return got;
}

describe("cassettes with repeated keys", () => {
  it("records every call with the same key in order, and replays the n-th call with the n-th recording", async () => {
    const rec = createCassettes({ mode: "record", dir, clock, log });
    await call(rec, { text: "first extraction" }, { photo: "sha" });
    await call(rec, { text: "second extraction, worded differently" }, { photo: "sha" });

    const file = JSON.parse(await readFile(cassettePath(dir, "extract", KEY), "utf8")) as CassetteFile;
    expect(file.exchanges).toEqual([{ response: { text: "first extraction" } }]);
    expect(file.laterCalls).toEqual([[{ response: { text: "second extraction, worded differently" } }]]);
    expect(file.material).toEqual({ photo: "sha" });

    const play = createCassettes({ mode: "replay", dir, clock, log });
    expect(await call(play, noNetwork)).toEqual({ text: "first extraction" });
    expect(await call(play, noNetwork)).toEqual({ text: "second extraction, worded differently" });
    // Beyond the recorded calls, the last recording repeats.
    expect(await call(play, noNetwork)).toEqual({ text: "second extraction, worded differently" });
  });

  it("replays a single-call file (the older format) for every call", async () => {
    const path = cassettePath(dir, "extract", KEY);
    await mkdir(dirname(path), { recursive: true });
    const old: CassetteFile = {
      key: KEY,
      purpose: "extract",
      recordedAt: "",
      exchanges: [{ response: "only" }],
    };
    await writeFile(path, JSON.stringify(old));
    const play = createCassettes({ mode: "replay", dir, clock, log });
    expect(await call(play, noNetwork)).toBe("only");
    expect(await call(play, noNetwork)).toBe("only");
  });

  it("starts the file over in a new recording session", async () => {
    await call(createCassettes({ mode: "record", dir, clock, log }), "old a");
    await call(createCassettes({ mode: "record", dir, clock, log }), "new a");
    const file = JSON.parse(await readFile(cassettePath(dir, "extract", KEY), "utf8")) as CassetteFile;
    expect(file.exchanges).toEqual([{ response: "new a" }]);
    expect(file.laterCalls).toBeUndefined();
  });

  it("writes the key material of a replay miss under the var dir, and names it in the error", async () => {
    const play = createCassettes({ mode: "replay", dir, clock, log });
    const missing = cassetteKey("extract", { photo: "never recorded" });
    const tape = play.tape("extract", missing, { photo: "never recorded" });
    await expect(tape.next(noNetwork)).rejects.toThrow(/key material written to/);
    const dump = JSON.parse(
      await readFile(join(dir, "var", "cassette-misses", "extract", `${missing}.json`), "utf8"),
    );
    expect(dump).toEqual({ key: missing, material: { photo: "never recorded" } });
  });
});

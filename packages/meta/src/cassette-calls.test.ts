import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFixedClock, createLogger } from "@dockhand/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CassetteFile, cassetteKey, cassettePath, createCassettes, withoutClock } from "./cassette.ts";

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

describe("cassette replay with a page clock in the request", () => {
  it("blanks dates and times of day in every common format", () => {
    const s = withoutClock(
      "SUBMITTED 29 Oct 2026, 17:32 · Thu 2026-10-29 · Oct 29, 2026 · 29/10/2026 · 5:32 PM · 2026-10-29T17:32:05Z",
    );
    expect(s).toBe("SUBMITTED <date>, <time> · <date> · <date> · <date> · <time> · <date>");
  });

  it("blanks them inside an embedded JSON document too, where a line break is a literal \\n", () => {
    // The annotation request carries the confirmation page as a JSON string: "SUBMITTED\n30 Oct 2026, 10:26".
    const embedded = String.raw`{"text":"STATUS\nPending review\nSUBMITTED\n30 Oct 2026, 10:26\nMon 2026-11-02\nRegistration"}`;
    expect(withoutClock(embedded)).toBe(
      String.raw`{"text":"STATUS\nPending review\nSUBMITTED\n<date>, <time>\n<date>\nRegistration"}`,
    );
    expect(withoutClock("Account 12:30 is not 1230 or a12:30")).toBe("Account <time> is not 1230 or a12:30");
  });

  it("serves a recording whose request differed only in clock values, when the exact key misses", async () => {
    const recordedAt = { page: "Registration received. SUBMITTED 29 Oct 2026, 17:32" };
    const rec = createCassettes({ mode: "record", dir, clock, log });
    const r = rec.tape("compile_annotate", cassetteKey("compile_annotate", recordedAt), recordedAt);
    await r.next(async () => ({ intents: "recorded" }));
    await r.save();

    const later = { page: "Registration received. SUBMITTED 2 Nov 2026, 09:05" };
    const play = createCassettes({ mode: "replay", dir, clock, log });
    const tape = play.tape("compile_annotate", cassetteKey("compile_annotate", later), later);
    expect(await tape.next(noNetwork)).toEqual({ intents: "recorded" });
  });

  it("still misses when the request differs in anything but the clock", async () => {
    const rec = createCassettes({ mode: "record", dir, clock, log });
    const a = { page: "Acme Group at 17:32" };
    const r = rec.tape("extract", cassetteKey("extract", a), a);
    await r.next(async () => "a");
    await r.save();
    const b = { page: "Globex Industrial at 09:05" };
    const play = createCassettes({ mode: "replay", dir, clock, log });
    await expect(play.tape("extract", cassetteKey("extract", b), b).next(noNetwork)).rejects.toThrow(
      /no cassette/,
    );
  });
});

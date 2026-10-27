import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createArtifactStore, createMemoryArtifactStore } from "./artifacts.ts";
import { createFixedClock } from "./clock.ts";
import { type Db, openDb } from "./db.ts";

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

describe("createArtifactStore", () => {
  let dir: string;
  let db: Db;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dockhand-artifacts-"));
    db = openDb(":memory:");
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes content-addressed files and an artifacts row", async () => {
    const clock = createFixedClock(1_761_566_400_000);
    const store = createArtifactStore(db, dir, clock);
    const ref = await store.put(PNG_BYTES, "image/png", {
      kind: "screenshot",
      jobId: "J1",
      runId: "R1",
      filename: "s.png",
    });

    const hash = sha(PNG_BYTES);
    expect(ref).toMatchObject({ sha256: hash, mime: "image/png", bytes: PNG_BYTES.byteLength });
    expect(ref.relPath).toBe(`artifacts/${hash.slice(0, 2)}/${hash}.png`);
    expect(store.absPath(ref)).toBe(join(dir, "artifacts", hash.slice(0, 2), `${hash}.png`));
    expect(new Uint8Array(readFileSync(store.absPath(ref)))).toEqual(PNG_BYTES);
    expect(db.raw.prepare("SELECT * FROM artifacts WHERE id = ?").get(ref.id)).toEqual({
      id: ref.id,
      sha256: hash,
      mime: "image/png",
      bytes: PNG_BYTES.byteLength,
      rel_path: ref.relPath,
      kind: "screenshot",
      job_id: "J1",
      run_id: "R1",
      filename: "s.png",
      created_at: 1_761_566_400_000,
    });
  });

  it("stores identical bytes once, with one row per put", async () => {
    const store = createArtifactStore(db, dir);
    const a = await store.put(PNG_BYTES, "image/png", { kind: "screenshot" });
    const b = await store.put(PNG_BYTES, "image/png", { kind: "receipt" });
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => store.put(PNG_BYTES, "image/png", { kind: "screenshot" })),
    );
    expect(b.relPath).toBe(a.relPath);
    expect(new Set([a.id, b.id, ...concurrent.map((r) => r.id)]).size).toBe(7);
    expect(filesUnder(dir)).toEqual([store.absPath(a)]); // one file, no temp leftovers
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM artifacts").get()).toEqual({ n: 7 });
  });

  it("reads by id or by ref and looks rows up with get()", async () => {
    const store = createArtifactStore(db, dir);
    const ref = await store.put(new TextEncoder().encode("hello"), "text/plain", { kind: "trace" });
    expect(store.get(ref.id)).toEqual(ref);
    expect(new TextDecoder().decode(await store.read(ref.id))).toBe("hello");
    expect(new TextDecoder().decode(await store.read(ref))).toBe("hello");
    expect(() => store.get("01NOPE")).toThrow(/not found/);
  });

  it("derives the extension from the MIME type, ignoring parameters", async () => {
    const store = createArtifactStore(db, dir);
    const ogg = await store.put(new Uint8Array([1]), "audio/ogg; codecs=opus", { kind: "inbound_media" });
    const pdf = await store.put(new Uint8Array([2]), "application/pdf", { kind: "quote_pdf" });
    const odd = await store.put(new Uint8Array([3]), "application/x-unknown", { kind: "upload_fixture" });
    expect(ogg.relPath).toMatch(/\.ogg$/);
    expect(ogg.mime).toBe("audio/ogg; codecs=opus");
    expect(pdf.relPath).toMatch(/\.pdf$/);
    expect(odd.relPath).toMatch(/\.bin$/);
  });
});

describe("createMemoryArtifactStore", () => {
  it("round-trips without db or disk and hands out copies", async () => {
    const store = createMemoryArtifactStore();
    const ref = await store.put(PNG_BYTES, "image/png", { kind: "screenshot" });
    const hash = sha(PNG_BYTES);
    expect(ref.relPath).toBe(`artifacts/${hash.slice(0, 2)}/${hash}.png`);
    expect(store.get(ref.id)).toEqual(ref);
    const data = await store.read(ref);
    expect(data).toEqual(PNG_BYTES);
    data[0] = 0;
    expect((await store.read(ref.id))[0]).toBe(0x89);
    expect(store.absPath(ref)).toBe(`memory://${ref.relPath}`);
    expect(() => store.get("missing")).toThrow(/not found/);
  });
});

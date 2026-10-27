import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { systemClock } from "./clock.ts";
import type { ArtifactKind, ArtifactRef, ArtifactStore, Clock, Id } from "./contracts/base.ts";
import type { Db } from "./db.ts";
import { ulid } from "./ids.ts";
import { contentPath } from "./mime.ts";
import { varDir } from "./paths.ts";

interface ArtifactRow {
  id: string;
  sha256: string;
  mime: string;
  bytes: number;
  rel_path: string;
}

/**
 * Content-addressed files under `<dir>/artifacts/ab/<sha256>.<ext>` plus one `artifacts` row per put.
 * Identical bytes share one file; each put still gets its own id (kind, job and run differ).
 */
export function createArtifactStore(
  db: Db,
  dir: string = varDir(),
  clock: Clock = systemClock,
): ArtifactStore {
  const insert = db.raw.prepare(
    `INSERT INTO artifacts (id, sha256, mime, bytes, rel_path, kind, job_id, run_id, filename, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const select = db.raw.prepare("SELECT id, sha256, mime, bytes, rel_path FROM artifacts WHERE id = ?");
  const absPath = (ref: ArtifactRef) => join(dir, ...ref.relPath.split("/"));

  const get = (id: Id): ArtifactRef => {
    const row = select.get(id) as ArtifactRow | undefined;
    if (!row) throw new Error(`artifact ${id} not found`);
    return { id: row.id, sha256: row.sha256, mime: row.mime, bytes: row.bytes, relPath: row.rel_path };
  };

  return {
    async put(data, mime, meta) {
      const sha256 = sha256Hex(data);
      const ref: ArtifactRef = {
        id: ulid(clock),
        sha256,
        mime,
        bytes: data.byteLength,
        relPath: contentPath(sha256, mime),
      };
      await writeOnce(absPath(ref), data);
      // File first, row second: an orphan file is harmless, a row without its file is not.
      insert.run(
        ref.id,
        sha256,
        mime,
        ref.bytes,
        ref.relPath,
        meta.kind,
        meta.jobId ?? null,
        meta.runId ?? null,
        meta.filename ?? null,
        clock.now(),
      );
      return ref;
    },
    get,
    async read(ref) {
      const resolved = typeof ref === "string" ? get(ref) : ref;
      return new Uint8Array(await readFile(absPath(resolved)));
    },
    absPath,
  };
}

/** Same contract, no db and no disk (tests). absPath() returns a `memory://` pseudo path. */
export function createMemoryArtifactStore(clock: Clock = systemClock): ArtifactStore {
  const items = new Map<Id, { ref: ArtifactRef; data: Uint8Array; kind: ArtifactKind }>();
  const find = (ref: ArtifactRef | Id) => {
    const item = items.get(typeof ref === "string" ? ref : ref.id);
    if (!item) throw new Error(`artifact ${typeof ref === "string" ? ref : ref.id} not found`);
    return item;
  };
  return {
    async put(data, mime, meta) {
      const sha256 = sha256Hex(data);
      const ref: ArtifactRef = {
        id: ulid(clock),
        sha256,
        mime,
        bytes: data.byteLength,
        relPath: contentPath(sha256, mime),
      };
      items.set(ref.id, { ref, data: data.slice(), kind: meta.kind });
      return { ...ref };
    },
    get: (id) => ({ ...find(id).ref }),
    read: async (ref) => find(ref).data.slice(),
    absPath: (ref) => `memory://${ref.relPath}`,
  };
}

function sha256Hex(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Temp file + rename. An existing target already holds identical bytes (content address), so skip it. */
async function writeOnce(target: string, data: Uint8Array): Promise<void> {
  if (await exists(target)) return;
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  await writeFile(temp, data);
  try {
    await rename(temp, target);
  } catch (err) {
    await rm(temp, { force: true });
    // A concurrent put of the same bytes won the race (on Windows the loser gets EPERM): same content.
    if (await exists(target)) return;
    throw err;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

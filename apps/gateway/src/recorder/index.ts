// The flight recorder: read-only pages over the run ledger, mounted at /recorder by the dev process.
//   GET /recorder                     runs, skills and teach drafts
//   GET /recorder/runs/:id            timeline (what the model saw and did, or replay steps), heals, read-back, $
//   GET /recorder/skills/:name?v=N    versions, readable diff vs the parent, compiled program, Playwright export
//   GET /recorder/teach/:id           "what Muse saw": frames, draft steps, typed params, success check
//   GET /recorder/a/:id               an artifact's bytes (Range requests, for video)
//   GET /recorder/frames/:id/:i?n=N   frame i of N from a video artifact (ffmpeg, cached on disk)

import { execFile } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import type { ArtifactStore, Db, Trace } from "@dockhand/core";
import { Hono } from "hono";
import { createRecorderData } from "./data.ts";
import { codeRevealView, type PickDoc, pickView } from "./reveal.ts";
import { indexView, type ReadBackDoc, runView, skillView, teachView } from "./views.ts";

const run = promisify(execFile);
const ID = /^[0-9A-Za-z_-]{1,64}$/;

export interface RecorderDeps {
  db: Db;
  artifacts: ArtifactStore;
  /** Where extracted video frames are cached. */
  cacheDir: string;
  /** ffmpeg for teach frames (default "ffmpeg"). */
  ffmpegPath?: string;
  /** Mount path, with a trailing slash (default "/recorder/"). */
  base?: string;
}

export function createRecorder(deps: RecorderDeps): Hono {
  const app = new Hono();
  const data = createRecorderData(deps.db);
  const base = deps.base ?? "/recorder/";
  const ffmpeg = deps.ffmpegPath ?? "ffmpeg";
  const durations = new Map<string, Promise<number>>();
  const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  const notFound = (what: string) =>
    new Response(
      `<!doctype html><title>Not found</title><p style="font:14px system-ui;padding:24px">${what} not found. <a href="${base.slice(0, -1)}">Back to the flight recorder</a></p>`,
      {
        status: 404,
        headers: htmlHeaders,
      },
    );

  const readJson = async <T>(id: string): Promise<T | null> => {
    try {
      return JSON.parse(new TextDecoder().decode(await deps.artifacts.read(id))) as T;
    } catch {
      return null;
    }
  };

  app.get("/", () => new Response(indexView(data, base), { headers: htmlHeaders }));

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    const r = ID.test(id) ? data.run(id) : undefined;
    if (!r) return notFound("Run");
    let trace: Trace | null = null;
    if (r.traceArtifactId) {
      try {
        trace = JSON.parse(new TextDecoder().decode(await deps.artifacts.read(r.traceArtifactId))) as Trace;
      } catch {
        trace = null;
      }
    }
    const readbacks: ReadBackDoc[] = [];
    for (const a of data.readbacks(r.id)) {
      try {
        readbacks.push(JSON.parse(new TextDecoder().decode(await deps.artifacts.read(a.id))) as ReadBackDoc);
      } catch {
        // a missing or unreadable read-back is shown as unknown
      }
    }
    const picks: { id: string; doc: PickDoc }[] = [];
    for (const a of data.picks(r.id)) {
      const doc = await readJson<PickDoc>(a.id);
      if (doc) picks.push({ id: a.id, doc });
    }
    return new Response(runView(data, base, r, trace, readbacks, picks), { headers: htmlHeaders });
  });

  app.get("/skills/:name/code", (c) => {
    const name = c.req.param("name");
    const v = Number(c.req.query("v") ?? "");
    const out = ID.test(name)
      ? codeRevealView(data, base, name, Number.isInteger(v) && v > 0 ? v : null)
      : null;
    return out ? new Response(out, { headers: htmlHeaders }) : notFound("Skill");
  });

  app.get("/picks/:id", async (c) => {
    const id = c.req.param("id");
    const doc =
      ID.test(id) && data.artifact(id)?.mime === "application/json" ? await readJson<PickDoc>(id) : null;
    if (!doc || !Array.isArray(doc.list) || !Array.isArray(doc.checks)) return notFound("Pick");
    return new Response(pickView(base, doc), { headers: htmlHeaders });
  });

  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    const v = Number(c.req.query("v") ?? "");
    const out = ID.test(name) ? skillView(data, base, name, Number.isInteger(v) && v > 0 ? v : null) : null;
    return out ? new Response(out, { headers: htmlHeaders }) : notFound("Skill");
  });

  app.get("/teach/:id", (c) => {
    const id = c.req.param("id");
    const d = ID.test(id) ? data.draft(id) : undefined;
    if (!d) return notFound("Teach draft");
    return new Response(teachView(data, base, d, 8), { headers: htmlHeaders });
  });

  app.get("/a/:id", (c) => {
    const id = c.req.param("id");
    const a = ID.test(id) ? data.artifact(id) : undefined;
    if (!a) return new Response("not found", { status: 404 });
    const path = deps.artifacts.absPath(deps.artifacts.get(a.id));
    if (!existsSync(path)) return new Response("artifact file missing", { status: 404 });
    const size = statSync(path).size;
    const headers: Record<string, string> = {
      "content-type": a.mime,
      "accept-ranges": "bytes",
      "cache-control": "private, max-age=31536000, immutable", // content-addressed
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) {
        return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      }
      return new Response(Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream, {
        status: 206,
        headers: {
          ...headers,
          "content-range": `bytes ${start}-${end}/${size}`,
          "content-length": String(end - start + 1),
        },
      });
    }
    return new Response(Readable.toWeb(createReadStream(path)) as ReadableStream, {
      headers: { ...headers, "content-length": String(size) },
    });
  });

  app.get("/frames/:id/:i", async (c) => {
    const id = c.req.param("id");
    const i = Number(c.req.param("i"));
    const n = Math.min(24, Math.max(1, Number(c.req.query("n") ?? "8")));
    const a = ID.test(id) ? data.artifact(id) : undefined;
    if (!a?.mime.startsWith("video/") || !Number.isInteger(i) || i < 0 || i >= n) {
      return new Response("not found", { status: 404 });
    }
    const src = deps.artifacts.absPath(deps.artifacts.get(a.id));
    mkdirSync(deps.cacheDir, { recursive: true });
    const out = join(deps.cacheDir, `${a.sha256.slice(0, 24)}-${n}-${i}.jpg`);
    try {
      if (!existsSync(out)) {
        let dur = durations.get(a.sha256);
        if (!dur) {
          dur = probeDuration(ffmpeg, src);
          durations.set(a.sha256, dur);
        }
        const t = ((i + 0.5) / n) * (await dur);
        await run(
          ffmpeg,
          [
            "-v",
            "error",
            "-ss",
            t.toFixed(2),
            "-i",
            src,
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "3",
            "-y",
            out,
          ],
          {
            timeout: 20_000,
            windowsHide: true,
          },
        );
      }
      return new Response(Readable.toWeb(createReadStream(out)) as ReadableStream, {
        headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=86400" },
      });
    } catch {
      return new Response("could not extract the frame (is ffmpeg on PATH?)", { status: 503 });
    }
  });

  return app;
}

/** Video length in seconds, from ffmpeg's banner (no ffprobe needed). */
async function probeDuration(ffmpeg: string, src: string): Promise<number> {
  const r = await run(ffmpeg, ["-hide_banner", "-i", src], { timeout: 10_000, windowsHide: true }).catch(
    (e: { stderr?: string }) => ({ stderr: e.stderr ?? "" }),
  );
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(String(r.stderr));
  if (!m) return 10;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

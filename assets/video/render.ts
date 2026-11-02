// Renders the demo video's motion graphics (storyboard shots 2, 8 and 9). Each clip in src/ is an HTML page whose
// look is a pure function of time (src/runtime.js). Playwright loads it at 1920x1080, a virtual clock steps
// t = n / 30, every frame is captured as a lossless PNG and piped to ffmpeg (H.264, yuv420p, BT.709). Nothing is
// captured in real time, so there are no dropped or doubled frames; after each clip two frames are drawn again
// out of order and compared with the first pass, so a page that depends on wall time fails the render.
//
//   pnpm exec tsx assets/video/render.ts                          every clip
//   pnpm exec tsx assets/video/render.ts title endcard            some clips
//   pnpm exec tsx assets/video/render.ts chart-cost --still 6.5   PNG stills only (repeat --still; --out <dir>)
//
// Before rendering it regenerates src/data.js from evals/results/live-headline.json and the raw rows in
// evals/results/live/, and stops if the two disagree: every number on screen comes from those files.

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type CDPSession, chromium, type Page } from "playwright";
import { cssVariables, fontFaceCss } from "../../packages/design/src/index.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const SRC = join(HERE, "src");
const RESULTS = join(ROOT, "evals", "results");
const LIVE = join(RESULTS, "live");
const CLIPS = [
  "title",
  "title-band",
  "chart-proof",
  "chart-baseline",
  "chart-cost",
  "chart-heals",
  "endcard",
  "endcard-wordmark",
];
/** Overlays for real footage: rendered with an alpha channel (QuickTime Animation, .mov) instead of H.264. */
const ALPHA = new Set(["title-band"]);
const W = 1920;
const H = 1080;

interface ClipApi {
  duration: number;
  fps: number;
  frames: number;
  ready: Promise<void>;
  frame(t: number): Promise<number>;
}
declare global {
  interface Window {
    __dh: ClipApi;
    __DH_RENDER__?: boolean;
  }
}

// ---------- data: the only numbers the clips may show ----------

interface Rung {
  attempts: number;
  healedSteps: number;
  costPerAttemptUsd: number;
  msPerAttempt: number;
}
interface Headline {
  label: string;
  healRates: {
    cases: number;
    seeds: number[];
    ok: number;
    falseHeals: number;
    safeStops: { correct: number; of: number };
    freeHeals: { fallback: number; similarity: number };
    rung2: Rung;
    rung3: Rung;
  };
  pureCuVsCompile: {
    pureCu: { runs: number; meanCostUsd: number };
    compileOnce: {
      firstRunCostUsd: number;
      annotateCostUsd: number;
      replays: { runs: number };
      driftEvents: { runs: number; costUsd: number };
    };
    totalRuns: number;
    cumulativeUsd: { compileOnce: number; pureCuProjected: number };
    breakEvenRun: number;
  };
}

interface ArmCounts {
  cases: number;
  correct: number;
  safeStop: number;
  stopped: number;
  wrongWrite: number;
  handled: number;
}
interface Baseline {
  measured: string;
  cases: { count: number; seeds: number[]; sameAsHeadline: boolean };
  arms: Record<"script" | "scriptPrimary" | "dockhand", { counts: ArmCounts }>;
}

function rows<T>(prefix: string): T[] {
  return readdirSync(LIVE)
    .filter((f) => f.startsWith(prefix) && f.endsWith(".jsonl"))
    .sort()
    .flatMap((f) =>
      readFileSync(join(LIVE, f), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as T),
    );
}

function expect(what: string, got: unknown, want: unknown): void {
  if (got !== want)
    throw new Error(`data check failed: ${what} is ${String(got)}, live-headline.json says ${String(want)}`);
}

/**
 * The cumulative cost series, derived exactly as scripts/live/headline.ts derives it for
 * evals/results/live-cu-vs-compile.png: run 1 is the first run plus annotation, then the 50 replays, then the
 * 42 drift cases; pure computer use is the 8 measured runs, then their mean per run.
 */
function buildData() {
  const hl = JSON.parse(readFileSync(join(RESULTS, "live-headline.json"), "utf8")) as Headline;
  const c = hl.pureCuVsCompile;
  const h = hl.healRates;
  const cuCosts = rows<{ costUsd: number }>("firstrun-caravela-video").map((r) => r.costUsd);
  const replays = rows<{ execCostUsd: number }>("replay-caravela-live");
  const drift = [
    ...rows<{ execCostUsd: number }>("mutation-caravela-live"),
    ...rows<{ execCostUsd: number }>("repair-caravela-live"),
  ];
  const perRun = [
    c.compileOnce.firstRunCostUsd + c.compileOnce.annotateCostUsd,
    ...replays.map((r) => r.execCostUsd),
    ...drift.map((r) => r.execCostUsd),
  ];
  const cuMean = cuCosts.reduce((a, b) => a + b, 0) / cuCosts.length;
  const compileCum: number[] = [];
  for (const [i, v] of perRun.entries()) compileCum.push((compileCum[i - 1] ?? 0) + v);
  const cuCum = perRun.map((_, i) =>
    i < cuCosts.length ? cuCosts.slice(0, i + 1).reduce((a, b) => a + b, 0) : cuMean * (i + 1),
  );
  const breakEven = cuCum.findIndex((v, i) => v >= (compileCum[i] ?? Number.POSITIVE_INFINITY)) + 1;
  const r3 = (v: number) => Number(v.toFixed(3));

  expect("measured computer-use runs", cuCosts.length, c.pureCu.runs);
  expect("computer-use mean cost", Number(cuMean.toFixed(4)), c.pureCu.meanCostUsd);
  expect("replays", replays.length, c.compileOnce.replays.runs);
  expect("drift cases", drift.length, c.compileOnce.driftEvents.runs);
  expect(
    "drift cost",
    Number(drift.reduce((s, r) => s + r.execCostUsd, 0).toFixed(4)),
    c.compileOnce.driftEvents.costUsd,
  );
  expect("total runs", perRun.length, c.totalRuns);
  expect("compile-once total", r3(compileCum.at(-1) ?? 0), c.cumulativeUsd.compileOnce);
  expect("computer-use projected total", r3(cuCum.at(-1) ?? 0), c.cumulativeUsd.pureCuProjected);
  expect("break-even run", breakEven, c.breakEvenRun);
  expect("drift cases (heal ladder)", h.cases, c.compileOnce.driftEvents.runs);

  const date = /(\d{4}-\d{2}-\d{2})\s*$/.exec(hl.label)?.[1];
  if (!date) throw new Error(`no date at the end of live-headline.json label: ${hl.label}`);

  // Section 4 of live-headline.md: the recorded-script baseline on the same 42 cases.
  const bl = JSON.parse(readFileSync(join(RESULTS, "baseline-recorded-script.json"), "utf8")) as Baseline;
  const arm = (a: ArmCounts) => ({
    cases: a.cases,
    handled: a.handled,
    correct: a.correct,
    broke: a.stopped,
    wrongWrites: a.wrongWrite,
  });
  expect("baseline cases", bl.cases.count, h.cases);
  expect("baseline uses the headline's cases", bl.cases.sameAsHeadline, true);
  expect("baseline seeds", bl.cases.seeds.join(","), h.seeds.join(","));
  expect("Dockhand handled (baseline file)", bl.arms.dockhand.counts.handled, h.ok);
  for (const k of ["script", "scriptPrimary", "dockhand"] as const) {
    const a = bl.arms[k].counts;
    expect(`${k}: cases`, a.cases, h.cases);
    expect(`${k}: handled = correct + required stops`, a.handled, a.correct + a.safeStop);
    expect(`${k}: every case accounted for`, a.correct + a.safeStop + a.stopped + a.wrongWrite, a.cases);
  }
  const free = h.freeHeals.fallback + h.freeHeals.similarity;
  const repairs = free + h.rung2.healedSteps + h.rung3.healedSteps;
  const rung = (r: Rung) => ({
    healed: r.healedSteps,
    tried: r.attempts,
    costPerAttemptUsd: r.costPerAttemptUsd,
    msPerAttempt: r.msPerAttempt,
  });
  const [yy, mm, dd] = date.split("-").map(Number);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][(mm ?? 1) - 1];
  return {
    date,
    dateShort: `${mon} ${dd}, ${yy}`,
    baseline: {
      measured: bl.measured,
      script: arm(bl.arms.script.counts),
      scriptPrimary: arm(bl.arms.scriptPrimary.counts),
      dockhand: arm(bl.arms.dockhand.counts),
    },
    cost: {
      totalRuns: c.totalRuns,
      measuredCuRuns: c.pureCu.runs,
      breakEvenRun: c.breakEvenRun,
      compileTotalUsd: c.cumulativeUsd.compileOnce,
      cuTotalUsd: c.cumulativeUsd.pureCuProjected,
      // Chart geometry only (never printed): cumulative USD after run 1..N.
      compileCum: compileCum.map((v) => Number(v.toFixed(6))),
      cuCum: cuCum.map((v) => Number(v.toFixed(6))),
    },
    heals: {
      cases: h.cases,
      ok: h.ok,
      wrongWrites: h.falseHeals,
      safeStops: h.safeStops,
      seeds: h.seeds,
      freeHealed: free,
      rung2: rung(h.rung2),
      rung3: rung(h.rung3),
      // Every healed step, and those healed without a closed model (free rungs + Muse Spark Open, open weights).
      repairs,
      noClosedModel: free + h.rung2.healedSteps,
    },
  };
}

function writeData(): ReturnType<typeof buildData> {
  const data = buildData();
  const body =
    "// Generated by assets/video/render.ts from evals/results/live-headline.json and the raw rows in\n" +
    "// evals/results/live/ (checked against each other). Do not edit: re-run the render.\n" +
    `window.DOCKHAND_DATA = ${JSON.stringify(data)};\n`;
  const file = join(SRC, "data.js");
  if (!existsSync(file) || readFileSync(file, "utf8") !== body) writeFileSync(file, body);
  // The film-scale tokens and the bundled fonts, from @dockhand/design (the one source).
  const tokens =
    "/* Generated by assets/video/render.ts from packages/design. Do not edit: re-run the render. */\n" +
    `${fontFaceCss({ baseUrl: "../../../packages/design/fonts" })}\n${cssVariables("film")}\n`;
  const tokenFile = join(SRC, "tokens.css");
  if (!existsSync(tokenFile) || readFileSync(tokenFile, "utf8") !== tokens) writeFileSync(tokenFile, tokens);
  return data;
}

// ---------- capture and encode ----------

// Chromium's PNGs are sRGB; convert with the BT.709 matrix to limited range and tag the frames themselves
// (setparams), since ffmpeg takes primaries and transfer from the frames over the -color_* flags.
const FFMPEG_OUT = [
  "-vf",
  "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p," +
    "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv",
  "-c:v",
  "libx264",
  "-preset",
  "slow",
  "-crf",
  "14",
  "-tune",
  "animation",
  "-profile:v",
  "high",
  "-level:v",
  "4.1",
  "-g",
  "30",
  "-colorspace",
  "bt709",
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-color_range",
  "tv",
  "-movflags",
  "+faststart",
  "-threads",
  "4",
  "-an",
];

// Overlays keep their alpha: QuickTime Animation (lossless RLE, small for flat graphics), which ffmpeg, Premiere,
// Resolve and Final Cut all read with transparency.
const FFMPEG_ALPHA = ["-c:v", "qtrle", "-pix_fmt", "argb", "-an"];

/** A transparent page background for alpha clips (the page's own .stage.clear must be transparent too). */
async function transparent(rig: Rig, on: boolean): Promise<void> {
  await rig.cdp.send(
    "Emulation.setDefaultBackgroundColorOverride",
    on ? { color: { r: 0, g: 0, b: 0, a: 0 } } : {},
  );
}

/** The clip page, a CDP session on it for fast lossless captures, and a blank page for comparing frames. */
interface Rig {
  page: Page;
  cdp: CDPSession;
  scratch: Page;
}

let pageError: Error | null = null;

async function load(rig: Rig, name: string): Promise<ClipApi> {
  await rig.page.goto(pathToFileURL(join(SRC, `${name}.html`)).href);
  await rig.page.evaluate(() => window.__dh.ready);
  if (pageError) throw pageError;
  return rig.page.evaluate(() => {
    const { duration, fps, frames } = window.__dh;
    return { duration, fps, frames } as ClipApi;
  });
}

/** Draws time t and captures the viewport as PNG (lossless; fast zlib settings, about 4x quicker than default). */
async function shot(rig: Rig, t: number): Promise<Buffer> {
  await rig.page.evaluate((s) => window.__dh.frame(s), t);
  if (pageError) throw pageError;
  const { data } = await rig.cdp.send("Page.captureScreenshot", { format: "png", optimizeForSpeed: true });
  return Buffer.from(data, "base64");
}

/** Largest per-channel difference and number of differing pixels between two PNGs (decoded in the browser). */
function pixelDiff(rig: Rig, a: Buffer, b: Buffer): Promise<{ max: number; changed: number }> {
  // No named functions inside: tsx (esbuild keepNames) would wrap them in a __name() helper the page lacks.
  return rig.scratch.evaluate(
    async (pngs) => {
      const [p, q] = await Promise.all(
        pngs.map(async (b64) => {
          const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
          const g = new OffscreenCanvas(bmp.width, bmp.height).getContext("2d");
          if (!g) throw new Error("no 2d canvas");
          g.drawImage(bmp, 0, 0);
          return g.getImageData(0, 0, bmp.width, bmp.height).data;
        }),
      );
      if (!p || !q) throw new Error("decode failed");
      let max = 0;
      let changed = 0;
      for (let i = 0; i < p.length; i += 4) {
        let d = 0;
        for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs((p[i + c] ?? 0) - (q[i + c] ?? 0)));
        if (d > 0) changed++;
        if (d > max) max = d;
      }
      return { max, changed };
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

async function encode(rig: Rig, name: string): Promise<void> {
  const clip = await load(rig, name);
  const alpha = ALPHA.has(name);
  const out = join(HERE, `${name}.${alpha ? "mov" : "mp4"}`);
  const started = Date.now();
  await transparent(rig, alpha);
  const ff = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(clip.fps),
      "-c:v",
      "png",
    ].concat(["-i", "pipe:0", ...(alpha ? FFMPEG_ALPHA : FFMPEG_OUT), "-r", String(clip.fps), out]),
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  ff.stderr.on("data", (d) => {
    stderr += String(d);
  });
  ff.stdin.on("error", () => {}); // a dead ffmpeg is reported by its exit code below
  const closed = once(ff, "close");
  // Two frames are drawn again after the pass, out of order. Anything driven by wall time would shift whole edges
  // (deltas of 100+/255 over thousands of pixels). Chromium's glyph and raster caches can leave a few dozen
  // anti-aliased edge pixels a few levels off (measured: at most 11/255 on 98 px), which is invisible.
  const probes = new Map<number, Buffer | null>(
    [Math.floor(clip.frames * 0.3), Math.floor(clip.frames * 0.85)].map((n) => [n, null]),
  );
  for (let n = 0; n < clip.frames; n++) {
    const png = await shot(rig, n / clip.fps);
    if (probes.has(n)) probes.set(n, png);
    if (!ff.stdin.write(png)) await Promise.race([once(ff.stdin, "drain"), closed]);
    if (ff.exitCode !== null) break;
  }
  ff.stdin.end();
  const [code] = (await closed) as [number | null];
  if (code !== 0) throw new Error(`ffmpeg failed on ${name} (exit ${code}): ${stderr.trim()}`);
  const redraw: string[] = [];
  for (const [n, png] of [...probes].reverse()) {
    if (!png) continue;
    const again = await shot(rig, n / clip.fps);
    const d = again.equals(png) ? { max: 0, changed: 0 } : await pixelDiff(rig, png, again);
    if (d.max > 32 || d.changed > W * H * 0.001) {
      throw new Error(
        `${name}: frame ${n} drawn twice differs (${d.changed} px, up to ${d.max}/255): time-dependent page`,
      );
    }
    redraw.push(d.changed ? `frame ${n}: ${d.changed} px within ${d.max}/255` : `frame ${n}: identical`);
  }
  const probe = verify(out, clip, alpha);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${name}.${alpha ? "mov" : "mp4"}  ${probe.frames} frames, ${probe.seconds.toFixed(2)} s, ${W}x${H} ${probe.fps} fps ${probe.pixFmt}, ` +
      `${(statSync(out).size / 1e6).toFixed(2)} MB, rendered in ${secs} s; redraw check: ${redraw.join(", ")}`,
  );
}

function verify(file: string, clip: ClipApi, alpha = false) {
  const r = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_frames"]
      .concat(["-show_entries", "stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames"])
      .concat(["-show_entries", "format=duration", "-of", "json", file]),
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`ffprobe failed on ${file}: ${r.stderr}`);
  const j = JSON.parse(r.stdout) as {
    streams: {
      codec_name: string;
      width: number;
      height: number;
      pix_fmt: string;
      r_frame_rate: string;
      nb_read_frames: string;
    }[];
    format: { duration: string };
  };
  const s = j.streams[0];
  if (!s) throw new Error(`${file}: no video stream`);
  const frames = Number(s.nb_read_frames);
  const ok =
    s.codec_name === (alpha ? "qtrle" : "h264") &&
    s.width === W &&
    s.height === H &&
    s.pix_fmt === (alpha ? "argb" : "yuv420p") &&
    s.r_frame_rate === `${clip.fps}/1` &&
    frames === clip.frames;
  if (!ok) throw new Error(`${file}: unexpected output ${JSON.stringify(s)} (want ${clip.frames} frames)`);
  return { frames, seconds: Number(j.format.duration), fps: clip.fps, pixFmt: s.pix_fmt };
}

async function stills(rig: Rig, name: string, times: number[], dir: string): Promise<void> {
  const clip = await load(rig, name);
  await transparent(rig, ALPHA.has(name));
  mkdirSync(dir, { recursive: true });
  for (const t of times) {
    const at = Math.min(Math.max(0, t), clip.duration - 1 / clip.fps);
    const file = join(dir, `${name}-${at.toFixed(2)}s.png`);
    writeFileSync(file, await shot(rig, at));
    console.log(file);
  }
}

// ---------- main ----------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const times: number[] = [];
  let outDir = join(os.tmpdir(), "dockhand-video-stills");
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--still") times.push(Number(args[++i]));
    else if (a === "--out") outDir = args[++i] ?? outDir;
    else names.push(a.replace(/\.(html|mp4)$/, ""));
  }
  const pick = names.length ? names : CLIPS;
  for (const n of pick)
    if (!CLIPS.includes(n)) throw new Error(`unknown clip "${n}" (clips: ${CLIPS.join(", ")})`);
  if (times.some((t) => !Number.isFinite(t))) throw new Error("--still takes a time in seconds");

  // Below-normal priority (inherited by Chromium and ffmpeg on Windows) so a render never starves other work.
  try {
    os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {}

  const data = writeData();
  const h = data.heals;
  console.log(
    `data: $${data.cost.compileTotalUsd.toFixed(2)} vs $${data.cost.cuTotalUsd.toFixed(2)} over ${data.cost.totalRuns} runs, ` +
      `break-even run ${data.cost.breakEvenRun}; heals free ${h.freeHealed}, rung 2 ${h.rung2.healed}/${h.rung2.tried}, ` +
      `rung 3 ${h.rung3.healed}/${h.rung3.tried}; ${h.ok}/${h.cases} handled, ${h.wrongWrites} wrong writes`,
  );

  const browser = await chromium.launch({
    headless: true,
    // sRGB output, grayscale text AA (no colour fringes for 4:2:0 to smear), and full-tile raster so a redrawn
    // frame does not depend on which rectangles earlier frames invalidated.
    args: [
      "--force-color-profile=srgb",
      "--disable-lcd-text",
      "--hide-scrollbars",
      "--disable-partial-raster",
    ],
  });
  try {
    const context = await browser.newContext({
      viewport: { width: W, height: H },
      deviceScaleFactor: 1,
      colorScheme: "dark",
    });
    await context.addInitScript(() => {
      window.__DH_RENDER__ = true;
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => {
      pageError ??= e;
    });
    const rig: Rig = { page, cdp: await context.newCDPSession(page), scratch: await context.newPage() };
    for (const name of pick) {
      if (times.length) await stills(rig, name, times, outDir);
      else await encode(rig, name);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

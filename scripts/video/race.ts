// `pnpm exec tsx scripts/video/race.ts --session <name>`: the other side of the hero take's race. The same compiled
// skill, run as an ordinary recorded script (its Playwright export cut to one selector per step, as baseline.ts
// measures it), on the same portal change the hero take uses (Caravela v2), filmed from inside Chromium at 1280x800
// like every other clip. The script runs in a child process; its real stdout and stderr (the TimeoutError included)
// are kept line by line with wall-clock times, so the cut can draw them as a terminal pane next to the clip.
// No model calls: no model client exists here, and the browser has no HUD.
//
//   --session <name>      var/recordings/<name>: its database supplies the skill and the hero's values
//   --variant codegen     (default) each action waits on its one locator, as a codegen recording does; a missing
//                         element is Playwright's own TimeoutError after --timeout-ms
//   --variant export      the export verbatim (pick() over the one selector: a missing element fails at once with
//                         "no candidate matched exactly one element"), exactly the baseline's scriptPrimary arm
//   --timeout-ms 5000     Playwright's action and navigation timeout (Playwright's default is 30000; the JSON says so)
//   --hold-ms 2500        the page stays open this long after the script ends, so the clip shows where it stopped
//   --skill-version 1     the Caravela skill version (default: 1, the version the hero take replays)
//
// Output: var/recordings/<session>/race/ with race.mkv (the clip), race.json (lines, times, settings), script.ts
// (the exact code that ran) and clips/ (the raw capture).

import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Page } from "playwright";
import { startPartnerPortal } from "../../apps/portals/src/index.ts";
import { createBrowserPool, encodeClip, readClipInfo } from "../../packages/browser/src/index.ts";
import { type ParamValue, Skill, workspaceRoot } from "../../packages/core/src/index.ts";
import { primarySelectorsOnly } from "../../packages/evals/src/index.ts";
import { exportPlaywright, rebaseSkill } from "../../packages/skills/src/index.ts";

type Variant = "codegen" | "export";

interface ChildConfig {
  out: string;
  skill: Skill;
  params: Record<string, ParamValue>;
  variant: Variant;
  timeoutMs: number;
  holdMs: number;
}

interface ChildMeta {
  portalUrl: string;
  ui: "v2";
  scriptFile: string;
  fnName: string;
  runStartedAt: number;
  runEndedAt: number;
  outcome: "success" | "error";
  errorName?: string;
}

const root = workspaceRoot();
const rel = (p: string) => relative(root, p).replace(/\\/g, "/");

/**
 * One locator per action, as a codegen recording has it: `await (await pick(X,)).click()` -> `await X.click()`.
 * The export puts each candidate of a pick() on its own line, so with one candidate this is a plain rewrite.
 */
export function unwrapSinglePicks(code: string): string {
  return code.replace(/await \(\n\s*await pick\(\n\s*([^\n]+),\n\s*\)\n\s*\)\./g, "await $1.");
}

// ---------- child: runs the script, prints only what the script prints ----------

async function child(configPath: string): Promise<void> {
  const cfg = JSON.parse(readFileSync(configPath, "utf8")) as ChildConfig;
  const portal = await startPartnerPortal({ port: 0 });
  const pool = createBrowserPool({
    headless: true,
    maxContexts: 1,
    storageStateDir: join(cfg.out, "state"),
    hud: null,
    capture: { dir: join(cfg.out, "clips") },
  });
  const skill = Skill.parse(cfg.skill);
  const exported = exportPlaywright(rebaseSkill(primarySelectorsOnly(skill), portal.url));
  const code = cfg.variant === "codegen" ? unwrapSinglePicks(exported) : exported;
  const scriptFile = join(cfg.out, "script.ts");
  writeFileSync(scriptFile, code);
  const fnName = skill.name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
  const mod = (await import(pathToFileURL(scriptFile).href)) as Record<string, unknown>;
  const fn = mod[fnName] as (page: Page, p: Record<string, ParamValue>) => Promise<Record<string, string>>;
  const runId = "race";
  const lease = await pool.lease({
    portalId: "caravela",
    runId,
    cookies: await portal.session({ runId, ui: "v2", mutation: null }),
    ttlMs: 300_000,
  });
  const page = lease.page;
  page.setDefaultTimeout(cfg.timeoutMs);
  page.setDefaultNavigationTimeout(cfg.timeoutMs);
  // As a caller would run it: every declared param passed, a blank string for an optional value left out.
  const p: Record<string, ParamValue> = { ...cfg.params };
  for (const spec of skill.params) if (p[spec.name] === undefined) p[spec.name] = "";
  const runStartedAt = Date.now();
  let outcome: ChildMeta["outcome"] = "success";
  let errorName: string | undefined;
  try {
    const result = await fn(page, p);
    console.log(result);
  } catch (err) {
    outcome = "error";
    errorName = err instanceof Error ? err.name : typeof err;
    console.error(err);
    process.exitCode = 1;
  }
  const runEndedAt = Date.now();
  await new Promise((r) => setTimeout(r, cfg.holdMs));
  await lease.release();
  await pool.closeAll();
  await portal.close();
  const meta: ChildMeta = {
    portalUrl: portal.url,
    ui: "v2",
    scriptFile,
    fnName,
    runStartedAt,
    runEndedAt,
    outcome,
    ...(errorName ? { errorName } : {}),
  };
  writeFileSync(join(cfg.out, "child-meta.json"), JSON.stringify(meta));
}

// ---------- parent: picks the skill and values, captures the child's output ----------

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function loadFromSession(
  dbPath: string,
  version: number,
): { skill: Skill; params: Record<string, ParamValue> } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db
      .prepare(
        "SELECT json FROM skills WHERE json_extract(json, '$.portalId') = 'caravela' AND version = ? ORDER BY created_at LIMIT 1",
      )
      .get(version) as { json: string } | undefined;
    if (!row) throw new Error(`no Caravela skill v${version} in ${rel(dbPath)} (run the teach take first)`);
    const skill = Skill.parse(JSON.parse(row.json));
    // The hero's values: the newest run of this skill that carried params (the hero is the last v1 replay).
    const run = db
      .prepare(
        "SELECT params_json FROM runs WHERE skill_name = ? AND params_json IS NOT NULL AND mode != 'agentic' ORDER BY started_at DESC LIMIT 1",
      )
      .get(skill.name) as { params_json: string } | undefined;
    if (!run)
      throw new Error(`no replay of ${skill.name} with values in ${rel(dbPath)} (run the hero take first)`);
    return { skill, params: JSON.parse(run.params_json) as Record<string, ParamValue> };
  } finally {
    db.close();
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal color codes
const plain = (s: string) => s.replace(/[[0-9;]*m/g, "");

interface Line {
  /** Epoch ms when the line reached the parent. */
  at: number;
  /** Ms since the script started running (child's runStartedAt), once known. */
  t: number | null;
  stream: "stdout" | "stderr";
  /** The line without terminal color codes. */
  text: string;
  /** As printed, color codes included (Playwright dims its call log). */
  raw: string;
}

async function parent(): Promise<void> {
  const session = arg("--session");
  if (!session) throw new Error("--session <name> is required");
  const variant = (arg("--variant") ?? "codegen") as Variant;
  if (variant !== "codegen" && variant !== "export") throw new Error("--variant codegen|export");
  const timeoutMs = Number(arg("--timeout-ms") ?? 5000);
  const holdMs = Number(arg("--hold-ms") ?? 2500);
  const version = Number(arg("--skill-version") ?? 1);
  const sessionDir = join(root, "var", "recordings", session);
  const out = join(sessionDir, "race");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const { skill, params } = await loadFromSession(join(sessionDir, "var", "dockhand.sqlite"), version);

  const cfg: ChildConfig = { out, skill, params, variant, timeoutMs, holdMs };
  const cfgPath = join(out, "child-config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  const self = fileURLToPath(import.meta.url);
  const argv = [...process.execArgv, self, "--child", cfgPath];
  const lines: Line[] = [];
  const startedAt = Date.now();
  const code = await new Promise<number | null>((resolve, reject) => {
    const proc = spawn(process.execPath, argv, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    for (const stream of ["stdout", "stderr"] as const) {
      let buf = "";
      proc[stream].setEncoding("utf8");
      proc[stream].on("data", (d: string) => {
        const at = Date.now();
        buf += d;
        const parts = buf.split(/\r?\n/);
        buf = parts.pop() ?? "";
        for (const text of parts) {
          lines.push({ at, t: null, stream, text: plain(text), raw: text });
          process[stream].write(`${text}\n`);
        }
      });
      proc[stream].on("end", () => {
        if (buf) lines.push({ at: Date.now(), t: null, stream, text: plain(buf), raw: buf });
      });
    }
    proc.on("error", reject);
    proc.on("exit", resolve);
  });
  const metaPath = join(out, "child-meta.json");
  if (!existsSync(metaPath))
    throw new Error(`the script's process exited ${code} before it finished (see above)`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as ChildMeta;
  for (const l of lines) l.t = l.at - meta.runStartedAt;

  // The clip: the one capture folder under clips/, encoded and copied next to the JSON.
  const clipsDir = join(out, "clips");
  const folder = readdirSync(clipsDir).map((n) => join(clipsDir, n))[0] ?? null;
  const info = folder ? readClipInfo(folder) : null;
  const encoded = folder ? await encodeClip(folder) : null;
  if (encoded) copyFileSync(encoded, join(out, "race.mkv"));

  const firstError = lines.find((l) => l.stream === "stderr" && /\w*Error\b/.test(l.text));
  const doc = {
    what: "A recorded script on the hero take's portal change: the compiled skill's Playwright export, one selector per step, no healing, no read-back, no approval gate. No model calls.",
    session,
    skill: { name: skill.name, version: skill.version, title: skill.title, steps: skill.steps.length },
    portal: { id: "caravela", ui: meta.ui, change: "v2 UI (the hero take's change)", url: meta.portalUrl },
    variant,
    variantNote:
      variant === "codegen"
        ? "Each action waits on its one locator, as a codegen recording does (the export's single-candidate pick() unwrapped); a missing element ends in Playwright's TimeoutError."
        : "The export verbatim: pick() over one selector fails at once when nothing matches.",
    timeoutMs,
    timeoutNote: `Playwright's action and navigation timeout set to ${timeoutMs} ms for the video (Playwright's default is 30000 ms).`,
    holdMs,
    holdNote:
      "The page stays open this long after the script ends so the clip shows where it stopped; not part of the run.",
    params,
    command: [process.execPath, ...argv].join(" "),
    scriptFile: rel(join(out, "script.ts")),
    exitCode: code,
    outcome: meta.outcome,
    ...(meta.errorName ? { errorName: meta.errorName } : {}),
    run: {
      startedAt: meta.runStartedAt,
      endedAt: meta.runEndedAt,
      ms: meta.runEndedAt - meta.runStartedAt,
      firstErrorAtMs: firstError ? firstError.t : null,
    },
    clip: {
      file: encoded ? rel(join(out, "race.mkv")) : null,
      startedAt: info?.startedAt ?? null,
      endedAt: info?.endedAt ?? null,
      width: info?.width ?? null,
      height: info?.height ?? null,
      fps: info?.fps ?? null,
      note: "Times are epoch ms; a line's position in the clip is line.at - clip.startedAt.",
    },
    processStartedAt: startedAt,
    lines,
  };
  writeFileSync(join(out, "race.json"), `${JSON.stringify(doc, null, 2)}\n`);
  rmSync(cfgPath, { force: true });
  rmSync(metaPath, { force: true });
  rmSync(join(out, "state"), { recursive: true, force: true });
  console.log(
    `\nrace: ${meta.outcome}${meta.errorName ? ` (${meta.errorName})` : ""} after ${((meta.runEndedAt - meta.runStartedAt) / 1000).toFixed(1)} s; wrote ${rel(join(out, "race.json"))}${encoded ? ` and ${rel(join(out, "race.mkv"))}` : " (no clip)"}`,
  );
}

const childAt = process.argv.indexOf("--child");
if (childAt >= 0) await child(process.argv[childAt + 1] as string);
else await parent();

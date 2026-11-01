// A recorded session as the cut tools see it: the cut list, the filmed browser pages and close-ups, the phone
// track (Rabin's real recording placed by phone sync, or a rehearsal's filmed emulator chat) and the database.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type ClipInfo, encodeClip, readClipInfo } from "../../../packages/browser/src/index.ts";
import { workspaceRoot } from "../../../packages/core/src/index.ts";
import type { Attempt, CutList } from "../session.ts";

export interface Clip {
  folder: string;
  file: string;
  /** Wall-clock ms of the clip's first and last frame. */
  start: number;
  end: number;
  info: ClipInfo;
}

export interface PhoneTrack {
  file: string;
  /** Wall-clock ms of the recording's first frame. */
  start: number;
  /** The rehearsal's emulator chat: must be labeled simulated wherever it appears. */
  simulated: boolean;
}

export interface Session {
  name: string;
  dir: string;
  cut: CutList;
  dbPath: string;
  clips: Clip[];
  camera: Clip[];
  phone: PhoneTrack | null;
}

async function clipsIn(dir: string): Promise<Clip[]> {
  if (!existsSync(dir)) return [];
  const out: Clip[] = [];
  for (const name of readdirSync(dir)) {
    const folder = join(dir, name);
    const info = readClipInfo(folder);
    if (!info?.startedAt || !info.endedAt) continue;
    const file = join(folder, "clip.mkv");
    if (!existsSync(file)) await encodeClip(folder).catch(() => null);
    if (existsSync(file)) out.push({ folder, file, start: info.startedAt, end: info.endedAt, info });
  }
  return out.sort((a, b) => a.start - b.start);
}

export async function loadSession(name: string): Promise<Session> {
  const root = workspaceRoot();
  const dir = join(root, "var", "recordings", name);
  const cut = JSON.parse(readFileSync(join(dir, "cutlist.json"), "utf8")) as CutList;
  let phone: PhoneTrack | null = null;
  const sync = join(dir, "phone-sync.json");
  if (existsSync(sync)) {
    const s = JSON.parse(readFileSync(sync, "utf8")) as { file: string; startAt: number };
    phone = { file: join(root, s.file), start: s.startAt, simulated: false };
  } else if (cut.phoneSim?.startedAt) {
    const folder = join(root, cut.phoneSim.folder);
    if (!existsSync(join(folder, "clip.mkv"))) await encodeClip(folder);
    phone = { file: join(folder, "clip.mkv"), start: cut.phoneSim.startedAt, simulated: true };
  }
  return {
    name,
    dir,
    cut,
    dbPath: join(dir, "var", "dockhand.sqlite"),
    clips: await clipsIn(join(dir, "clips")),
    camera: await clipsIn(join(dir, "camera")),
    phone,
  };
}

/** The last attempt of a take that finished, across sessions in order (the first session that has it wins). */
export function takeIn(sessions: Session[], id: string): { s: Session; a: Attempt } | null {
  for (const s of sessions) {
    const done = s.cut.takes.filter((t) => t.id === id && t.status === "done");
    const a = done.at(-1);
    if (a) return { s, a };
  }
  return null;
}

/** The take's own run (not a canary, compile check or watch dry run). */
export function mainRun(a: Attempt): Attempt["events"]["runs"][number] | undefined {
  return a.events.runs.find((r) => r.suite === null && !r.id.includes("-"));
}

export function clipOfRun(s: Session, runId: string): Clip | undefined {
  return s.clips.find((c) => c.info.meta.runId === runId);
}

export function cameraShot(s: Session, label: string): Clip | undefined {
  return s.camera.filter((c) => c.info.label.endsWith(label)).at(-1);
}

/** The open-weights heal of a run: when the model call started and ended (wall ms), and the element it fixed. */
export function healOf(
  s: Session,
  runId: string,
): { start: number; end: number; bbox: { x: number; y: number; w: number; h: number } | null } | null {
  if (!existsSync(s.dbPath)) return null;
  const db = new DatabaseSync(s.dbPath, { readOnly: true });
  try {
    const call = db
      .prepare(
        "SELECT ts, latency_ms FROM model_calls WHERE run_id = ? AND purpose = 'heal_match' ORDER BY ts LIMIT 1",
      )
      .get(runId) as { ts: number; latency_ms: number } | undefined;
    if (!call) return null;
    const step = db
      .prepare(
        "SELECT target_json FROM run_steps WHERE run_id = ? AND rung = 'open_weights' ORDER BY idx LIMIT 1",
      )
      .get(runId) as { target_json: string | null } | undefined;
    let bbox: { x: number; y: number; w: number; h: number } | null = null;
    try {
      const t = JSON.parse(step?.target_json ?? "null") as { fingerprint?: { bbox?: typeof bbox } } | null;
      bbox = t?.fingerprint?.bbox ?? null;
    } catch {
      bbox = null;
    }
    return { start: call.ts - call.latency_ms, end: call.ts, bbox };
  } finally {
    db.close();
  }
}

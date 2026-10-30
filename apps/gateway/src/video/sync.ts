// Phone sync for the video edit: finds when Rabin's phone screen recording started, on the gateway's clock.
//
// Every message is an event at a known gateway time: the rep's own messages and button taps change the phone
// screen a little BEFORE the gateway stores them (the bubble shows at once, the upload and the webhook follow),
// Dockhand's messages change it a little AFTER it sends them (delivery). The recording's visual changes (from
// ffmpeg, scene differences) are slid along the gateway's timeline; the start time that puts a change inside
// most events' lag windows, closest to their typical lag, wins. Metadata (creation time, file time) only
// narrows the search. The margin to the best start time more than 2 s away says how sure the match is.

export interface SyncEvent {
  /** Gateway time, epoch ms. */
  at: number;
  /** "in": the rep's message or tap; "out": Dockhand's message. */
  dir: "in" | "out";
  label?: string;
}

/** A visual change in the phone recording: seconds from its start, and how big. */
export interface Change {
  t: number;
  mag: number;
}

/** Phone change time minus gateway event time, in seconds: the window and the typical value per direction. */
export interface LagProfile {
  out: [number, number];
  in: [number, number];
  typicalOut: number;
  typicalIn: number;
}

/** A real phone on WhatsApp: uploads and deliveries take a second or more. */
export const PHONE_LAGS: LagProfile = { out: [0.1, 6], in: [-10, -0.05], typicalOut: 1, typicalIn: -1.5 };
/**
 * The /dev/chat emulator page (rehearsals): everything is local and near-instant, and the page draws the rep's
 * own bubble from the server's event, so it can show a moment after the gateway stored the message.
 */
export const EMULATOR_LAGS: LagProfile = {
  out: [-0.05, 1.5],
  in: [-1, 1],
  typicalOut: 0.15,
  typicalIn: 0.1,
};

export interface SyncResult {
  /** Wall-clock time (epoch ms) of the recording's first frame. */
  startAt: number;
  matched: number;
  total: number;
  /** How far ahead of the best alignment more than 2 s away (0..1, relative score): the match's uniqueness. */
  margin: number;
  confidence: "high" | "medium" | "low";
  /** Median distance of matched lags from their typical value, ms. */
  residualMs: number;
  /** Per event: the lag found (s) or null. */
  lags: { label?: string; dir: "in" | "out"; at: number; lag: number | null }[];
}

export interface AlignOptions {
  /** Recording length, seconds. */
  duration: number;
  /** Candidate start times (epoch ms) from metadata; with none, every start that overlaps the events is tried. */
  priors?: number[];
  /** Search this many seconds around each prior (default 180). */
  searchS?: number;
  lags?: LagProfile;
}

function lowerBound(changes: Change[], t: number): number {
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((changes[mid] as Change).t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Scored {
  start: number; // seconds, epoch
  score: number;
  matched: number;
}

function scoreAt(start: number, changes: Change[], events: SyncEvent[], lags: LagProfile): Scored {
  let score = 0;
  let matched = 0;
  for (const e of events) {
    const [a, b] = e.dir === "out" ? lags.out : lags.in;
    const typical = e.dir === "out" ? lags.typicalOut : lags.typicalIn;
    const sigma = Math.max(0.15, (b - a) / 4);
    const et = e.at / 1000 - start; // event time on the video's timeline
    let best = 0;
    for (let i = lowerBound(changes, et + a); i < changes.length; i++) {
      const c = changes[i] as Change;
      const lag = c.t - et;
      if (lag > b) break;
      const w = Math.exp(-(((lag - typical) / sigma) ** 2));
      if (w > best) best = w;
    }
    if (best > 0) {
      matched++;
      score += 0.5 + 0.5 * best; // a match counts most; closeness to the typical lag breaks ties
    }
  }
  return { start, score, matched };
}

/** Aligns a phone recording's visual changes with the gateway's message events. */
export function alignPhone(changesIn: Change[], events: SyncEvent[], o: AlignOptions): SyncResult {
  const lags = o.lags ?? PHONE_LAGS;
  const changes = [...changesIn].sort((x, y) => x.t - y.t);
  const evs = [...events].sort((x, y) => x.at - y.at);
  if (evs.length === 0) throw new Error("no gateway events to align with");
  const first = (evs[0] as SyncEvent).at / 1000;
  const last = (evs.at(-1) as SyncEvent).at / 1000;
  const ranges: [number, number][] = o.priors?.length
    ? o.priors.map((p) => [p / 1000 - (o.searchS ?? 180), p / 1000 + (o.searchS ?? 180)])
    : [[first - o.duration - 10, last + 10]];
  const coarse: Scored[] = [];
  for (const [lo, hi] of ranges)
    for (let s = lo; s <= hi; s += 0.05) coarse.push(scoreAt(s, changes, evs, lags));
  coarse.sort((x, y) => y.score - x.score);
  const top = coarse[0] as Scored;
  // refine around the winner
  let best = top;
  for (let s = top.start - 0.1; s <= top.start + 0.1; s += 0.005) {
    const r = scoreAt(s, changes, evs, lags);
    if (r.score > best.score) best = r;
  }
  const rival = coarse.find((c) => Math.abs(c.start - best.start) > 2);
  // How far the winner's score is ahead of the best alignment more than 2 s away, relative to the winner.
  const margin = rival && best.score > 0 ? (best.score - rival.score) / best.score : 1;
  const share = best.matched / evs.length;
  const confidence =
    share >= 0.7 && margin >= 0.1 ? "high" : share >= 0.5 && margin >= 0.04 ? "medium" : "low";
  const found = evs.map((e) => {
    const [a, b] = e.dir === "out" ? lags.out : lags.in;
    const typical = e.dir === "out" ? lags.typicalOut : lags.typicalIn;
    const et = e.at / 1000 - best.start;
    let lag: number | null = null;
    for (let i = lowerBound(changes, et + a); i < changes.length; i++) {
      const l = (changes[i] as Change).t - et;
      if (l > b) break;
      if (lag === null || Math.abs(l - typical) < Math.abs(lag - typical)) lag = l;
    }
    return { ...(e.label ? { label: e.label } : {}), dir: e.dir, at: e.at, lag };
  });
  const residuals = found
    .filter((f) => f.lag !== null)
    .map((f) => Math.abs((f.lag as number) - (f.dir === "out" ? lags.typicalOut : lags.typicalIn)))
    .sort((x, y) => x - y);
  const residualMs = residuals.length ? Math.round((residuals[residuals.length >> 1] as number) * 1000) : 0;
  return {
    startAt: Math.round(best.start * 1000),
    matched: best.matched,
    total: evs.length,
    margin: Math.round(margin * 1000) / 1000,
    confidence,
    residualMs,
    lags: found,
  };
}

/**
 * Change times from ffmpeg's per-frame difference signal (metadata print of signalstats YAVG on a tblend
 * difference): peaks above an adaptive threshold, merged when closer than `mergeS`.
 */
export function changesFromSignal(samples: { t: number; v: number }[], mergeS = 0.25): Change[] {
  if (samples.length === 0) return [];
  const vs = samples.map((s) => s.v).sort((a, b) => a - b);
  const median = vs[vs.length >> 1] as number;
  const mad = (samples.map((s) => Math.abs(s.v - median)).sort((a, b) => a - b)[samples.length >> 1] ??
    0) as number;
  const threshold = Math.max(0.6, median + 6 * Math.max(mad, 0.05));
  const peaks: Change[] = [];
  for (const s of samples) {
    if (s.v < threshold) continue;
    const prev = peaks.at(-1);
    if (prev && s.t - prev.t < mergeS) {
      if (s.v > prev.mag) peaks[peaks.length - 1] = { t: prev.t, mag: s.v };
    } else peaks.push({ t: s.t, mag: s.v });
  }
  return peaks;
}

/** Parses `metadata=print:key=lavfi.signalstats.YAVG:file=-` output into time/value samples. */
export function parseSignalstats(text: string): { t: number; v: number }[] {
  const out: { t: number; v: number }[] = [];
  let t: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const pts = /pts_time:([\d.]+)/.exec(line);
    if (pts) {
      t = Number(pts[1]);
      continue;
    }
    const v = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(line);
    if (v && t !== null) out.push({ t, v: Number(v[1]) });
  }
  return out;
}

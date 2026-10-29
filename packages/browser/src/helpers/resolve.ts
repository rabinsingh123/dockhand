// Target resolution for replay: strong candidates as one or() union under one deadline, then a fingerprint
// check. Candidates that disagree escalate; they are never settled by rank. Optional similarity fallback.

import type { Candidate, ElementDescriptor, Target } from "@dockhand/core";
import type { ElementHandle, Locator, Page } from "playwright";
import { ensureDh } from "../dom/script.ts";
import { describeExact, describeHandle, isFileFingerprint, ownerHandle } from "./describe.ts";
import { listDescriptors } from "./forms.ts";
import { candidateFamily, isStrongCandidate, toLocator } from "./locators.ts";
import { isSettled, SETTLED_MISS_MS } from "./settle.ts";
import {
  FINGERPRINT_FLOOR,
  type FingerprintField,
  interactionClass,
  SIMILARITY_ACCEPT,
  SIMILARITY_MARGIN,
  similarity,
  similarityExcluding,
} from "./similarity.ts";

export type ResolveResult =
  | {
      ok: true;
      locator: Locator;
      candidateIdx: number | null;
      via: "candidate" | "similarity";
      descriptor: ElementDescriptor;
    }
  | { ok: false; code: "STEP_NOT_FOUND" | "STEP_AMBIGUOUS"; detail: string };

export interface ResolveOptions {
  timeoutMs: number;
  allowSimilarity: boolean;
}

/** Fingerprint attributes a matching candidate already vouches for (excluded from the independent check). */
function vouchedFields(c: Candidate): FingerprintField[] {
  switch (c.by) {
    case "testid":
      return ["testId"];
    case "role":
      return ["role", "name"];
    case "label":
      return ["label"];
    case "placeholder":
      return ["placeholder"];
    case "text":
      return ["text"];
    case "css":
      return c.value.startsWith("#") ? ["domId"] : /\[name=/.test(c.value) ? ["nameAttr"] : [];
  }
}

/**
 * Role must match. Agreement of an attribute candidate (testid, id, name) with a text candidate (role name,
 * label, placeholder) is independent evidence and suffices; a single family must be corroborated by the
 * attributes it did not use (a testid moved onto another field fails here).
 */
function fingerprintCheck(
  stored: ElementDescriptor,
  live: ElementDescriptor,
  matched: Candidate[],
): { ok: true } | { ok: false; why: string } {
  if (stored.role && live.role !== stored.role) {
    return { ok: false, why: `role ${live.role ?? "(none)"} does not match stored role ${stored.role}` };
  }
  const families = new Set(matched.map(candidateFamily));
  if (families.size > 1) return { ok: true };
  const exclude = new Set(matched.flatMap(vouchedFields));
  exclude.delete("role");
  const score = similarityExcluding(stored, live, exclude);
  return score >= FINGERPRINT_FLOOR
    ? { ok: true }
    : { ok: false, why: `fingerprint score ${score.toFixed(2)} below ${FINGERPRINT_FLOOR}` };
}

/** The page settled and the target still was not there: given up before the deadline. */
class SettledMiss extends Error {
  constructor(readonly waitedMs: number) {
    super(`target missing on a settled page after ${waitedMs} ms`);
  }
}

const WAIT_SLICE_MS = 250;

/**
 * Waits for the union like `waitFor`, but on a settled page (no request in flight, no DOM change, no spinner)
 * a target that has been missing for SETTLED_MISS_MS is not coming: it throws SettledMiss so the step reaches
 * the heal ladder in about a second instead of after the whole timeout. Strict-mode violations rethrow at once.
 */
async function waitForTarget(
  page: Page,
  union: Locator,
  state: "attached" | "visible",
  timeoutMs: number,
): Promise<void> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    try {
      await union.waitFor({ state, timeout: Math.max(1, Math.min(WAIT_SLICE_MS, left)) });
      return;
    } catch (e) {
      if (isStrictViolation(e) || Date.now() >= deadline) throw e;
    }
    const waited = Date.now() - started;
    if (waited >= SETTLED_MISS_MS && (await isSettled(page))) throw new SettledMiss(waited);
  }
}

function isStrictViolation(e: unknown): boolean {
  return /strict mode violation/i.test(String(e instanceof Error ? e.message : e));
}

async function sameElement(page: Page, a: ElementHandle, b: ElementHandle): Promise<boolean> {
  return page.evaluate(([x, y]) => x === y, [a, b] as const);
}

/** Best of the finalists by similarity, accepted only above the threshold and with the margin. */
function pickBySimilarity<T extends { descriptor: ElementDescriptor }>(
  stored: ElementDescriptor,
  finalists: T[],
): { best: T; score: number } | { reason: string } {
  const cls = interactionClass(stored);
  const scored = finalists
    .filter((f) => interactionClass(f.descriptor) === cls)
    .map((f) => ({ f, score: similarity(stored, f.descriptor) }))
    .sort((a, b) => b.score - a.score);
  const [first, second] = scored;
  if (!first) return { reason: `no ${cls} element to compare` };
  if (first.score < SIMILARITY_ACCEPT) {
    return { reason: `best similarity ${first.score.toFixed(2)} below ${SIMILARITY_ACCEPT}` };
  }
  if (second && first.score - second.score < SIMILARITY_MARGIN) {
    return {
      reason: `best similarity ${first.score.toFixed(2)} within ${SIMILARITY_MARGIN} of the runner-up (${second.score.toFixed(2)})`,
    };
  }
  return { best: first.f, score: first.score };
}

/** A locator for a similarity winner: its own best verified candidate. */
async function similarityResult(page: Page, handle: ElementHandle): Promise<ResolveResult> {
  const target = await describeHandle(page, handle);
  const first = target.candidates[0];
  if (!first)
    return { ok: false, code: "STEP_NOT_FOUND", detail: "similarity winner has no unique selector" };
  return {
    ok: true,
    locator: toLocator(page, first, { allowHidden: isFileFingerprint(target.fingerprint) }),
    candidateIdx: null,
    via: "similarity",
    descriptor: target.fingerprint,
  };
}

async function similarityOverPage(page: Page, target: Target, why: string): Promise<ResolveResult> {
  const picked = pickBySimilarity(target.fingerprint, await listDescriptors(page));
  if ("reason" in picked)
    return { ok: false, code: "STEP_NOT_FOUND", detail: `${why}; similarity: ${picked.reason}` };
  const handle = (
    await page.evaluateHandle((i) => window.__dh?.listItem(i) ?? null, picked.best.index)
  ).asElement();
  if (!handle) return { ok: false, code: "STEP_NOT_FOUND", detail: `${why}; similarity winner vanished` };
  try {
    return await similarityResult(page, handle);
  } finally {
    await handle.dispose();
  }
}

/**
 * Resolves a stored target on the live page. Fast path: the strong candidates' union resolves to one element
 * that passes the fingerprint check. Disagreement (candidates pointing at different elements) never trusts the
 * top-ranked candidate: it escalates (STEP_AMBIGUOUS), or with allowSimilarity picks among the disagreeing
 * elements by similarity with threshold and margin. A miss costs the deadline once, not once per candidate.
 */
export async function resolveTarget(
  page: Page,
  target: Target,
  opts: ResolveOptions,
): Promise<ResolveResult> {
  await ensureDh(page);
  const upload = isFileFingerprint(target.fingerprint);
  const all = target.candidates;
  const strongIdx = all.map((c, i) => (isStrongCandidate(c, all) ? i : -1)).filter((i) => i >= 0);
  // Weak candidates (text, positional CSS) only when there is nothing else; the fingerprint check still applies.
  const useIdx = strongIdx.length > 0 ? strongIdx : all.map((_, i) => i);
  if (useIdx.length === 0) {
    return opts.allowSimilarity
      ? similarityOverPage(page, target, "no candidates")
      : { ok: false, code: "STEP_NOT_FOUND", detail: "target has no candidates" };
  }
  const locs = useIdx.map((i) => toLocator(page, all[i] as Candidate, { allowHidden: upload }));
  const union = locs.reduce((a, b) => a.or(b));

  let waitError: unknown = null;
  try {
    await waitForTarget(page, union, upload ? "attached" : "visible", opts.timeoutMs);
  } catch (e) {
    waitError = e;
  }

  if (!waitError) {
    const counts = await Promise.all(locs.map((l) => l.count()));
    const matchedIdx = useIdx.filter((_, k) => counts[k] === 1);
    const handle = await union.elementHandle({ timeout: 1000 });
    try {
      return await acceptMatch(page, target, handle, matchedIdx, opts);
    } finally {
      await handle.dispose();
    }
  }

  if (!isStrictViolation(waitError)) {
    const detail =
      waitError instanceof SettledMiss
        ? `no candidate matched within ${waitError.waitedMs} ms (the page had settled)`
        : `no candidate matched within ${opts.timeoutMs} ms`;
    return opts.allowSimilarity
      ? similarityOverPage(page, target, detail)
      : { ok: false, code: "STEP_NOT_FOUND", detail };
  }

  // Several elements: either candidates disagree, or a candidate is itself ambiguous (a label shared by a
  // combobox and its listbox). Unique candidates decide; a multi-match candidate must include their element.
  const handles = await Promise.all(
    locs.map(async (l) =>
      (await l.count()) === 1 ? l.elementHandle({ timeout: 1000 }).catch(() => null) : null,
    ),
  );
  try {
    const unique: { idx: number; handle: ElementHandle }[] = [];
    handles.forEach((h, k) => {
      if (h) unique.push({ idx: useIdx[k] as number, handle: h });
    });
    const groups: { handle: ElementHandle; idx: number[] }[] = [];
    for (const u of unique) {
      let group: { handle: ElementHandle; idx: number[] } | undefined;
      for (const g of groups) if (await sameElement(page, g.handle, u.handle)) group = g;
      if (group) group.idx.push(u.idx);
      else groups.push({ handle: u.handle, idx: [u.idx] });
    }
    const describe = () =>
      useIdx.map((i, k) => `${JSON.stringify(all[i])}=${handles[k] ? 1 : "0 or many"}`).join(", ");
    if (groups.length === 1) {
      const only = groups[0] as { handle: ElementHandle; idx: number[] };
      const multi = useIdx.filter((_, k) => !handles[k]);
      let consistent = true;
      for (const i of multi) {
        const loc = toLocator(page, all[i] as Candidate, { allowHidden: upload });
        const n = await loc.count();
        if (n === 0) continue;
        const includes = await loc.evaluateAll(
          (els, t) => (els as Element[]).includes(t as Element),
          only.handle,
        );
        if (!includes) consistent = false;
      }
      if (consistent) return await acceptMatch(page, target, only.handle, only.idx, opts);
    }
    if (!opts.allowSimilarity || groups.length < 2) {
      return { ok: false, code: "STEP_AMBIGUOUS", detail: `candidates disagree: ${describe()}` };
    }
    const finalists: { handle: ElementHandle; descriptor: ElementDescriptor }[] = [];
    for (const g of groups) {
      const owner = await ownerHandle(g.handle);
      finalists.push({ handle: owner, descriptor: (await describeExact(page, owner)).fingerprint });
    }
    const picked = pickBySimilarity(target.fingerprint, finalists);
    if ("reason" in picked) {
      return {
        ok: false,
        code: "STEP_AMBIGUOUS",
        detail: `candidates disagree (${describe()}); ${picked.reason}`,
      };
    }
    return await similarityResult(page, picked.best.handle);
  } finally {
    await Promise.all(handles.map((h) => h?.dispose()));
  }
}

async function acceptMatch(
  page: Page,
  target: Target,
  handle: ElementHandle,
  matchedIdx: number[],
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const owner = await ownerHandle(handle);
  try {
    const live = (await describeExact(page, owner)).fingerprint;
    const matched = matchedIdx.map((i) => target.candidates[i] as Candidate);
    const check = fingerprintCheck(target.fingerprint, live, matched);
    if (!check.ok) {
      const detail = `matched element rejected: ${check.why}`;
      return opts.allowSimilarity
        ? similarityOverPage(page, target, detail)
        : { ok: false, code: "STEP_NOT_FOUND", detail };
    }
    const candidateIdx = matchedIdx[0] ?? null;
    const chosen = candidateIdx === null ? null : target.candidates[candidateIdx];
    if (!chosen) return { ok: false, code: "STEP_NOT_FOUND", detail: "no candidate resolved uniquely" };
    return {
      ok: true,
      locator: toLocator(page, chosen, { allowHidden: isFileFingerprint(target.fingerprint) }),
      candidateIdx,
      via: "candidate",
      descriptor: live,
    };
  } finally {
    if (owner !== handle) await owner.dispose();
  }
}

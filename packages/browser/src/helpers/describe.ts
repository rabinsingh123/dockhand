// Element description: what the recorder knows about an element, and the selector candidates that find it.
// Candidates come from the in-page script; role and name are replaced by Playwright's own (ariaSnapshotJSON);
// a candidate is kept only if Playwright resolves it to exactly the target element.

import type { Candidate, ElementDescriptor, Target } from "@dockhand/core";
import type { ElementHandle, Locator, Page } from "playwright";
import {
  ensureDh,
  type RawCandidate,
  type RawDescription,
  type RawFingerprint,
  type RawState,
} from "../dom/script.ts";
import { bareName, isPositionalCss, toLocator } from "./locators.ts";

const MAX_CANDIDATES = 6;
const NON_ROLES = new Set(["", "generic", "text", "none", "presentation"]);

export interface EngineName {
  role: string;
  name: string;
}

/** Playwright's role and accessible name for the element a (unique) CSS selector points at. */
export async function engineRoleName(page: Page, css: string): Promise<EngineName | null> {
  try {
    const nodes = (await page.locator(css).first().ariaSnapshotJSON({ depth: 0, timeout: 1000 })) as unknown;
    const node = Array.isArray(nodes)
      ? (nodes[0] as { role?: unknown; name?: unknown } | undefined)
      : undefined;
    if (!node || typeof node.role !== "string" || NON_ROLES.has(node.role)) return null;
    return { role: node.role, name: typeof node.name === "string" ? node.name : "" };
  } catch {
    return null;
  }
}

/**
 * A CSS selector that resolves to exactly this element, stable ones first. A `name` attribute is not enough:
 * every radio of a group shares it, and Playwright's role and name would then come from the group's first
 * option instead of the one clicked.
 */
async function anchorCss(page: Page, raw: RawDescription, handle: ElementHandle): Promise<string | null> {
  const css = raw.candidates.list.filter(
    (c): c is Extract<RawCandidate, { kind: "css" }> => c.kind === "css",
  );
  for (const c of [...css.filter((c) => !c.positional), ...css.filter((c) => c.positional)]) {
    if (await candidateHits(page, { by: "css", value: c.css }, handle, true)) return c.css;
  }
  return null;
}

export function isFileFingerprint(fp: { tag: string; type?: string; inputType?: string }): boolean {
  return fp.tag === "input" && (fp.type ?? fp.inputType ?? "").toLowerCase() === "file";
}

const CHECKABLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

// Every <input> has a boolean `checked`, so it only means something for checkable controls.
function stateValue(fp: RawFingerprint, state: RawState | undefined): string | undefined {
  if (!state) return undefined;
  const type = fp.type.toLowerCase();
  if (fp.tag === "input" && (type === "checkbox" || type === "radio")) return String(state.checked === true);
  if (CHECKABLE_ROLES.has(fp.role)) return String(state.checked === true || state.checked === "true");
  if (fp.tag === "input" && type === "file") return undefined;
  return state.value ?? undefined;
}

/** In-page fingerprint (+ Playwright's role/name when known) -> contract ElementDescriptor. */
export function toDescriptor(
  fp: RawFingerprint,
  engine: EngineName | null,
  state?: RawState,
  formSubmit?: boolean,
): ElementDescriptor {
  const d: ElementDescriptor = { tag: fp.tag, bbox: { x: fp.box.x, y: fp.box.y, w: fp.box.w, h: fp.box.h } };
  if (fp.tag === "input") d.inputType = (fp.type || "text").toLowerCase();
  const role = engine?.role || fp.role;
  if (role) d.role = role;
  const name = bareName(engine ? engine.name : fp.name);
  if (name) d.name = name;
  const label = bareName(fp.label);
  if (label) d.label = label;
  if (fp.placeholder) d.placeholder = fp.placeholder;
  if (fp.testid) d.testId = fp.testid;
  if (fp.id) d.domId = fp.id;
  if (fp.nameAttr) d.nameAttr = fp.nameAttr;
  if (fp.text) d.text = fp.text.slice(0, 80);
  const value = stateValue(fp, state);
  if (value !== undefined) d.value = value;
  const section = bareName(fp.section || fp.heading);
  if (section) d.section = section;
  if (formSubmit) d.formSubmit = true;
  return d;
}

function toCandidates(list: RawCandidate[], engine: EngineName | null): Candidate[] {
  const out: Candidate[] = [];
  for (const c of list) {
    switch (c.kind) {
      case "testid":
        out.push({ by: "testid", value: c.value });
        break;
      case "role":
        if (!engine) out.push({ by: "role", role: c.role, name: bareName(c.name), exact: true });
        break;
      case "label":
        if (bareName(c.text)) out.push({ by: "label", value: bareName(c.text), exact: true });
        break;
      case "placeholder":
        out.push({ by: "placeholder", value: c.text });
        break;
      case "text":
        out.push({ by: "text", value: c.text, exact: true });
        break;
      case "css":
        out.push({ by: "css", value: c.css });
        break;
    }
  }
  // Playwright's name includes CSS pseudo-content ("Company name *"); the stored name is the bare one.
  if (engine && bareName(engine.name))
    out.unshift({ by: "role", role: engine.role, name: bareName(engine.name), exact: true });
  return out;
}

type TargetKind = "text" | "button" | "combobox" | "check" | "file" | "option";

function targetKind(d: ElementDescriptor): TargetKind {
  if (isFileFingerprint(d)) return "file";
  switch (d.role) {
    case "textbox":
    case "searchbox":
    case "spinbutton":
      return "text";
    case "combobox":
    case "listbox":
      return "combobox";
    case "checkbox":
    case "radio":
    case "switch":
      return "check";
    case "option":
      return "option";
    default:
      return d.tag === "textarea" || d.tag === "input" ? "text" : "button";
  }
}

type Slot = "testid" | "role" | "label" | "anchor" | "placeholder" | "text" | "positional";

// Rank order per target kind (label collides with popups on comboboxes); see docs/ARCHITECTURE.md 2.2.
const RANKS: Record<TargetKind, Slot[]> = {
  text: ["testid", "role", "label", "anchor", "placeholder", "text", "positional"],
  button: ["testid", "role", "anchor", "label", "text", "placeholder", "positional"],
  combobox: ["role", "testid", "anchor", "label", "placeholder", "text", "positional"],
  check: ["role", "label", "anchor", "testid", "text", "placeholder", "positional"],
  file: ["label", "anchor", "testid", "role", "text", "placeholder", "positional"],
  option: ["role", "testid", "text", "anchor", "label", "placeholder", "positional"],
};

function slotOf(c: Candidate): Slot {
  if (c.by === "css") return isPositionalCss(c) ? "positional" : "anchor";
  return c.by;
}

function rank(cands: Candidate[], kind: TargetKind): Candidate[] {
  const order = RANKS[kind];
  return cands
    .map((c, i) => ({ c, i, r: order.indexOf(slotOf(c)) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/** True when the candidate resolves to exactly one element and that element is `handle` (text may hit a child). */
export async function candidateHits(
  page: Page,
  c: Candidate,
  handle: ElementHandle,
  allowHidden: boolean,
): Promise<boolean> {
  try {
    const loc = toLocator(page, c, { allowHidden });
    if ((await loc.count()) !== 1) return false;
    return await loc.evaluate(
      (el, [target, isText]) => el === target || (isText && (target as Element).contains(el)),
      [handle, c.by === "text"] as const,
      { timeout: 1000 },
    );
  } catch {
    return false;
  }
}

/** Describes exactly this element (no climbing) with verified candidates. */
export async function describeExact(page: Page, handle: ElementHandle): Promise<Target> {
  const raw = await handle.evaluate((el) => window.__dh?.describeExact(el as Element) ?? null);
  if (!raw) throw new Error("dockhand capture script is not installed on this page");
  const fp = raw.fingerprint;
  if (fp.tag === "body" || fp.tag === "html")
    return { candidates: [], fingerprint: toDescriptor(fp, null, raw.state) };
  const formSubmit = await handle.evaluate((el) => window.__dh?.formSubmitOf(el as Element) ?? false);
  const css = await anchorCss(page, raw, handle);
  // Playwright reads a proxied dropdown's widget by its inner search box (a textbox): keep the in-page role.
  const engine = css && !fp.proxied ? await engineRoleName(page, css) : null;
  const descriptor = toDescriptor(fp, engine, raw.state, formSubmit);
  const file = isFileFingerprint(fp);
  const all = toCandidates(raw.candidates.list, engine);
  const hits = await Promise.all(all.map((c) => candidateHits(page, c, handle, file)));
  const verified = all.filter((_, i) => hits[i]);
  return {
    candidates: rank(verified, targetKind(descriptor)).slice(0, MAX_CANDIDATES),
    fingerprint: descriptor,
  };
}

/** The element that owns the interaction for `handle` (a label's control, the button around an icon). */
export async function ownerHandle(handle: ElementHandle): Promise<ElementHandle> {
  const owner = (await handle.evaluateHandle((el) => window.__dh?.ownerOf(el as Element) ?? el)).asElement();
  return owner ?? handle;
}

export interface DescribedElement {
  target: Target;
  /** The described element; the caller disposes it. */
  handle: ElementHandle;
}

/** describeAt that keeps the element handle (trace capture reads the field again after the batch). */
export async function describeAtWithHandle(
  page: Page,
  x: number,
  y: number,
): Promise<DescribedElement | null> {
  await ensureDh(page);
  const handle = (
    await page.evaluateHandle(([px, py]) => window.__dh?.ownerAt(px, py) ?? null, [x, y] as const)
  ).asElement();
  if (!handle) return null;
  return { target: await describeExact(page, handle), handle };
}

/** The focused element; null when focus is on the body (typed text went nowhere). */
export async function describeActiveWithHandle(page: Page): Promise<DescribedElement | null> {
  await ensureDh(page);
  const handle = (await page.evaluateHandle(() => window.__dh?.activeEl() ?? null)).asElement();
  if (!handle) return null;
  return { target: await describeExact(page, handle), handle };
}

/** Describes the element that owns the interaction for `handle` (file chooser inputs, similarity winners). */
export async function describeHandle(page: Page, handle: ElementHandle): Promise<Target> {
  await ensureDh(page);
  // Adopt into the main world first: FileChooser.element() lives in Playwright's utility world, without __dh.
  const main = (await page.evaluateHandle((el) => el, handle)).asElement();
  if (!main) throw new Error("describeHandle: not an element");
  const owner = await ownerHandle(main);
  try {
    return await describeExact(page, owner);
  } finally {
    if (owner !== main) await owner.dispose();
    await main.dispose();
  }
}

function emptyTarget(x: number, y: number): Target {
  return { candidates: [], fingerprint: { tag: "", bbox: { x, y, w: 0, h: 0 } } };
}

/**
 * The element a click at (x, y) would hit, climbed to the element that owns the interaction (a label's control,
 * a button around an icon), with verified candidates. Coordinates are CSS pixels in the viewport.
 */
export async function describeAt(page: Page, x: number, y: number): Promise<Target> {
  const r = await describeAtWithHandle(page, x, y);
  if (!r) return emptyTarget(x, y);
  await r.handle.dispose();
  return r.target;
}

/** Describes the element a locator resolves to (strict: exactly one element). */
export async function describeLocator(locator: Locator): Promise<Target> {
  const handle = await locator.elementHandle({ timeout: 5000 });
  try {
    return await describeHandle(locator.page(), handle);
  } finally {
    await handle.dispose();
  }
}

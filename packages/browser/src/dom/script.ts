// Node side of the in-page capture script (dh-capture.js): source, install, and the shapes it returns.

import { readFileSync } from "node:fs";
import type { Page } from "playwright";

/** The in-page script. Installed on every leased context with addInitScript; `ensureDh` covers other pages. */
export const DH_SCRIPT: string = readFileSync(new URL("./dh-capture.js", import.meta.url), "utf8");

export interface RawBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type RawCandidate =
  | { kind: "testid"; value: string }
  | { kind: "role"; role: string; name: string }
  | { kind: "label"; text: string }
  | { kind: "placeholder"; text: string }
  | { kind: "text"; text: string }
  | { kind: "css"; css: string; positional: boolean };

export interface RawFingerprint {
  tag: string;
  type: string;
  role: string;
  name: string;
  label: string;
  placeholder: string;
  nameAttr: string;
  id: string;
  testid: string;
  text: string;
  section: string;
  heading: string;
  classes: string[];
  box: RawBox;
  ordinal: number;
  /** A proxied dropdown's widget or one of its items: the in-page role wins over Playwright's. */
  proxied?: boolean;
}

export interface RawState {
  value: string | null;
  checked: boolean | string | null;
  expanded: string | null;
  disabled: boolean;
  invalid: boolean;
}

export interface RawDescription {
  uid: number;
  interactive: boolean;
  hitTag: string | null;
  viaLabel: boolean;
  candidates: { list: RawCandidate[]; scope: { role: string; name: string } | null };
  fingerprint: RawFingerprint;
  state: RawState;
}

export interface RawListItem {
  index: number;
  uid: number;
  fingerprint: RawFingerprint;
  state: RawState;
  formSubmit: boolean;
}

export interface ViewRect {
  uid: number;
  x: number;
  y: number;
  w: number;
  h: number;
  role: string;
  name: string;
}

export interface CommitInfo {
  tag: string;
  name: string;
  buttonLike: boolean;
  link: boolean;
  submitType: boolean;
  inForm: boolean;
  inDialog: boolean;
  box: RawBox;
}

export type ActiveCommit =
  | { kind: "none" | "multiline" | "listbox"; filled: number }
  | { kind: "button"; self: CommitInfo | null; filled: number }
  | { kind: "field"; def: CommitInfo | null; filled: number };

export interface PageSignature {
  url: string;
  title: string;
  dialogs: number[];
  popups: string;
  expanded: string;
  alerts: string;
  focus: number;
  values: string;
  scrollX: number;
  scrollY: number;
}

export interface DhApi {
  last?: Element;
  describeAt(x: number, y: number): RawDescription | null;
  viewMap(): ViewRect[];
  describeActive(): RawDescription | null;
  fingerprintOf(el: Element): RawFingerprint;
  ownerAt(x: number, y: number): Element | null;
  ownerOf(el: Element): Element;
  activeEl(): Element | null;
  describeExact(el: Element): RawDescription;
  uidOf(el: Element): number;
  hitUid(x: number, y: number): { uid: number | null; interactive: boolean };
  formSubmitOf(el: Element): boolean;
  fieldValue(el: Element): string;
  fieldValueIfConnected(el: Element | null): string | null;
  formSnapshot(): Record<string, string>;
  interactiveList(): RawListItem[];
  listItem(i: number): Element | null;
  signature(): PageSignature;
  commitAt(x: number, y: number): { info: CommitInfo | null; filled: number };
  commitActive(): ActiveCommit;
  commitButtons(): CommitInfo[];
  requiredEmpty(): string[];
  pageText(): string;
  mainHeading(): string;
  frames(): Promise<void>;
  waitScrollIdle(x: number, y: number, maxMs: number): Promise<string>;
  /** A custom dropdown driving a hidden native <select>: the options it shows (while open) and the choice. */
  proxy?(el: Element): { options: string[]; selected: string } | null;
  /** The shown item of that dropdown whose text is `label`, or null while it is closed. */
  proxyOption?(el: Element, label: string): Element | null;
  /** Settledness inputs for replay (helpers/settle.ts). */
  settle?(): { domQuietMs: number; busy: boolean; ready: boolean };
}

// Evaluate callbacks reference `window.__dh` directly and stay single expressions: they are serialized into the
// page, and tsx (esbuild keepNames) would wrap any named inner function in a `__name` helper the page lacks.
declare global {
  interface Window {
    __dh?: DhApi;
  }
}

/** Installs the capture script if this document does not have it (pages not opened by the pool, setContent). */
export async function ensureDh(page: Page): Promise<void> {
  const installed = await page.evaluate(() => typeof window.__dh?.describeExact === "function");
  if (!installed) await page.evaluate(DH_SCRIPT);
}

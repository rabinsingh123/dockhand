// Candidate -> Playwright locator, and the name normalization every candidate goes through.

import type { Candidate } from "@dockhand/core";
import type { Locator, Page } from "playwright";

type AriaRole = Parameters<Page["getByRole"]>[0];

/** Accessible names and labels are stored without required-asterisks, trailing colons or extra whitespace. */
export function bareName(s: string | null | undefined): string {
  return (s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[\s*]+|[\s*:]+$/g, "");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Exact-name matcher that ignores decoration: case, surrounding whitespace, required-asterisks and trailing
 * colons. "Company name" matches "Company name *" and "company name:", never "Company name (legal)".
 */
export function decoratedNameRegex(name: string): RegExp {
  const core = escapeRegex(bareName(name)).replace(/ /g, "\\s+");
  return new RegExp(`^[\\s*]*${core}[\\s*:]*$`, "i");
}

export interface ToLocatorOptions {
  /** Upload targets: file inputs are often hidden, and setInputFiles works on hidden inputs. */
  allowHidden?: boolean;
}

/**
 * Maps a stored candidate to a locator. Role locators skip hidden elements by themselves; every other kind is
 * filtered to visible elements (a hidden duplicate testid would otherwise make the candidate ambiguous).
 * `exact: true` on role and label candidates means "this name, give or take decoration" (see decoratedNameRegex).
 */
export function toLocator(page: Page, c: Candidate, opts: ToLocatorOptions = {}): Locator {
  const visible = (l: Locator) => (opts.allowHidden ? l : l.filter({ visible: true }));
  switch (c.by) {
    case "testid":
      return visible(page.getByTestId(c.value));
    case "role": {
      const name = bareName(c.name);
      return page.getByRole(c.role as AriaRole, {
        ...(name ? { name: c.exact ? decoratedNameRegex(name) : name } : {}),
        ...(opts.allowHidden ? { includeHidden: true } : {}),
      });
    }
    case "label":
      return visible(page.getByLabel(c.exact ? decoratedNameRegex(c.value) : c.value));
    case "placeholder":
      return visible(page.getByPlaceholder(c.value, { exact: true }));
    case "text":
      return visible(page.getByText(c.value, { exact: c.exact }));
    case "css":
      return visible(page.locator(c.value));
  }
}

/** Positional CSS (nth-of-type paths) survives no reorder: heal evidence only, never a fast-path candidate. */
export function isPositionalCss(c: Candidate): boolean {
  return c.by === "css" && /:nth-(of-type|child)\(/.test(c.value);
}

/**
 * Strong candidates form the replay fast path (one or() union). Text and positional CSS are weak; a placeholder
 * counts only when the field has no label candidate.
 */
export function isStrongCandidate(c: Candidate, all: readonly Candidate[]): boolean {
  switch (c.by) {
    case "testid":
    case "role":
    case "label":
      return true;
    case "css":
      return !isPositionalCss(c);
    case "placeholder":
      return !all.some((o) => o.by === "label");
    case "text":
      return false;
  }
}

/** Candidate families: two agreeing families (attribute + text) are independent evidence for the same element. */
export function candidateFamily(c: Candidate): "attribute" | "text" {
  return c.by === "testid" || c.by === "css" ? "attribute" : "text";
}

// Commit target test (docs/ARCHITECTURE.md 2.2, commit guard). Harness-enforced; bias to block: a false positive
// costs one extra approval tap, a false negative submits without approval.

import type { ActiveCommit, CommitInfo } from "../dom/script.ts";
import { bareName } from "../helpers/locators.ts";

export const COMMIT_NAME = /submit|register|send|confirm|finish|enviar|registrar|concluir/i;
// Submit-type buttons that move through a wizard or a login instead of committing.
const NAVIGATION_NAME =
  /^(next|continue|back|previous|prev|cancel|close|save draft|save and continue|save & continue|choose file|replace|remove|upload|add|search|clear|reset|edit|sign in|log in|login|start)\b/i;
// "Register a deal", "Register another deal": entry points that open a form rather than submit one.
const ENTRY_POINT = /\b(a|an|another|new)\b/i;

const norm = (s: string) => bareName(s).toLowerCase();

/**
 * A control is a commit target when its name is one of `hints`; or it is a button whose name matches
 * COMMIT_NAME (inside a form or dialog, or anywhere unless it reads like an entry point on a page with nothing
 * filled in); or it is the submit-type button of a form and its name is not navigation ("Next", "Sign in").
 */
export function isCommitTarget(
  info: CommitInfo | null,
  filledFields: number,
  hints: readonly string[],
): boolean {
  if (!info) return false;
  const name = norm(info.name);
  if (name && hints.some((h) => norm(h) === name)) return true;
  if (!info.buttonLike) return false;
  if (COMMIT_NAME.test(info.name)) {
    if (info.inForm || info.inDialog) return true;
    return !(ENTRY_POINT.test(info.name) && filledFields === 0);
  }
  return info.inForm && info.submitType && !NAVIGATION_NAME.test(info.name.trim());
}

/** The control an Enter (or Space) keypress would activate as a commit, or null. */
export function keyCommitTarget(
  active: ActiveCommit,
  key: "enter" | "space",
  hints: readonly string[],
): CommitInfo | null {
  switch (active.kind) {
    case "button":
      return isCommitTarget(active.self, active.filled, hints) ? active.self : null;
    case "field":
      // Enter in a single-line field submits the form through its default button.
      return key === "enter" && isCommitTarget(active.def, active.filled, hints) ? active.def : null;
    default:
      return null; // textarea / contenteditable newline, an open listbox choosing an option, nothing focused
  }
}

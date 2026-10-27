// Field values and the interactive-element inventory.

import type { InteractiveElement } from "@dockhand/core";
import type { Locator, Page } from "playwright";
import { ensureDh } from "../dom/script.ts";
import { describeHandle, toDescriptor } from "./describe.ts";

/**
 * Visible field values keyed by label (asterisks and colons stripped): text fields their value, comboboxes the
 * shown selection, standalone checkboxes "true"/"false", radio groups the chosen option, checkbox groups the
 * ticked options joined with ", ", file inputs the chosen file names. Duplicate labels get " (<section>)".
 */
export async function formSnapshot(page: Page): Promise<Record<string, string>> {
  await ensureDh(page);
  return page.evaluate(() => window.__dh?.formSnapshot() ?? {});
}

/** Inputs: value; comboboxes: shown selection; checkbox/radio: "true"/"false"; file inputs: file names. */
export async function readFieldValue(locator: Locator): Promise<string> {
  await ensureDh(locator.page());
  return locator.evaluate((el) => window.__dh?.fieldValue(el) ?? "", undefined, { timeout: 5000 });
}

/** Fingerprints of every visible interactive element, without candidates (cheap; used for similarity). */
export async function listDescriptors(page: Page) {
  await ensureDh(page);
  const items = await page.evaluate(() => window.__dh?.interactiveList() ?? []);
  return items.map((it) => ({
    index: it.index,
    descriptor: toDescriptor(it.fingerprint, null, it.state, it.formSubmit),
  }));
}

/** Every visible interactive element, described like a trace target (for similarity and the open-weights rung). */
export async function listInteractive(page: Page): Promise<InteractiveElement[]> {
  const items = await listDescriptors(page);
  return Promise.all(
    items.map(async (it) => {
      const handle = (
        await page.evaluateHandle((i) => window.__dh?.listItem(i) ?? null, it.index)
      ).asElement();
      if (!handle) return { index: it.index, descriptor: it.descriptor, candidates: [] };
      try {
        const target = await describeHandle(page, handle);
        return { index: it.index, descriptor: target.fingerprint, candidates: target.candidates };
      } finally {
        await handle.dispose();
      }
    }),
  );
}

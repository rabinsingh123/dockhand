// Page-level actions and checks the runner needs beyond Playwright's built-ins: ARIA combobox selection by
// exact option name, accessible validation errors, and the post-commit success wait.

import { DockhandError } from "@dockhand/core";
import type { Locator, Page } from "playwright";
import { normalizeText } from "./template.ts";

/** Picks `option` (case- and accent-insensitive, never fuzzy) on a native <select> or an ARIA combobox. */
export async function selectOption(
  page: Page,
  trigger: Locator,
  option: string,
  timeoutMs: number,
): Promise<void> {
  const want = normalizeText(option);
  const info = await trigger.evaluate((el) => ({
    tag: el.tagName.toLowerCase(),
    editable:
      (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.readOnly && !el.disabled,
  }));
  if (info.tag === "select") {
    const labels = await trigger.evaluate((el) =>
      [...(el as HTMLSelectElement).options].map((o) => (o.label || o.text).trim()),
    );
    const hits = labels.filter((l) => normalizeText(l) === want);
    if (hits.length !== 1) {
      throw new DockhandError(
        "ASSERT_FAILED",
        `option "${option}" is not in the list (${labels.join(", ")})`,
      );
    }
    await trigger.selectOption({ label: hits[0] as string }, { timeout: timeoutMs });
    return;
  }
  await trigger.click({ timeout: timeoutMs });
  if (info.editable) await trigger.fill(option, { timeout: timeoutMs });
  const options = await optionLocator(page, trigger);
  try {
    await options.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    await trigger.press("Escape").catch(() => {});
    throw new DockhandError("ASSERT_FAILED", `no options appeared for "${option}"`);
  }
  const names = (await options.allInnerTexts()).map((t) => t.trim());
  const idx: number[] = [];
  names.forEach((n, i) => {
    if (normalizeText(n) === want) idx.push(i);
  });
  if (idx.length !== 1) {
    await trigger.press("Escape").catch(() => {});
    throw new DockhandError(
      "ASSERT_FAILED",
      idx.length === 0
        ? `option "${option}" is not in the list (${names.slice(0, 12).join(", ")})`
        : `option "${option}" appears ${idx.length} times`,
    );
  }
  await options.nth(idx[0] as number).click({ timeout: timeoutMs });
}

/** Options of the listbox the trigger controls, else of the only visible listbox. */
async function optionLocator(page: Page, trigger: Locator): Promise<Locator> {
  const controls = await trigger.getAttribute("aria-controls").catch(() => null);
  if (controls) return page.locator(`[id="${controls.replace(/"/g, '\\"')}"]`).getByRole("option");
  return page.getByRole("listbox").filter({ visible: true }).last().getByRole("option");
}

/** The choices a field offers (combobox options, select options, radio labels), or undefined for free text. */
export async function harvestOptions(
  page: Page,
  field: Locator,
  timeoutMs: number,
): Promise<string[] | undefined> {
  const kind = await field.evaluate((el) => {
    const role = el.getAttribute("role");
    if (el.tagName === "SELECT") return "select";
    if (role === "combobox") return "combobox";
    if (role === "radiogroup") return "radiogroup";
    return "other";
  });
  if (kind === "select") {
    const opts = await field.evaluate((el) =>
      [...(el as HTMLSelectElement).options]
        .filter((o) => o.value !== "")
        .map((o) => (o.label || o.text).trim()),
    );
    return opts.length > 0 ? opts : undefined;
  }
  if (kind === "radiogroup") {
    const labels = await field
      .getByRole("radio")
      .evaluateAll((els) =>
        els.map(
          (e) =>
            (e as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? e.getAttribute("aria-label") ?? "",
        ),
      );
    return labels.filter(Boolean);
  }
  if (kind !== "combobox") return undefined;
  try {
    await field.click({ timeout: timeoutMs });
    const options = await optionLocator(page, field);
    await options.first().waitFor({ state: "visible", timeout: timeoutMs });
    const names = (await options.allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    return names.length > 0 ? names : undefined;
  } catch {
    return undefined;
  } finally {
    await field.press("Escape").catch(() => {});
  }
}

// Page functions below are serialized with toString(). They must not bind inner functions
// (`const f = () => ...`): under tsx, esbuild's keepNames wraps those in __name(), which does not exist in
// the page and throws.

/**
 * In-page: visible error signals (aria-invalid fields, non-empty role=alert regions, and the Bootstrap-style
 * `.has-error` / `.is-invalid` marks that pages without ARIA error states use, EspoCRM among them).
 */
function countIssuesInPage(): number {
  let n = 0;
  for (const e of document.querySelectorAll(
    '[aria-invalid="true"], [role="alert"], .has-error, .is-invalid',
  )) {
    const style = getComputedStyle(e);
    if (e.getClientRects().length === 0 || style.visibility === "hidden" || style.display === "none")
      continue;
    if (
      e.getAttribute("aria-invalid") !== "true" &&
      e.getAttribute("role") === "alert" &&
      !(e.textContent ?? "").trim()
    )
      continue;
    n++;
  }
  return n;
}

export async function issueCount(page: Page): Promise<number> {
  return page.evaluate(countIssuesInPage).catch(() => 0);
}

/** In-page: true when a required control is still empty (radio groups by group, file inputs never). */
function isEmptyRequiredInPage(el: Element): boolean {
  const input = el as HTMLInputElement;
  const type = (el.getAttribute("type") ?? "").toLowerCase();
  if (el.tagName === "INPUT" && type === "file") return false;
  if (el.tagName === "INPUT" && type === "radio") {
    // A radio inside a required radiogroup is judged by the group.
    if (el.closest('[role="radiogroup"][aria-required="true"], fieldset[aria-required="true"]')) return false;
    const scope = input.form ?? document;
    return !scope.querySelector(`input[type="radio"][name="${CSS.escape(input.name)}"]:checked`);
  }
  if (el.getAttribute("role") === "radiogroup" || el.tagName === "FIELDSET")
    return !el.querySelector('input:checked, [aria-checked="true"]');
  if (el.tagName === "INPUT" && type === "checkbox") return !input.checked;
  if (el.getAttribute("role") === "checkbox" || el.getAttribute("role") === "switch")
    return el.getAttribute("aria-checked") !== "true";
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement)
    return el.value.trim() === "";
  return (el.textContent ?? "").trim() === "";
}

/**
 * Visible required fields that are still empty, as locators (one per radio group; file inputs are left to
 * the portal's own validation, since nobody can type a file into WhatsApp).
 */
export async function emptyRequiredFields(page: Page): Promise<Locator[]> {
  const all = page.locator('[required], [aria-required="true"]');
  const n = await all.count().catch(() => 0);
  const out: Locator[] = [];
  const radioNames = new Set<string>();
  for (let i = 0; i < n; i++) {
    const el = all.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    if (!(await el.evaluate(isEmptyRequiredInPage).catch(() => false))) continue;
    const radioName = await el
      .evaluate((node) =>
        node.tagName === "INPUT" && node.getAttribute("type") === "radio"
          ? (node as HTMLInputElement).name
          : "",
      )
      .catch(() => "");
    if (radioName) {
      if (radioNames.has(radioName)) continue;
      radioNames.add(radioName);
    }
    out.push(el);
  }
  return out;
}

/**
 * Visible fields marked aria-invalid, as locators. A page with no aria-invalid field at all falls back to
 * Bootstrap-style marks: a control with `.is-invalid`, or the first control inside a `.has-error` container.
 */
export async function invalidFields(page: Page): Promise<Locator[]> {
  const visible = async (all: Locator): Promise<Locator[]> => {
    const n = await all.count();
    const out: Locator[] = [];
    for (let i = 0; i < n; i++) {
      const el = all.nth(i);
      if (await el.isVisible().catch(() => false)) out.push(el);
    }
    return out;
  };
  const aria = await visible(page.locator('[aria-invalid="true"]'));
  if (aria.length > 0) return aria;
  const control =
    'input:not([type=hidden]):not([type=button]):not([type=submit]), select, textarea, [role="combobox"], [contenteditable="true"]';
  const out: Locator[] = [];
  for (const mark of await visible(page.locator(".has-error, .is-invalid"))) {
    if (await mark.evaluate((el, sel) => el.matches(sel), control).catch(() => false)) {
      out.push(mark);
      continue;
    }
    const inner = await visible(mark.locator(control));
    if (inner[0]) out.push(inner[0]);
  }
  return out;
}

export async function alertTexts(page: Page): Promise<string[]> {
  const texts = await page
    .locator('[role="alert"]')
    .allInnerTexts()
    .catch(() => [] as string[]);
  return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

export type CommitOutcome = "success" | "validation" | "timeout";

/**
 * After a commit click: resolves "success" when the URL and text checks hold, "validation" when new error
 * signals appear first, "timeout" when neither happens by the deadline. With no check at all, only a
 * validation bounce is decidable (a short wait), and everything else is "timeout".
 */
export async function waitForOutcome(
  page: Page,
  check: { urlIncludes: string | null; textPattern: string | null; baseline: number },
  timeoutMs: number,
): Promise<CommitOutcome> {
  const decidable = check.urlIncludes !== null || check.textPattern !== null;
  try {
    const handle = await page.waitForFunction(
      ({ url, pattern, baseline, decidable }) => {
        if (decidable) {
          const urlOk = url === null || location.href.includes(url);
          // biome-ignore lint/performance/useDomNodeTextContent: visible text only; textContent includes inline JSON.
          const textOk = pattern === null || new RegExp(pattern).test(document.body?.innerText ?? "");
          if (urlOk && textOk) return "success";
        }
        // Same count as countIssuesInPage, inlined (a page function cannot call another one).
        let issues = 0;
        for (const e of document.querySelectorAll(
          '[aria-invalid="true"], [role="alert"], .has-error, .is-invalid',
        )) {
          const style = getComputedStyle(e);
          if (e.getClientRects().length === 0 || style.visibility === "hidden" || style.display === "none")
            continue;
          if (
            e.getAttribute("aria-invalid") !== "true" &&
            e.getAttribute("role") === "alert" &&
            !(e.textContent ?? "").trim()
          )
            continue;
          issues++;
        }
        return issues > baseline ? "validation" : false;
      },
      { url: check.urlIncludes, pattern: check.textPattern, baseline: check.baseline, decidable },
      { timeout: decidable ? timeoutMs : Math.min(timeoutMs, 2000), polling: 100 },
    );
    return (await handle.jsonValue()) as CommitOutcome;
  } catch {
    return "timeout";
  }
}

/**
 * Marks the element as written by `stepId` and returns the step that wrote it before, if another one did.
 * One element per step per run: a heal that lands on a field another step already filled is a false heal.
 */
export async function claimElement(locator: Locator, stepId: string): Promise<string | null> {
  return locator.evaluate((el, id) => {
    const w = window as unknown as { __dhBound?: WeakMap<Element, string> };
    w.__dhBound ??= new WeakMap();
    const prev = w.__dhBound.get(el);
    if (prev === undefined) w.__dhBound.set(el, id);
    return prev !== undefined && prev !== id ? prev : null;
  }, stepId);
}

export async function sameElement(a: Locator, b: Locator): Promise<boolean> {
  try {
    const handle = await b.elementHandle({ timeout: 500 });
    try {
      return await a.evaluate((x, y) => x === y, handle);
    } finally {
      await handle.dispose();
    }
  } catch {
    return false;
  }
}

/** Visible page text (innerText: inline scripts and hidden elements, such as boot JSON, are left out). */
export async function bodyText(page: Page): Promise<string> {
  return (
    page
      .locator("body")
      // biome-ignore lint/performance/useDomNodeTextContent: Playwright's innerText(), visible text on purpose.
      .innerText({ timeout: 2000 })
      .catch(() => "")
  );
}

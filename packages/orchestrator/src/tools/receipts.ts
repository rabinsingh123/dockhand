// Receipts: the phone card a finished run sends (tools/phone-cards.ts draws it) and its WhatsApp caption.
// Text comes from templates (zero model calls); costs always show execution and intake separately, at the
// ledger's precision.

import type { ArtifactRef, ArtifactStore, Id, Receipt } from "@dockhand/core";
import {
  createPhoneCards,
  money,
  type PhoneRender,
  receiptPhoneCardHtml,
  type ShotCrop,
  seconds,
  TIER_LABEL,
} from "./phone-cards.ts";

export { seconds };

/** The page renderer the cards use (the browser pool's renderHtml). */
export type RenderHtml = PhoneRender;

export const OPEN_WEIGHTS_CREDIT = "Built with Muse Spark Open";

/** Money in captions and commands: the same formatter as the cards ($0.0047, $0.096, $0.30; only zero is $0). */
export const usd = money;

// ---------- receipt ----------

export interface ReceiptView {
  title: string;
  tier: Receipt["tier"];
  headline?: string;
  /** The status over the ID on the card ("Deal registered"); "Done" when unset. */
  done?: string;
  /** Short lines; the first sits under the ID on the card. */
  lines: string[];
  seconds: number;
  execCostUsd: number;
  intakeCostUsd: number;
  skill?: { name: string; version: number };
  verified?: { matched: number; checked: number };
  usedOpenWeights?: boolean;
  /** PNG of the final page. */
  screenshot?: Uint8Array;
  /** The confirmation panel on that page (RECEIPT_CROP). */
  crop?: ShotCrop;
}

/** The receipt card: the portal's confirmation, the status and the record ID big, then read back, time and cost. */
export function receiptHtml(r: ReceiptView): string {
  const line = r.lines[0];
  return receiptPhoneCardHtml({
    title: r.title,
    tier: r.tier,
    ...(r.headline ? { headline: r.headline } : {}),
    ...(r.done ? { done: r.done } : {}),
    ...(line ? { line } : {}),
    seconds: r.seconds,
    execCostUsd: r.execCostUsd,
    intakeCostUsd: r.intakeCostUsd,
    ...(r.skill ? { skill: r.skill } : {}),
    ...(r.verified ? { verified: r.verified } : {}),
    ...(r.usedOpenWeights ? { usedOpenWeights: true } : {}),
    ...(r.screenshot ? { screenshot: r.screenshot } : {}),
    ...(r.crop ? { crop: r.crop } : {}),
  });
}

// ---------- rendering ----------

export interface CardRenderer {
  receipt(jobId: Id, view: ReceiptView): Promise<Receipt>;
  card(jobId: Id, html: string): Promise<ArtifactRef>;
}

export function createCardRenderer(deps: { artifacts: ArtifactStore; render: RenderHtml }): CardRenderer {
  const cards = createPhoneCards(deps);
  const card = (jobId: Id, html: string) => cards.render(jobId, html);
  return {
    card,
    async receipt(jobId, view) {
      const image = await card(jobId, receiptHtml(view));
      return {
        jobId,
        title: view.title,
        lines: view.headline ? [view.headline, ...view.lines] : view.lines,
        tier: view.tier,
        seconds: view.seconds,
        execCostUsd: view.execCostUsd,
        intakeCostUsd: view.intakeCostUsd,
        ...(view.skill ? { skill: view.skill } : {}),
        ...(view.verified ? { verified: view.verified } : {}),
        image,
      };
    },
  };
}

/** A record ID ("NW-REG-48213", "Q-2026-0001"): shown in monospace, nothing else is. */
export const looksLikeRecordId = (s: string): boolean => /^[A-Z0-9][A-Z0-9-]{4,}$/.test(s) && /\d/.test(s);

/** The caption under a receipt image: three short lines, WhatsApp formatting. */
export function receiptCaption(r: Receipt, usedOpenWeights = false): string {
  const first = r.lines[0];
  const facts = [
    `${TIER_LABEL[r.tier]} · ${seconds(r.seconds)}`,
    ...(r.verified ? [`${r.verified.matched}/${r.verified.checked} fields verified`] : []),
    ...(r.skill ? [`${r.skill.name} v${r.skill.version}`] : []),
  ];
  const parts = [
    `*${r.title}*${first ? ` ${looksLikeRecordId(first) ? `\`${first}\`` : first}` : ""}`,
    facts.join(" · "),
    `Cost: execution ${usd(r.execCostUsd)} + intake ${usd(r.intakeCostUsd)}${usedOpenWeights ? ` · ${OPEN_WEIGHTS_CREDIT}` : ""}`,
  ];
  return parts.join("\n");
}

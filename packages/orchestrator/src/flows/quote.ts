// Quote (API path): HubSpot company + deal, quote PDF attached to the deal, and a reply drafted in the
// buyer's language for the rep to forward. Dockhand never messages buyers.

import {
  type ArtifactRef,
  DockhandError,
  type Plan,
  type Quote,
  type QuoteRequest,
  type Understanding,
} from "@dockhand/core";
import { idemKey } from "../repo.ts";
import { formatDate, formatMoney, PRICE_BOOK, quoteFilename, volumeDiscountPct } from "../tools/quotes.ts";
import { receiptCaption } from "../tools/receipts.ts";
import { type FlowEnv, intakeCost, type JobCtx, sendDocument, sendImage, sendText } from "./env.ts";
import type { FlowOutcome } from "./teach.ts";

export function draftReply(q: Quote, r: QuoteRequest, contact: string | null): string {
  const plan = Object.values(PRICE_BOOK).find((p) => q.lines.some((l) => l.sku === p.sku));
  const planName = plan?.name.replace("Tidewater Cloud ", "") ?? "Business";
  const total = formatMoney(q.totalMinor, q.currency, r.language);
  const monthly = formatMoney(Math.round(q.totalMinor / 12), q.currency, r.language);
  const pct = volumeDiscountPct(r.seats);
  const first = contact?.split(/\s+/)[0];
  if (r.language === "pt-BR") {
    return [
      `Olá${first ? `, ${first}` : ""}! Segue a proposta da Tidewater Cloud para ${r.company}: ${r.seats} usuários do plano ${planName}, com início em ${formatDate(r.startDate, r.language)}.`,
      `O contrato de 12 meses fica em ${total} (${monthly} por mês)${pct > 0 ? `, já com ${pct}% de desconto por volume` : ""}.`,
      `A proposta vale até ${formatDate(q.validUntil, r.language)}. Qualquer dúvida, estou à disposição!`,
    ].join(" ");
  }
  return [
    `Hi${first ? ` ${first}` : ""}, here is Tidewater Cloud's quote for ${r.company}: ${r.seats} seats of the ${planName} plan, starting ${formatDate(r.startDate, r.language)}.`,
    `The 12-month total is ${total} (${monthly} per month)${pct > 0 ? `, including a ${pct}% volume discount` : ""}.`,
    `The quote is valid until ${formatDate(q.validUntil, r.language)}. Happy to answer any questions.`,
  ].join(" ");
}

export async function runQuote(
  env: FlowEnv,
  job: JobCtx,
  plan: Plan,
  u: Understanding | null,
): Promise<FlowOutcome> {
  const t0 = performance.now();
  let company: { id: string; created: boolean; url: string } | undefined;
  let deal: { id: string; url: string } | undefined;
  let quote: Quote | undefined;
  let request: QuoteRequest | undefined;
  let pdf: ArtifactRef | undefined;
  let reply: string | undefined;
  let dealName = "";

  for (const [idx, a] of plan.actions.entries()) {
    const key = idemKey(job.id, idx);
    switch (a.kind) {
      case "crm_upsert_company":
        company = await env.crm.upsertCompany(
          {
            name: a.company,
            ...(a.city ? { city: a.city } : {}),
            ...(a.country ? { country: a.country } : {}),
          },
          key,
        );
        break;
      case "crm_create_deal":
        if (!company) throw new DockhandError("TOOL_ERROR", "deal before company");
        dealName = a.name;
        deal = await env.crm.createDeal(
          {
            name: a.name,
            amountMinor: a.amountMinor,
            currency: a.currency,
            closeDate: a.closeDate,
            companyId: company.id,
          },
          key,
        );
        break;
      case "quote_pdf":
        request = a.request;
        quote = env.quotes.price(a.request);
        pdf = await env.quotes.renderPdf(quote, a.request);
        break;
      case "crm_attach_quote":
        if (!deal || !quote || !pdf || !request)
          throw new DockhandError("TOOL_ERROR", "attach before deal and PDF");
        await env.crm.attachFileNote(
          {
            dealId: deal.id,
            body: `Quote ${quote.number}: ${formatMoney(quote.totalMinor, quote.currency, request.language)} for ${request.seats} seats, valid until ${quote.validUntil}. Created by Dockhand.`,
            file: pdf,
            filename: quoteFilename(quote, request),
          },
          key,
        );
        break;
      case "draft_reply":
        if (!quote || !request) throw new DockhandError("TOOL_ERROR", "reply before the quote");
        reply = draftReply(quote, request, u?.contactName ?? null);
        break;
      default:
        throw new DockhandError("TOOL_ERROR", `quote plans cannot run ${a.kind}`);
    }
  }
  if (!quote || !request || !pdf) throw new DockhandError("TOOL_ERROR", "the quote plan made no PDF");

  // The reply goes out alone, so the rep can forward that message as is: a header line would go along with it.
  await sendDocument(
    env,
    job,
    pdf,
    quoteFilename(quote, request),
    `Quote ${quote.number} for ${request.company}.${reply ? " The reply below is ready to forward as is (I never message buyers)." : ""}`,
  );
  if (reply) await sendText(env, job, reply);
  const total = formatMoney(quote.totalMinor, quote.currency, request.language);
  const receipt = await env.cards.receipt(job.id, {
    title: `Quote for ${request.company}`,
    tier: "api",
    headline: quote.number,
    done: "Quote attached to the deal",
    lines: [
      ...(company ? [`HubSpot company ${request.company} ${company.created ? "created" : "found"}`] : []),
      ...(deal ? [`HubSpot deal "${dealName}", ${total}`] : []),
      `Quote PDF ${quote.number} (${request.language}) attached to the deal`,
      ...(reply ? [`Reply drafted in ${request.language === "pt-BR" ? "Portuguese" : "English"}`] : []),
    ],
    seconds: (performance.now() - t0) / 1000,
    execCostUsd: 0,
    intakeCostUsd: intakeCost(env, job.id),
  });
  await sendImage(env, job, receipt.image, receiptCaption(receipt));
  return { ok: true };
}

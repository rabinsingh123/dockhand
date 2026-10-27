// Supplier registration invitation letters from the buyers' procurement teams (flow 3), on fictional
// letterheads drawn from plain shapes, plus their ground truth.

import { TENANTS } from "../../apps/portals/src/index.ts";
import { type InvitationFixture, inviteUrl, profileValue, REP, understanding } from "./data.ts";
import { dmyToIso, esc } from "./html.ts";

interface Letterhead {
  mark: string;
  color: string;
  unit: string;
}

const LETTERHEADS: Record<InvitationFixture["tenant"], Letterhead> = {
  acme: {
    color: "#2456d6",
    unit: "Procurement · Supplier Management",
    mark: `<svg viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="10" fill="#2456d6"/><path d="M10 35 L24 12 L38 35 Z" fill="none" stroke="#fff" stroke-width="4" stroke-linejoin="round"/><path d="M17 27h14" stroke="#b9cbf7" stroke-width="3.5" stroke-linecap="round"/></svg>`,
  },
  globex: {
    color: "#0f7b53",
    unit: "Strategic Sourcing · Cadastro de Fornecedores",
    mark: `<svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="23" fill="#0f7b53"/><ellipse cx="24" cy="24" rx="9" ry="17" fill="none" stroke="#fff" stroke-width="3"/><path d="M8 18h32M8 30h32" stroke="#bfe6d4" stroke-width="3" stroke-linecap="round"/></svg>`,
  },
};

const LETTER_CSS = (color: string) => `
@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
.page{position:relative;display:flex;flex-direction:column;width:210mm;height:297mm;padding:18mm 22mm 12mm;overflow:hidden;color:#1f2328;font-family:Cambria,"Times New Roman",serif;font-size:11.5pt;line-height:1.5}
.lh{display:flex;align-items:center;gap:14px;padding-bottom:10px;border-bottom:2px solid ${color}}
.lh svg{width:48px;height:48px}
.lh .n{font-family:"Segoe UI",Arial,sans-serif;font-size:20pt;font-weight:700;color:${color};line-height:1.05}
.lh .u{font-family:"Segoe UI",Arial,sans-serif;font-size:9pt;letter-spacing:.4px;color:#4b525a}
.lh .addr{margin-left:auto;text-align:right;font-family:"Segoe UI",Arial,sans-serif;font-size:8pt;color:#596069;line-height:1.45}
.meta{display:flex;justify-content:space-between;margin-top:18px;font-size:10.5pt}
.ref{font-family:"Segoe UI",Arial,sans-serif;font-size:9.5pt;color:#2b3137}
.to{margin-top:16px}
.subject{margin-top:16px;font-weight:700}
p{margin:12px 0}
.callout{margin:14px 0;padding:10px 14px;border-left:4px solid ${color};background:#f4f6f8;font-family:"Segoe UI",Arial,sans-serif;font-size:10.5pt}
.callout .url{font-family:"Courier New",monospace;font-size:11pt;font-weight:700;color:${color};word-break:break-all}
ul{margin:6px 0 0;padding-left:22px}
.sig{margin-top:22px}
.sig .script{font-family:"Segoe Script","Segoe Print",cursive;font-size:18pt;color:#1b2f7a;line-height:1.2}
.sig .name{font-weight:700}
.foot{margin-top:auto;border-top:1px solid #d0d5da;padding-top:5px;font-family:"Segoe UI",Arial,sans-serif;font-size:7.5pt;color:#6b7279;display:flex;justify-content:space-between}
`;

function addressBlock(lang: "en" | "pt"): string {
  const attn = lang === "en" ? "Attn.:" : "A/C:";
  return [
    lang === "en" ? profileValue("legalName") : `À ${profileValue("legalName")}`,
    `${attn} ${REP.name}, ${profileValue("primaryContactTitle")}`,
    `${profileValue("street1")}, ${profileValue("street2")}`,
    `${profileValue("city")} – ${profileValue("state")}, ${profileValue("postalCode")}`,
  ]
    .map(esc)
    .join("<br>");
}

function body(inv: InvitationFixture): string {
  const t = TENANTS[inv.tenant];
  const url = inviteUrl(inv);
  const docs = `<ul>${inv.documents.map((d) => `<li>${esc(d)}</li>`).join("")}</ul>`;
  if (inv.language === "en") {
    return `<div class="subject">Subject: Supplier registration – ${esc(t.portalName)}</div>
<p>Dear ${esc(REP.name.split(" ")[0] ?? REP.name)},</p>
<p>Thank you for your proposal for Tidewater Cloud Business subscriptions. Before we can issue a purchase order, ${esc(profileValue("legalName"))} must be registered as an approved ${esc(t.name)} supplier.</p>
<div class="callout">Please register as a supplier in our supplier portal by <b>${esc(inv.deadline)}</b>:<br><span class="url">${esc(url)}</span><br>Invitation code: <b>${esc(t.sampleInviteCode)}</b></div>
<p>Registration takes about 15 minutes. Please have the following documents ready to upload (PDF, up to 10 MB each):</p>${docs}
<p>Registrations completed after the deadline may delay your first purchase order. If you have any questions, reply to <b>${esc(t.contactEmail)}</b> and quote the reference above.</p>
<div class="sig">Kind regards,<div class="script">${esc(inv.signer.name)}</div><div class="name">${esc(inv.signer.name)}</div><div>${esc(inv.signer.title)}</div></div>`;
  }
  return `<div class="subject">Assunto: Cadastro de fornecedor – ${esc(t.portalName)}</div>
<p>Prezada ${esc(REP.name.split(" ")[0] ?? REP.name)},</p>
<p>Para darmos continuidade à contratação da Tidewater Cloud, precisamos que a ${esc(profileValue("legalName"))} seja cadastrada como fornecedora homologada da ${esc(t.name)}.</p>
<div class="callout">Pedimos que realizem o cadastro no nosso portal de fornecedores até <b>${esc(inv.deadline)}</b>:<br><span class="url">${esc(url)}</span><br>Código do convite: <b>${esc(t.sampleInviteCode)}</b></div>
<p>O cadastro leva cerca de 15 minutos. Tenha em mãos os seguintes documentos para envio (PDF, até 10 MB cada):</p>${docs}
<p>Cadastros concluídos após o prazo podem atrasar a emissão do primeiro pedido de compra. Em caso de dúvidas, responda para <b>${esc(t.contactEmail)}</b> informando a referência acima.</p>
<div class="sig">Atenciosamente,<div class="script">${esc(inv.signer.name)}</div><div class="name">${esc(inv.signer.name)}</div><div>${esc(inv.signer.title)}</div></div>`;
}

export function invitationHtml(inv: InvitationFixture): string {
  const t = TENANTS[inv.tenant];
  const lh = LETTERHEADS[inv.tenant];
  const refLabel = inv.language === "en" ? "Our ref.:" : "Ref.:";
  const disclaimer =
    inv.language === "en"
      ? `${t.name} is a fictional company. Synthetic document for software testing.`
      : `${t.name} é uma empresa fictícia. Documento sintético para testes de software.`;
  return `<!doctype html><html lang="${inv.language === "en" ? "en" : "pt-BR"}"><head><meta charset="utf-8"><title>${esc(t.name)} – supplier registration (synthetic)</title>
<style>${LETTER_CSS(lh.color)}</style></head><body><div class="page"><div class="content">
<div class="lh">${lh.mark}<div><div class="n">${esc(t.name)}</div><div class="u">${esc(lh.unit)}</div></div>
<div class="addr">${esc(inv.letterheadLine)}<br>${esc(t.contactEmail)}</div></div>
<div class="meta"><span>${esc(inv.dateLine)}</span><span class="ref">${refLabel} <b>${esc(inv.reference)}</b></span></div>
<div class="to">${addressBlock(inv.language)}</div>
${body(inv)}
</div>
<div class="foot"><span>${esc(disclaimer)}</span><span>${esc(inv.reference)}</span></div>
</div></body></html>`;
}

export function invitationExpected(inv: InvitationFixture) {
  const t = TENANTS[inv.tenant];
  const deadlineIso = dmyToIso(inv.deadline);
  const url = inviteUrl(inv);
  return {
    fixture: `fixtures/inbound/${inv.tenant}-supplier-invitation.pdf`,
    synthetic: true,
    kind: "supplier_registration_invitation",
    language: inv.language,
    buyer: t.name,
    tenant: t.slug,
    inviteCode: t.sampleInviteCode,
    portalUrl: url,
    deadline: deadlineIso,
    deadlineAsWritten: inv.deadline,
    reference: inv.reference,
    documentsRequested: inv.documents,
    documentsRequestedCanonical: ["w9File", "coiFile"],
    sender: { name: inv.signer.name, title: inv.signer.title, email: t.contactEmail, team: t.requester },
    addressedTo: { company: profileValue("legalName"), person: REP.name },
    understanding: understanding({
      intent: "supplier_onboarding",
      language: inv.language,
      company: t.name,
      contactName: inv.signer.name,
      contactEmail: t.contactEmail,
      notes: `Deadline ${inv.deadline}. Documents: ${inv.documents.join(", ")}. Ref. ${inv.reference}.`,
      portalUrl: url,
      tenant: t.slug,
      inviteCode: t.sampleInviteCode,
      buyerName: t.name,
      // Written for the rep (locale pt-BR) whatever the letter's language.
      summaryForRep: `A ${t.name} pede o cadastro da Tidewater Cloud como fornecedora no portal (${t.sampleInviteCode}) até ${inv.deadline}. Precisa do W-9 e do certificado de seguro.`,
    }),
    gradedUnderstandingFields: ["intent", "language", "portalUrl", "tenant", "inviteCode", "buyerName"],
    freeTextFields: ["understanding.summaryForRep", "understanding.notes"],
  };
}

// Scripts for the code-switched (Portuguese/English) voice notes the rep or the partner records on a
// phone, with the Understanding each one should produce. The recordings themselves are made by a person
// (consenting speakers only) and saved next to scripts.md as <id>.ogg.

import type { Understanding } from "../../packages/core/src/contracts/orchestrator.ts";
import { REFERRALS, REP, understanding } from "./data.ts";
import { dmyToIso } from "./html.ts";

export interface VoiceScript {
  id: string;
  title: string;
  speaker: string;
  forwardedBy: string;
  /** What the speaker says, exactly. */
  script: string;
  /** How to say the tricky bits, and how the transcript should write them. */
  sayAs: { spoken: string; written: string }[];
  expected: Understanding;
  /** Present when the note leaves out something the job needs. */
  followUp?: { askFor: string; questionPt: string; answer: string; resolves: Partial<Understanding> };
}

const aurora = REFERRALS.find((r) => r.slug === "cafe-aurora");
const vilaNova = REFERRALS.find((r) => r.slug === "vila-nova");
if (!aurora || !vilaNova) throw new Error("referral fixtures missing");

export const VOICE_SCRIPTS: readonly VoiceScript[] = [
  {
    id: "vn1-register-cafe-aurora",
    title: "Partner asks the rep to register Café Aurora",
    speaker: `${aurora.partnerContact} (${aurora.partnerCompany}, referral partner)`,
    forwardedBy: `${REP.name} (rep)`,
    script:
      "Oi Ana, é o Marcos, da Rota Consultoria. Registra aí pra mim um deal novo: Café Aurora, vinte e cinco seats do Business, em São Paulo. Fecha em janeiro, dia vinte e nove. The contact is Júlia Prado, julia at cafeaurora dot example. Valeu!",
    sayAs: [
      { spoken: "julia at cafeaurora dot example", written: aurora.contactEmail },
      { spoken: "vinte e cinco seats do Business", written: `25 seats, ${aurora.product}` },
      { spoken: "janeiro, dia vinte e nove", written: dmyToIso(aurora.expectedCloseDate) },
    ],
    expected: understanding({
      intent: "register_deal",
      language: "pt",
      company: "Café Aurora",
      city: aurora.city,
      country: "Brazil",
      seats: aurora.seats,
      contactName: aurora.contactName,
      contactEmail: aurora.contactEmail,
      product: aurora.product,
      closeDate: dmyToIso(aurora.expectedCloseDate),
      referralPartner: aurora.partnerCompany,
      summaryForRep:
        "Registrar a Café Aurora (São Paulo) na Caravela: 25 seats do Tidewater Cloud Business, fechamento em 29/01/2027, contato Júlia Prado. Indicação da Rota Consultoria.",
    }),
  },
  {
    id: "vn2-quote-cafe-aurora",
    title: "Buyer asks for pricing (quote, API path)",
    speaker: `${aurora.contactName} (Café Aurora, buyer)`,
    forwardedBy: `${REP.name} (rep)`,
    script:
      "Oi Ana, aqui é a Júlia, do Café Aurora. Can you send pricing for 25 people em São Paulo, começando em janeiro? A gente tá pensando no plano Business. Obrigada!",
    sayAs: [
      { spoken: "twenty-five people", written: "25 seats" },
      {
        spoken: "começando em janeiro",
        written: "startDate 2027-01-01 (month only: first day of the next January)",
      },
    ],
    expected: understanding({
      intent: "quote",
      language: "pt",
      company: "Café Aurora",
      city: aurora.city,
      country: "Brazil",
      seats: 25,
      startDate: "2027-01-01",
      contactName: "Júlia",
      product: aurora.product,
      summaryForRep:
        "Cotação para a Café Aurora: 25 usuários do Tidewater Cloud Business em São Paulo, início em janeiro de 2027.",
    }),
  },
  {
    id: "vn3-register-vila-nova-missing-seats",
    title: "Partner registration with the seat count missing (triggers a follow-up question)",
    speaker: `${vilaNova.partnerContact} (${vilaNova.partnerCompany}, referral partner)`,
    forwardedBy: `${REP.name} (rep)`,
    script:
      "Ana, mais uma do Marcos, da Rota Consultoria. Registra a Vila Nova Logística, lá em Curitiba, plano Business. O fechamento é dia vinte e seis de fevereiro. The contact person é a Helena Kowalski, helena at vilanovalog dot example. Depois te mando o form assinado.",
    sayAs: [
      { spoken: "helena at vilanovalog dot example", written: vilaNova.contactEmail },
      { spoken: "Kowalski (say it naturally, ko-VAL-ski)", written: "Kowalski" },
      { spoken: "dia vinte e seis de fevereiro", written: dmyToIso(vilaNova.expectedCloseDate) },
    ],
    expected: understanding({
      intent: "register_deal",
      language: "pt",
      company: "Vila Nova Logística",
      city: vilaNova.city,
      country: "Brazil",
      contactName: vilaNova.contactName,
      contactEmail: vilaNova.contactEmail,
      product: vilaNova.product,
      closeDate: dmyToIso(vilaNova.expectedCloseDate),
      referralPartner: vilaNova.partnerCompany,
      missing: ["seats"],
      summaryForRep:
        "Registrar a Vila Nova Logística (Curitiba) na Caravela: Tidewater Cloud Business, fechamento em 26/02/2027, contato Helena Kowalski. Falta o número de seats.",
    }),
    followUp: {
      askFor: "seats",
      questionPt: "Quantos seats a Vila Nova Logística vai contratar?",
      answer: "Quarenta.",
      resolves: { seats: vilaNova.seats, missing: [] },
    },
  },
];

const UNGRADED = ["summaryForRep"];

export function voiceExpectedJson() {
  return {
    synthetic: true,
    note: "Expected Understanding per voice note. Dates resolve against 2026-10-27 in America/Sao_Paulo; summaryForRep is free text and not graded. Country is inferred from the city.",
    ungradedFields: UNGRADED,
    scripts: VOICE_SCRIPTS.map((s) => ({
      id: s.id,
      audio: `fixtures/voice/${s.id}.ogg`,
      speaker: s.speaker,
      script: s.script,
      expected: s.expected,
      ...(s.followUp ? { followUp: s.followUp } : {}),
    })),
  };
}

export function voiceScriptsMarkdown(): string {
  const parts: string[] = [
    "# Voice note scripts",
    "",
    "Three short code-switched (Portuguese/English) voice notes for the demo and the intake tests. Everything in them is fictional and matches the referral photos in `fixtures/inbound/`.",
    "",
    "How to record:",
    "",
    "- Record each one as a WhatsApp voice note on a phone (OGG/Opus), at a normal pace, in a quiet room. Speakers must be people who agreed to be recorded.",
    `- Save the files as \`fixtures/voice/<id>.ogg\`. The rep forwards them to Dockhand from ${REP.name}'s number.`,
    '- Read the script as written. The "say as" lines show how to pronounce emails and numbers.',
    "",
    `Expected values assume "today" is 2026-10-27 in ${REP.tz}. A month without a day ("começando em janeiro") resolves to the first day of the next such month. \`summaryForRep\` is free text and is not graded. The same data is in \`expected.json\`.`,
    "",
  ];
  VOICE_SCRIPTS.forEach((s, i) => {
    parts.push(`## ${i + 1}. ${s.title}`, "");
    parts.push(`- id: \`${s.id}\` (save as \`fixtures/voice/${s.id}.ogg\`)`);
    parts.push(`- Speaker: ${s.speaker}. Forwarded by ${s.forwardedBy}.`, "");
    parts.push(`> ${s.script}`, "");
    parts.push("Say as:", "");
    for (const x of s.sayAs) parts.push(`- "${x.spoken}" → ${x.written}`);
    parts.push(
      "",
      "Expected `Understanding`:",
      "",
      "```json",
      JSON.stringify(s.expected, null, 2),
      "```",
      "",
    );
    if (s.followUp) {
      parts.push(
        `Follow-up: \`missing\` is \`["${s.followUp.askFor}"]\`, so Dockhand asks one question before planning, for example "${s.followUp.questionPt}". The rep answers "${s.followUp.answer}", which sets \`seats\` to ${String(s.followUp.resolves.seats)} and clears \`missing\`.`,
        "",
      );
    }
  });
  return `${parts.join("\n").trimEnd()}\n`;
}

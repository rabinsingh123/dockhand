// Partner referral form: a printed A4 form (Tidewater Cloud's partner program) filled in by hand,
// then "photographed" on a desk. Two HTML pages: the paper itself, and a scene that places the
// rendered paper in perspective with a shadow, warm light, lens softness and sensor noise.

import { type ReferralFixture, understanding } from "./data.ts";
import { brl, createRng, dmyToIso, esc, handMark, handwriting, type Rng, signatureSvg } from "./html.ts";

/** A4 at 96 CSS px per inch. */
export const PAPER = { width: 794, height: 1123 } as const;
/** Phone photo, portrait 3:4, 1600 px wide. */
export const PHOTO = { width: 1600, height: 2133 } as const;

const PRODUCTS = [
  "Tidewater Cloud Starter",
  "Tidewater Cloud Business",
  "Tidewater Cloud Enterprise",
] as const;

const TIDEWATER_MARK = `<svg class="mark" viewBox="0 0 40 40" aria-hidden="true">
<rect width="40" height="40" rx="9" fill="#0f6a7a"/>
<path d="M6 17c4.5-4 9-4 13.5 0s9 4 14.5 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
<path d="M6 26c4.5-4 9-4 13.5 0s9 4 14.5 0" fill="none" stroke="#9fe0e6" stroke-width="3" stroke-linecap="round"/>
</svg>`;

// Paper fibres and print grain (SVG turbulence is deterministic for a fixed seed).
const FIBRES = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'><filter id='f'><feTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='3' seed='11' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.45  0 0 0 0 0.42  0 0 0 0 0.36  0 0 0 0.55 0'/></filter><rect width='100%' height='100%' filter='url(%23f)'/></svg>`,
)}")`;

function paperCss(r: ReferralFixture): string {
  return `
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
.paper{position:relative;display:flex;flex-direction:column;width:${PAPER.width}px;height:${PAPER.height}px;padding:40px 50px 26px;background:#fbfaf4;color:#2a2e33;font-family:"Segoe UI",Arial,sans-serif;overflow:hidden}
.paper::before{content:"";position:absolute;inset:0;background-image:${FIBRES};opacity:.22;mix-blend-mode:multiply;pointer-events:none;z-index:3}
.paper::after{content:"";position:absolute;left:0;right:0;top:36.5%;height:22px;background:linear-gradient(to bottom,rgba(0,0,0,0),rgba(70,60,40,.05) 46%,rgba(255,255,255,.55) 54%,rgba(0,0,0,0));pointer-events:none;z-index:3}
.head{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:2.5px solid #0f6a7a}
.brand{display:flex;gap:12px;align-items:center}
.mark{width:44px;height:44px}
.brand-name{font-size:23px;font-weight:700;letter-spacing:-.2px;color:#173a42}
.brand-sub{font-size:10.5px;font-weight:600;letter-spacing:2.4px;text-transform:uppercase;color:#0f6a7a}
.doc-title{text-align:right}
.t1{font-size:19px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#173a42}
.t2{font-size:12.5px;font-style:italic;color:#4b5258;margin-top:2px}
.t3{font-size:9.5px;color:#6b7279;margin-top:5px;letter-spacing:.3px}
.intro{font-size:10.5px;line-height:1.5;color:#3d4349;margin:10px 0 0}
.intro em{color:#5f666d}
h2{display:flex;align-items:center;gap:8px;margin:18px 0 0;font-size:12.5px;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#173a42}
h2 em{font-style:italic;text-transform:none;letter-spacing:0;font-weight:500;color:#5f666d}
.num{display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:50%;background:#0f6a7a;color:#fff;font-size:11px;letter-spacing:0}
.grid{display:grid;grid-template-columns:repeat(12,1fr);column-gap:18px;row-gap:3px}
.f{min-width:0}
.s3{grid-column:span 3}.s4{grid-column:span 4}.s5{grid-column:span 5}.s6{grid-column:span 6}.s7{grid-column:span 7}.s12{grid-column:span 12}
label{display:block;font-size:9.5px;font-weight:700;color:#3b4146;margin-top:7px;white-space:nowrap}
label em{font-weight:400;font-style:italic;color:#6b7279}
.line{position:relative;height:40px;border-bottom:1.2px solid #8e959c;display:flex;align-items:flex-end;padding:0 4px 2px;white-space:nowrap}
.prefix{font-size:13px;font-weight:600;color:#3b4146;margin-right:6px;padding-bottom:5px}
.hw{display:inline-block;font-family:${r.look.font},"Segoe Print","Ink Free",cursive;font-size:23px;line-height:1;color:${r.look.ink};transform-origin:left bottom;text-shadow:0 0 .6px ${r.look.ink}}
.hw-g{display:inline-block}
.hw-sp{display:inline-block;width:.32em}
.choices{display:flex;gap:26px;margin-top:9px}
.choice{display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;color:#2a2e33}
.box{position:relative;width:17px;height:17px;border:1.4px solid #4a5056;border-radius:2px;flex:none}
.hand-mark{position:absolute;width:25px;height:25px;left:-4px;top:-6px}
.consent{display:flex;gap:10px;align-items:flex-start;margin-top:18px;padding:8px 12px;border:1px solid #c9ced2;border-radius:4px;background:rgba(15,106,122,.04)}
.consent p{margin:0;font-size:10.5px;line-height:1.45;color:#2f3439}
.consent p em{color:#5f666d}
.sigline{height:60px}
.signature{position:absolute;left:10px;bottom:-6px}
.office{margin-top:18px;border:1px dashed #9aa1a7;border-radius:4px;padding:6px 12px 8px;display:grid;grid-template-columns:repeat(3,1fr);column-gap:18px;row-gap:2px}
.office .cap{grid-column:1/-1;font-size:9px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#6b7279}
.office .slot{font-size:9.5px;color:#6b7279;border-bottom:1px solid #b9bfc4;height:20px;display:flex;align-items:flex-end;padding-bottom:2px}
.foot{margin-top:auto;display:flex;justify-content:space-between;font-size:8.5px;color:#7a8187;border-top:1px solid #d3d7da;padding-top:6px}
`;
}

function field(span: string, en: string, pt: string, value: string, rng: Rng, prefix = ""): string {
  const pre = prefix ? `<span class="prefix">${esc(prefix)}</span>` : "";
  return `<div class="f ${span}"><label>${esc(en)} <em>/ ${esc(pt)}</em></label><div class="line">${pre}${handwriting(value, rng)}</div></div>`;
}

export function referralFormHtml(r: ReferralFixture): string {
  const rng = createRng(r.look.seed);
  const ink = r.look.ink;
  const productChoices = PRODUCTS.map((p) => {
    const mark = p === r.product ? handMark("x", rng, ink) : "";
    return `<span class="choice"><span class="box">${mark}</span>${esc(p)}</span>`;
  }).join("");

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Partner referral form</title>
<style>${paperCss(r)}</style></head><body>
<div class="paper">
  <header class="head">
    <div class="brand">${TIDEWATER_MARK}<div><div class="brand-name">Tidewater Cloud</div><div class="brand-sub">Partner Program</div></div></div>
    <div class="doc-title"><div class="t1">Partner referral form</div><div class="t2">Formulário de indicação de parceiro</div><div class="t3">Form PR-01 · rev. 03/2026</div></div>
  </header>
  <p class="intro">Refer a new opportunity to Tidewater Cloud. Write clearly, tick one product and give the signed form to your account executive.<br>
  <em>Indique uma nova oportunidade. Escreva com letra legível, marque um produto e entregue o formulário assinado ao seu executivo de contas.</em></p>

  <h2><span class="num">1</span>Referral partner <em>/ Parceiro indicador</em></h2>
  <div class="grid">
    ${field("s7", "Partner company", "Empresa parceira", r.partnerCompany, rng)}
    ${field("s5", "Partner contact", "Contato do parceiro", r.partnerContact, rng)}
  </div>

  <h2><span class="num">2</span>End customer <em>/ Cliente final</em></h2>
  <div class="grid">
    ${field("s12", "Company (legal name)", "Razão social", r.companyName, rng)}
    ${field("s6", "Website", "Site", r.companyWebsite, rng)}
    ${field("s3", "City", "Cidade", r.city, rng)}
    ${field("s3", "Country", "País", r.country, rng)}
  </div>

  <h2><span class="num">3</span>Customer contact <em>/ Contato no cliente</em></h2>
  <div class="grid">
    ${field("s5", "Full name", "Nome completo", r.contactName, rng)}
    ${field("s7", "Email", "E-mail", r.contactEmail, rng)}
    ${field("s5", "Phone", "Telefone", r.contactPhone, rng)}
  </div>

  <h2><span class="num">4</span>Opportunity <em>/ Oportunidade</em></h2>
  <label>Product <em>/ Produto (tick one / marque um)</em></label>
  <div class="choices">${productChoices}</div>
  <div class="grid">
    ${field("s3", "Seats", "Licenças", String(r.seats), rng)}
    ${field("s5", "Estimated value", "Valor estimado", brl(r.estimatedValueBrl), rng, "R$")}
    ${field("s4", "Expected close", "Fechamento (DD/MM/AAAA)", r.expectedCloseDate, rng)}
  </div>

  <h2><span class="num">5</span>Notes <em>/ Observações</em></h2>
  <div class="grid">
    <div class="f s12"><div class="line">${handwriting(r.notes, rng)}</div></div>
    <div class="f s12"><div class="line"></div></div>
  </div>

  <div class="consent"><span class="box">${handMark("tick", rng, ink)}</span>
    <p><strong>The end customer agreed to be contacted by Tidewater Cloud and its distributors.</strong><br>
    <em>O cliente final autorizou o contato da Tidewater Cloud e de seus distribuidores.</em></p></div>

  <div class="grid" style="margin-top:4px">
    <div class="f s5"><label>Signature <em>/ Assinatura</em></label><div class="line sigline">${signatureSvg(rng, ink, 230)}</div></div>
    <div class="f s4"><label>Name <em>/ Nome</em></label><div class="line sigline">${handwriting(r.partnerContact, rng)}</div></div>
    <div class="f s3"><label>Date <em>/ Data</em></label><div class="line sigline">${handwriting(r.signedOn, rng)}</div></div>
  </div>

  <div class="office"><div class="cap">For Tidewater use only / Uso interno</div>
    <div class="slot">Received by</div><div class="slot">Date</div><div class="slot">Deal registration</div></div>

  <div class="foot"><span>Tidewater Cloud Partner Program · parceiros@tidewater.example.com</span><span>Sample form for software testing. Companies and people are fictional.</span></div>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Photo scene

interface SceneLook {
  table: string;
  turbulence: { baseFrequency: string; seed: number; matrix: string };
  transform: string;
  /** Tilting the top away makes the bottom edge project lower; shift up to keep the margins even. */
  shiftY: number;
  shadow: string;
  light: string;
  tint: string;
  handShadow: string;
}

const SCENES: Record<ReferralFixture["look"]["scene"], SceneLook> = {
  "warm-lamp": {
    table: "#5b3c24",
    turbulence: {
      baseFrequency: "0.0035 0.085",
      seed: 7,
      matrix: "0 0 0 0 0.42  0 0 0 0 0.26  0 0 0 0 0.14  0 0 0 0.9 0",
    },
    transform: "perspective(2600px) rotateX(8deg) rotateY(-4deg) rotateZ(-2.3deg)",
    shiftY: -48,
    shadow: "drop-shadow(0 26px 30px rgba(20,8,0,.55)) drop-shadow(0 4px 6px rgba(20,8,0,.35))",
    light:
      "radial-gradient(ellipse 85% 70% at 22% 14%, rgba(255,222,165,.55), rgba(255,196,120,.18) 45%, rgba(0,0,0,0) 72%)",
    tint: "linear-gradient(150deg, rgba(255,170,80,.10), rgba(120,60,10,.30))",
    handShadow: "radial-gradient(ellipse 34% 26% at 92% 97%, rgba(10,5,0,.42), rgba(10,5,0,0) 100%)",
  },
  daylight: {
    table: "#9d978d",
    turbulence: {
      baseFrequency: "0.012 0.012",
      seed: 3,
      matrix: "0 0 0 0 0.62  0 0 0 0 0.6  0 0 0 0 0.56  0 0 0 0.55 0",
    },
    transform: "perspective(2400px) rotateX(6deg) rotateY(3.5deg) rotateZ(1.6deg)",
    shiftY: -38,
    shadow: "drop-shadow(0 20px 26px rgba(0,0,0,.38)) drop-shadow(0 3px 5px rgba(0,0,0,.25))",
    light:
      "radial-gradient(ellipse 90% 80% at 82% 18%, rgba(255,250,236,.45), rgba(255,244,220,.12) 50%, rgba(0,0,0,0) 78%)",
    tint: "linear-gradient(200deg, rgba(210,225,255,.06), rgba(70,55,35,.26))",
    handShadow: "radial-gradient(ellipse 40% 22% at 6% 100%, rgba(0,0,0,.32), rgba(0,0,0,0) 100%)",
  },
};

const SENSOR_NOISE = `url("data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='400'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='1.1' numOctaves='2' seed='5' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>`,
)}")`;

export function photoSceneHtml(paperDataUrl: string, scene: ReferralFixture["look"]["scene"]): string {
  const s = SCENES[scene];
  const paperW = 1300;
  const paperH = Math.round((paperW * PAPER.height) / PAPER.width);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}
html,body{margin:0;width:${PHOTO.width}px;height:${PHOTO.height}px;overflow:hidden;background:${s.table}}
.table{position:absolute;inset:0}
.stage{position:absolute;left:50%;top:50%;width:${paperW}px;height:${paperH}px;margin:${Math.round(-paperH / 2 + s.shiftY)}px 0 0 ${-paperW / 2}px;filter:${s.shadow}}
.sheet{position:absolute;inset:0;transform:${s.transform};transform-origin:50% 55%}
.sheet img{position:absolute;inset:0;width:100%;height:100%;filter:blur(.45px) contrast(.96)}
.sheet img.far{filter:blur(1.6px);-webkit-mask-image:linear-gradient(to bottom,#000 0%,rgba(0,0,0,.6) 12%,transparent 32%);mask-image:linear-gradient(to bottom,#000 0%,rgba(0,0,0,.6) 12%,transparent 32%)}
.fx{position:absolute;inset:0;pointer-events:none}
.light{background:${s.light};mix-blend-mode:soft-light}
.light2{background:${s.light};mix-blend-mode:screen;opacity:.35}
.tint{background:${s.tint};mix-blend-mode:multiply}
.hand{background:${s.handShadow}}
.vignette{background:radial-gradient(ellipse 75% 70% at 50% 48%, rgba(0,0,0,0) 60%, rgba(0,0,0,.42) 100%)}
.noise{background-image:${SENSOR_NOISE};opacity:.075;mix-blend-mode:overlay}
</style></head><body>
<svg class="table" width="${PHOTO.width}" height="${PHOTO.height}" aria-hidden="true"><filter id="wood"><feTurbulence type="fractalNoise" baseFrequency="${s.turbulence.baseFrequency}" numOctaves="4" seed="${s.turbulence.seed}"/><feColorMatrix values="${s.turbulence.matrix}"/></filter><rect width="100%" height="100%" fill="${s.table}"/><rect width="100%" height="100%" filter="url(#wood)" opacity=".85"/></svg>
<div class="stage"><div class="sheet"><img src="${paperDataUrl}" alt=""><img class="far" src="${paperDataUrl}" alt=""></div></div>
<div class="fx light"></div><div class="fx light2"></div><div class="fx tint"></div><div class="fx hand"></div><div class="fx vignette"></div><div class="fx noise"></div>
</body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Ground truth

export function referralExpected(r: ReferralFixture) {
  const closeIso = dmyToIso(r.expectedCloseDate);
  const countryOption = r.country === "Brasil" ? "Brazil" : r.country;
  return {
    fixture: `fixtures/inbound/referral-${r.slug}.jpg`,
    synthetic: true,
    kind: "partner_referral_form",
    description: `Phone photo of a signed Tidewater Cloud partner referral form, filled in by hand by ${r.partnerCompany}.`,
    asWritten: {
      referralPartner: r.partnerCompany,
      partnerContact: r.partnerContact,
      companyName: r.companyName,
      companyWebsite: r.companyWebsite,
      city: r.city,
      country: r.country,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      product: r.product,
      seats: String(r.seats),
      estimatedValue: `R$ ${brl(r.estimatedValueBrl)}`,
      expectedCloseDate: r.expectedCloseDate,
      notes: r.notes,
      consent: "ticked",
      signedBy: r.partnerContact,
      signedOn: r.signedOn,
      signature: "present",
    },
    estimatedValue: { amount: r.estimatedValueBrl, currency: "BRL" },
    // What a correct registration on the Caravela partner portal submits, in the portal's
    // ground-truth format (canonical keys, ISO dates, numbers). estimatedValue is left out: the form
    // states BRL and the portal field is USD, so any value there depends on an exchange-rate policy.
    partnerPortalSubmission: {
      companyName: r.companyName,
      companyWebsite: r.companyWebsite,
      country: countryOption,
      city: r.city,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      product: r.product,
      seats: r.seats,
      expectedCloseDate: closeIso,
      referralPartner: r.partnerCompany,
      notes: r.notes,
      consent: true,
    },
    understanding: understanding({
      intent: "register_deal",
      language: "pt",
      company: r.companyName,
      city: r.city,
      country: countryOption,
      seats: r.seats,
      contactName: r.contactName,
      contactEmail: r.contactEmail,
      contactPhone: r.contactPhone,
      product: r.product,
      estValue: r.estimatedValueBrl,
      closeDate: closeIso,
      website: r.companyWebsite,
      referralPartner: r.partnerCompany,
      notes: r.notes,
      summaryForRep: `Registrar ${r.companyName} (${r.city}) na Caravela: ${r.seats} seats do ${r.product}, fechamento em ${r.expectedCloseDate}, contato ${r.contactName}. Indicação da ${r.partnerCompany}.`,
    }),
    freeTextFields: ["understanding.summaryForRep", "understanding.notes"],
  };
}

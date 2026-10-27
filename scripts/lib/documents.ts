// Supplier documents Tidewater Cloud uploads during onboarding: a W-9-style form and a certificate of
// insurance. Both are original layouts (not the IRS form, not ACORD 25), carry a fake TIN and fake
// policy numbers, and a large SAMPLE watermark.

import { COI_DETAILS, profileValue, W9_DETAILS } from "./data.ts";
import { esc, WATERMARK_CSS, watermark } from "./html.ts";

const PAGE_CSS = `
@page{size:Letter;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff}
.page{position:relative;display:flex;flex-direction:column;width:8.5in;height:11in;padding:.5in .55in .35in;overflow:hidden;color:#16191c;font-family:"Segoe UI",Arial,sans-serif;font-size:9.5pt}
.typed{font-family:"Courier New",Courier,monospace;font-size:11pt;font-weight:700;color:#0d1a40}
.sig{font-family:"Segoe Script","Segoe Print",cursive;font-size:17pt;color:#1b2f7a}
.foot{margin-top:auto;display:flex;justify-content:space-between;gap:20px;font-size:7.5pt;color:#596069;border-top:1px solid #c5cad0;padding-top:5px}
${WATERMARK_CSS}
`;

function address(): string[] {
  return [
    `${profileValue("street1")}, ${profileValue("street2")}`,
    `${profileValue("city")}, ${profileValue("state")} ${profileValue("postalCode")}, ${profileValue("country")}`,
  ];
}

// ---------------------------------------------------------------------------------------------
// W-9-style request for taxpayer identification

const W9_CSS = `
.top{display:grid;grid-template-columns:1.7in 1fr 1.75in;border:2px solid #16191c}
.top>div{padding:7px 10px}
.top .formname{border-right:1px solid #16191c}
.formname .big{font-size:20pt;font-weight:800;letter-spacing:-.5px;line-height:1;white-space:nowrap}
.formname .small{font-size:7.5pt;color:#3c434a;margin-top:4px;line-height:1.3}
.top .title{display:flex;flex-direction:column;justify-content:center;text-align:center;border-right:1px solid #16191c}
.title .main{font-size:14pt;font-weight:800;line-height:1.2}
.title .sub{font-size:8pt;font-style:italic;color:#3c434a;margin-top:4px}
.top .give{font-size:8.5pt;font-weight:700;display:flex;align-items:center;line-height:1.35}
.rows{border:2px solid #16191c;border-top:0}
.row{display:grid;border-top:1px solid #16191c}
.row:first-child{border-top:0}
.cell{padding:4px 8px 6px;min-height:.46in;border-left:1px solid #16191c}
.cell:first-child{border-left:0}
.lbl{font-size:7.5pt;color:#2b3137}
.lbl b{display:inline-block;min-width:16px}
.val{margin-top:4px}
.classes{display:flex;flex-wrap:wrap;gap:4px 16px;margin-top:5px;font-size:8.5pt}
.cb{display:inline-flex;align-items:center;gap:5px}
.cb i{display:inline-flex;align-items:center;justify-content:center;width:11px;height:11px;border:1px solid #16191c;font-style:normal;font-size:10pt;font-weight:800;line-height:1;color:#0d1a40}
.part{display:flex;align-items:stretch;margin-top:12px;border-top:2px solid #16191c;border-bottom:1px solid #16191c}
.part .tag{background:#16191c;color:#fff;font-weight:800;padding:3px 10px;font-size:10pt}
.part .name{font-weight:800;padding:3px 10px;font-size:10pt}
.tin{display:grid;grid-template-columns:1fr 3.2in;gap:16px;padding:8px 0}
.tin p{margin:0 0 6px;font-size:8.5pt;line-height:1.4;color:#2b3137}
.tinbox .lbl{font-weight:700;margin-bottom:3px}
.digits{display:flex;align-items:center;gap:3px;margin-bottom:8px}
.digits span{display:inline-flex;align-items:center;justify-content:center;width:.24in;height:.28in;border:1px solid #16191c;font-family:"Courier New",monospace;font-weight:700;font-size:12pt;color:#0d1a40}
.digits em{font-style:normal;font-weight:700;padding:0 2px}
.or{font-weight:800;font-size:9pt;margin:2px 0 6px}
.cert{padding:8px 0 4px;font-size:8.5pt;line-height:1.45;color:#2b3137}
.cert ol{margin:4px 0 0;padding-left:18px}
.sign{display:grid;grid-template-columns:.9in 1fr 2.1in;border:2px solid #16191c;margin-top:10px;align-items:stretch}
.sign>div{padding:6px 10px}
.sign .here{background:#16191c;color:#fff;font-weight:800;font-size:12pt;line-height:1.1;display:flex;align-items:center}
.sign .lbl{display:block;margin-bottom:2px}
.note{margin-top:10px;font-size:8pt;color:#3c434a;line-height:1.45;border-left:3px solid #c5cad0;padding-left:10px}
.instr{display:grid;grid-template-columns:1fr 1fr;gap:5px 22px;margin:12px 0 10px;padding-top:7px;border-top:1px solid #16191c;font-size:8pt;line-height:1.4;color:#2b3137}
.instr h4{grid-column:1/-1;margin:0;font-size:9.5pt}
.instr p{margin:0}
`;

function digits(groups: string[]): string {
  return groups.map((g) => [...g].map((d) => `<span>${esc(d.trim())}</span>`).join("")).join("<em>–</em>");
}

export function w9Html(): string {
  const [addr1, addr2] = address();
  const ein = profileValue("taxId");
  const [einA, einB] = ein.split("-") as [string, string];
  const classes = [
    ["Individual / sole proprietor", false],
    ["C corporation", false],
    ["S corporation", false],
    ["Partnership", false],
    ["Trust / estate", false],
  ] as const;
  const box = (on: boolean) => `<i>${on ? "X" : ""}</i>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>W-9 sample (synthetic) – Tidewater Cloud</title>
<style>${PAGE_CSS}${W9_CSS}</style></head><body><div class="page"><div class="content">
<div class="top">
  <div class="formname"><div class="big">Form W-9</div><div class="small">Sample layout · rev. 2026<br>Synthetic test copy</div></div>
  <div class="title"><div class="main">Request for Taxpayer Identification Number and Certification</div><div class="sub">Sample drawn for software testing. Not an official IRS form.</div></div>
  <div class="give">Give this form to the requester. Do not send it to the IRS.</div>
</div>
<div class="rows">
  <div class="row" style="grid-template-columns:1fr"><div class="cell"><div class="lbl"><b>1</b> Name of entity or individual (as shown on the income tax return)</div><div class="val typed">${esc(profileValue("legalName"))}</div></div></div>
  <div class="row" style="grid-template-columns:1fr"><div class="cell"><div class="lbl"><b>2</b> Business name / disregarded entity name, if different from above</div><div class="val typed">${esc(profileValue("tradeName"))}</div></div></div>
  <div class="row" style="grid-template-columns:1fr 2.1in"><div class="cell"><div class="lbl"><b>3</b> Federal tax classification of the person whose name is on line 1 (check only one)</div>
    <div class="classes">${classes.map(([name, on]) => `<span class="cb">${box(on)}${esc(name)}</span>`).join("")}
    <span class="cb">${box(true)}Limited liability company. Tax classification (C, S or P): <span class="typed">${esc(W9_DETAILS.llcTaxClassification)}</span></span>
    <span class="cb">${box(false)}Other (see instructions)</span></div></div>
    <div class="cell"><div class="lbl"><b>4</b> Exemptions (codes apply only to certain entities)</div><div class="lbl" style="margin-top:6px">Exempt payee code (if any): <span class="typed">—</span></div><div class="lbl" style="margin-top:4px">FATCA exemption code (if any): <span class="typed">—</span></div></div></div>
  <div class="row" style="grid-template-columns:1fr 2.1in"><div class="cell"><div class="lbl"><b>5</b> Address (number, street, and apt. or suite no.)</div><div class="val typed">${esc(addr1 ?? "")}</div></div>
    <div class="cell" style="grid-row:span 2"><div class="lbl">Requester's name and address (optional)</div></div></div>
  <div class="row" style="grid-template-columns:1fr 2.1in"><div class="cell"><div class="lbl"><b>6</b> City, state, and postal code</div><div class="val typed">${esc(addr2 ?? "")}</div></div></div>
  <div class="row" style="grid-template-columns:1fr"><div class="cell" style="min-height:.42in"><div class="lbl"><b>7</b> Account number(s) (optional)</div></div></div>
</div>

<div class="part"><span class="tag">Part I</span><span class="name">Taxpayer Identification Number (TIN)</span></div>
<div class="tin">
  <div><p>Enter your TIN in the matching box. The TIN must match the name on line 1. Individuals usually enter a social security number; entities enter their employer identification number (EIN).</p>
  <p>If the account is in more than one name, see the instructions for line 1.</p></div>
  <div class="tinbox">
    <div class="lbl">Social security number</div>
    <div class="digits">${digits(["   ", "  ", "    "])}</div>
    <div class="or">or</div>
    <div class="lbl">Employer identification number</div>
    <div class="digits">${digits([einA, einB])}</div>
  </div>
</div>

<div class="part"><span class="tag">Part II</span><span class="name">Certification</span></div>
<div class="cert">Under penalties of perjury, I certify that:
  <ol>
    <li>the number shown on this form is my correct taxpayer identification number;</li>
    <li>I am not subject to backup withholding;</li>
    <li>I am a U.S. citizen or other U.S. person; and</li>
    <li>the FATCA code(s) entered on this form, if any, are correct.</li>
  </ol>
</div>
<div class="sign">
  <div class="here">Sign<br>here</div>
  <div><span class="lbl">Signature of U.S. person ▸</span><span class="sig">${esc(profileValue("signatoryName"))}</span></div>
  <div><span class="lbl">Date ▸</span><span class="typed">${esc(W9_DETAILS.signedOn)}</span></div>
</div>
<div class="note">Signed for ${esc(profileValue("legalName"))} by ${esc(profileValue("signatoryName"))}, ${esc(profileValue("signatoryTitle"))}.</div>
<div class="instr">
  <h4>General instructions (sample)</h4>
  <p><b>Purpose.</b> A business that pays you uses this form to record your legal name, tax classification and TIN before it pays you.</p>
  <p><b>Who signs.</b> For an entity, a person authorized to act for it signs and dates the form.</p>
  <p><b>Changes.</b> Give the requester a new form if your name, address or tax classification changes.</p>
  <p><b>Where it goes.</b> Return it to the requester only, for example through its supplier portal.</p>
</div>

</div>
<div class="foot"><span>Synthetic sample for software testing. Not an IRS form. Tidewater Cloud Ltda. is fictional and ${esc(ein)} is not a valid EIN.</span><span>Sample W-9 layout</span></div>
${watermark()}
</div></body></html>`;
}

// ---------------------------------------------------------------------------------------------
// Certificate of insurance (own layout)

const COI_CSS = `
.head{display:flex;justify-content:space-between;align-items:flex-start;padding-bottom:12px;border-bottom:3px solid #12355b}
.ins{display:flex;gap:12px;align-items:center}
.ins svg{width:52px;height:52px}
.ins .n{font-size:14pt;font-weight:800;color:#12355b;line-height:1.1}
.ins .a{font-size:8pt;color:#4b525a;margin-top:3px;line-height:1.35}
.ttl{text-align:right}
.ttl .t{font-size:15pt;font-weight:800;letter-spacing:1px;color:#12355b;white-space:nowrap}
.ttl .m{font-size:9pt;color:#2b3137;margin-top:4px;line-height:1.45}
.ttl .m b{font-family:"Courier New",monospace}
.notice{margin:12px 0;padding:8px 12px;background:#eef3f8;border:1px solid #c7d4e2;border-radius:4px;font-size:8.5pt;line-height:1.45;color:#2b3137}
.two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.box{border:1px solid #9aa6b2;border-radius:4px;padding:8px 12px}
.box h3{margin:0 0 5px;font-size:8pt;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#12355b}
.box p{margin:0;font-size:10pt;line-height:1.45}
table{width:100%;border-collapse:collapse;margin-top:14px;font-size:9pt}
th{background:#12355b;color:#fff;text-align:left;font-size:8pt;letter-spacing:.6px;text-transform:uppercase;padding:6px 8px}
td{border-bottom:1px solid #c5cdd6;padding:9px 8px;vertical-align:top;line-height:1.45}
td.pol{font-family:"Courier New",monospace;font-weight:700;white-space:nowrap}
.lim{display:flex;justify-content:space-between;gap:10px}
.lim span:last-child{font-weight:700;white-space:nowrap}
.stack{display:grid;gap:12px;margin-top:14px}
.signrow{display:grid;grid-template-columns:1fr 2.6in;gap:12px;margin-top:14px;align-items:end}
.signbox{border-bottom:1px solid #16191c;padding-bottom:2px}
.signcap{font-size:8pt;color:#4b525a;margin-top:3px}
`;

const HARBOR_MARK = `<svg viewBox="0 0 52 52" aria-hidden="true"><circle cx="26" cy="26" r="25" fill="#12355b"/>
<path d="M9 30c5-5 10-5 15 0s10 5 19 0" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round"/>
<path d="M17 21h18M26 12v18" stroke="#9cc3e6" stroke-width="3" stroke-linecap="round"/></svg>`;

export function insuranceCertificateHtml(): string {
  const c = COI_DETAILS;
  const [addr1, addr2] = address();
  const rows = c.policies
    .map(
      (
        p,
      ) => `<tr><td><b>${esc(p.coverage)}</b></td><td class="pol">${esc(p.policy)}</td><td>${esc(c.periodFrom)} –<br>${esc(c.periodTo)}</td>
<td>${p.limits.map(([k, v]) => `<div class="lim"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join("")}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Certificate of insurance sample (synthetic) – Tidewater Cloud</title>
<style>${PAGE_CSS}${COI_CSS}</style></head><body><div class="page"><div class="content">
<div class="head">
  <div class="ins">${HARBOR_MARK}<div><div class="n">${esc(c.insurer)}</div><div class="a">${esc(c.insurerAddress)}<br>${esc(c.insurerContact)}</div></div></div>
  <div class="ttl"><div class="t">CERTIFICATE OF INSURANCE</div><div class="m">Certificate no. <b>${esc(c.certificateNumber)}</b><br>Date issued: ${esc(c.issuedOn)}</div></div>
</div>
<div class="notice">This certificate summarizes the policies listed below for information only. It does not change the coverage, terms, conditions or exclusions of any policy, and it gives the certificate holder no rights beyond those in the policies themselves.</div>
<div class="two">
  <div class="box"><h3>Named insured</h3><p><b>${esc(profileValue("legalName"))}</b><br>${esc(addr1 ?? "")}<br>${esc(addr2 ?? "")}<br>Tax ID ${esc(profileValue("taxId"))}</p></div>
  <div class="box"><h3>Certificate holder</h3><p>${esc(c.holder)}</p></div>
</div>
<table><thead><tr><th style="width:30%">Coverage</th><th style="width:20%">Policy number</th><th style="width:17%">Policy period</th><th>Limits</th></tr></thead><tbody>${rows}</tbody></table>
<div class="stack">
  <div class="box"><h3>Description of operations</h3><p>${esc(c.operations)}</p></div>
  <div class="box"><h3>Cancellation</h3><p>If any policy above is cancelled before its expiration date, ${esc(c.insurer)} will notify the certificate holder as set out in the policy provisions.</p></div>
</div>
<div class="signrow">
  <div class="box"><h3>Remarks</h3><p>Limits are shown in US dollars. Issued for supplier onboarding; no additional insured endorsement is attached to this certificate.</p></div>
  <div><div class="signbox"><span class="sig">${esc(c.representative.name)}</span></div><div class="signcap">Authorized representative: ${esc(c.representative.name)}, ${esc(c.representative.title)}, ${esc(c.insurer)}</div></div>
</div>
</div>
<div class="foot"><span>Synthetic sample for software testing. Harbor Mutual and Tidewater Cloud are fictional; the policy numbers do not exist.</span><span>${esc(c.certificateNumber)}</span></div>
${watermark()}
</div></body></html>`;
}

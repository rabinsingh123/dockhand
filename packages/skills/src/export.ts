// Readable Playwright TypeScript for a compiled skill (for the demo and for engineers). Deterministic: the
// same skill always gives the same text. The JSON program stays the runtime artifact; this export tries the
// stored candidates in the same rank order but has none of the runner's healing, read-back or commit gate.

import type { Candidate, ParamSpec, Skill, SkillBody, Step } from "@dockhand/core";
import { parseTemplate } from "./template.ts";

type ExportableSkill = SkillBody & { version?: number };

const DATE_HELPER = `function fmtDate(iso: string, format: "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD"): string {
  const [y = "", m = "", d = ""] = iso.slice(0, 10).split("-");
  if (format === "DD/MM/YYYY") return \`\${d}/\${m}/\${y}\`;
  if (format === "MM/DD/YYYY") return \`\${m}/\${d}/\${y}\`;
  return \`\${y}-\${m}-\${d}\`;
}`;

const NUMBER_HELPER = `function fmtNumber(n: number | string, locale: "pt-BR" | "en-US"): string {
  const [int = "0", dec] = String(n).replace(/^-/, "").split(".");
  const sign = String(n).startsWith("-") ? "-" : "";
  const grouped = int.replace(/\\B(?=(\\d{3})+(?!\\d))/g, locale === "pt-BR" ? "." : ",");
  const decimals = dec === undefined ? "" : (locale === "pt-BR" ? "," : ".") + dec.padEnd(2, "0");
  return sign + grouped + decimals;
}`;

const PICK_HELPER = `/** First candidate that matches exactly one element, in the stored rank order. */
async function pick(...candidates: Locator[]): Promise<Locator> {
  for (const c of candidates) if ((await c.count()) === 1) return c;
  throw new Error("no candidate matched exactly one element");
}`;

function camel(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function pascal(name: string): string {
  const c = camel(name);
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function tsType(p: ParamSpec): string {
  if (p.type === "number") return "number";
  if (p.type === "boolean") return "boolean";
  return "string";
}

const str = (s: string) => JSON.stringify(s);

interface Uses {
  date: boolean;
  number: boolean;
}

/** A template string as a TypeScript expression over `p`. */
function valueExpr(t: string, uses: Uses, asString = true): string {
  const refs = parseTemplate(t);
  if (refs.length === 0) return str(t);
  const exprOf = (raw: string) => {
    const r = refs.find((x) => x.raw === raw);
    if (!r) return str(raw);
    if (r.filter?.startsWith("date:")) {
      uses.date = true;
      return `fmtDate(p.${r.name}, ${str(r.filter.slice(5))})`;
    }
    if (r.filter?.startsWith("number:")) {
      uses.number = true;
      return `fmtNumber(p.${r.name}, ${str(r.filter.slice(7))})`;
    }
    return asString ? `String(p.${r.name})` : `p.${r.name}`;
  };
  if (refs.length === 1 && refs[0]?.raw === t) return exprOf(t);
  const parts = t.split(/(\{\{[^{}]*\}\})/).filter((x) => x !== "");
  return `\`${parts
    .map((part) => (part.startsWith("{{") ? `\${${exprOf(part)}}` : part.replace(/[`\\$]/g, "\\$&")))
    .join("")}\``;
}

function candidateExpr(c: Candidate, uses: Uses): string {
  switch (c.by) {
    case "testid":
      return `page.getByTestId(${valueExpr(c.value, uses)})`;
    case "role":
      return `page.getByRole(${str(c.role)}, { name: ${valueExpr(c.name, uses)}, exact: ${c.exact} })`;
    case "label":
      return `page.getByLabel(${valueExpr(c.value, uses)}, { exact: ${c.exact} })`;
    case "placeholder":
      return `page.getByPlaceholder(${valueExpr(c.value, uses)}, { exact: true })`;
    case "text":
      return `page.getByText(${valueExpr(c.value, uses)}, { exact: ${c.exact} })`;
    case "css":
      return `page.locator(${str(c.value)})`;
  }
}

function pickExpr(candidates: Candidate[], uses: Uses, indent: string): string {
  if (candidates.length === 0) return `(await pick())`;
  const lines = candidates.map((c) => `${indent}  ${candidateExpr(c, uses)},`);
  return `(\n${indent}  await pick(\n${lines.map((l) => `  ${l}`).join("\n")}\n${indent}  )\n${indent})`;
}

function stepCode(s: Step, uses: Uses): string[] {
  const I = "  ";
  const head = `${I}// ${s.id}: ${s.intent.replace(/\n/g, " ")}`;
  switch (s.op) {
    case "goto":
      return [head, `${I}await page.goto(${valueExpr(s.url, uses)});`];
    case "click":
      return [
        s.commit ? `${head} (commit: Dockhand asks the rep before this click)` : head,
        `${I}await ${pickExpr(s.target.candidates, uses, I)}.click();`,
      ];
    case "fill":
      return [head, `${I}await ${pickExpr(s.target.candidates, uses, I)}.fill(${valueExpr(s.value, uses)});`];
    case "select":
      return [
        head,
        `${I}await ${pickExpr(s.trigger.candidates, uses, I)}.click();`,
        `${I}await page.getByRole("option", { name: ${valueExpr(s.option, uses)}, exact: true }).click();`,
      ];
    case "check":
      return [head, `${I}await ${pickExpr(s.target.candidates, uses, I)}.setChecked(${s.checked});`];
    case "upload":
      return [head, `${I}await ${pickExpr(s.target.candidates, uses, I)}.setInputFiles(p.${s.fileParam});`];
    case "press":
      return [
        s.commit ? `${head} (commit: Dockhand asks the rep before this key press)` : head,
        s.target
          ? `${I}await ${pickExpr(s.target.candidates, uses, I)}.press(${str(s.key)});`
          : `${I}await page.keyboard.press(${str(s.key)});`,
      ];
    case "waitFor": {
      const out = [head];
      if (s.urlIncludes)
        out.push(`${I}await page.waitForURL((url) => url.href.includes(${valueExpr(s.urlIncludes, uses)}));`);
      if (s.text) out.push(`${I}await page.getByText(${valueExpr(s.text, uses)}).first().waitFor();`);
      if (s.target) out.push(`${I}await ${pickExpr(s.target.candidates, uses, I)}.waitFor();`);
      return out;
    }
    case "extract":
      return [
        head,
        `${I}extracted[${str(s.name)}] = (await page.locator("body").innerText()).match(new RegExp(${str(s.regex)}))?.[0] ?? "";`,
      ];
  }
}

/** Readable Playwright TypeScript for `skill`. */
export function exportPlaywright(skill: Skill | ExportableSkill): string {
  const uses: Uses = { date: false, number: false };
  const fn = camel(skill.name);
  const paramsType = `${pascal(skill.name)}Params`;
  const body = skill.steps.flatMap((s) => stepCode(s, uses));
  const success: string[] = [];
  if (skill.success.urlIncludes) {
    success.push(
      `  await page.waitForURL((url) => url.href.includes(${valueExpr(skill.success.urlIncludes, uses)}));`,
    );
  }
  if (skill.success.textPattern) {
    success.push(`  await page.getByText(new RegExp(${str(skill.success.textPattern)})).first().waitFor();`);
  }
  if (skill.success.extract.length > 0) {
    success.push(`  const text = await page.locator("body").innerText();`);
    for (const e of skill.success.extract) {
      success.push(`  extracted[${str(e.name)}] = text.match(new RegExp(${str(e.regex)}))?.[0] ?? "";`);
    }
  }
  const version = "version" in skill && skill.version !== undefined ? ` v${skill.version}` : "";
  const out = [
    `// ${skill.title}`,
    `// Dockhand skill ${skill.name}${version} for portal "${skill.portalId}", exported from the compiled program.`,
    "// The runner adds what this file does not: healing, read-back before the commit, and the approval gate.",
    `import type { Locator, Page } from "playwright";`,
    "",
    `export interface ${paramsType} {`,
    ...skill.params.flatMap((p) => [
      `  /** ${p.description || p.name}${p.type === "file" ? " (file path)" : ""} */`,
      `  ${p.name}${p.required ? "" : "?"}: ${tsType(p)};`,
    ]),
    "}",
    "",
    PICK_HELPER,
    ...(uses.date ? ["", DATE_HELPER] : []),
    ...(uses.number ? ["", NUMBER_HELPER] : []),
    "",
    `export async function ${fn}(page: Page, p: ${paramsType}): Promise<Record<string, string>> {`,
    "  const extracted: Record<string, string> = {};",
    ...body,
    ...(success.length > 0 ? ["  // Success check", ...success] : []),
    "  return extracted;",
    "}",
    "",
  ];
  return out.join("\n");
}

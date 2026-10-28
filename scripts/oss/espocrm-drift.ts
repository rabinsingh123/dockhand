// UI drift on EspoCRM made through its own admin tools: each drift is the exact REST call the admin screen
// sends (Entity Manager > Fields, Layout Manager), so it can be replayed on camera and reverted cleanly.
//
//   label     Entity Manager: rename the field labels "First Name" -> "Given Name" and
//             "Account Name" -> "Company" (PUT Admin/fieldManager/Lead/<field>; revert: Reset to Default,
//             POST FieldManager/action/resetToDefault)
//   layout    Layout Manager: Lead > Detail with the Details panel first, Status/Source moved to the top
//             row and Title/Website swapped (PUT Lead/layout/detail; revert: Reset to Default,
//             POST Layout/action/resetToDefault)
//   required  Entity Manager: add a required text field "Tax ID" and place it on the form
//             (POST Admin/fieldManager/Lead + PUT Lead/layout/detail; revert: DELETE the field + layout reset)
//
// Usage: tsx scripts/oss/espocrm-drift.ts apply|revert|status [label|layout|required|all]

import { espoApi } from "./espocrm.ts";

export type DriftName = "label" | "layout" | "required";

type Cell = { name: string; fullWidth?: boolean } | false;
interface Panel {
  label?: string;
  rows: Cell[][];
  [k: string]: unknown;
}

const LABELS: Record<string, [string, string]> = {
  firstName: ["First Name", "Given Name"],
  accountName: ["Account Name", "Company"],
};
const REQUIRED_FIELD = "cTaxId"; // EspoCRM prefixes custom fields with "c"

async function resetField(name: string): Promise<void> {
  await espoApi("POST", "FieldManager/action/resetToDefault", { scope: "Lead", name });
}
async function resetLayout(): Promise<void> {
  await espoApi("POST", "Layout/action/resetToDefault", { scope: "Lead", name: "detail" });
}
async function layout(): Promise<Panel[]> {
  return espoApi<Panel[]>("GET", "Lead/layout/detail");
}
const cellNames = (p: Panel[]) =>
  p.map((x) => x.rows.map((r) => r.map((c) => (c ? c.name : "-")).join("|")).join(" / "));

/** The Details panel first, its Status/Source row on top, and Title/Website swapped in Overview. */
function reorder(panels: Panel[]): Panel[] {
  const copy = JSON.parse(JSON.stringify(panels)) as Panel[];
  const overview = copy.find((p) => p.rows.some((r) => r.some((c) => c && c.name === "name")));
  const details = copy.find((p) => p.rows.some((r) => r.some((c) => c && c.name === "status")));
  if (!overview || !details) throw new Error("unexpected Lead detail layout");
  for (const r of overview.rows) {
    const t = r.findIndex((c) => c && c.name === "title");
    const w = r.findIndex((c) => c && c.name === "website");
    if (t >= 0 && w >= 0) [r[t], r[w]] = [r[w] as Cell, r[t] as Cell];
  }
  // Email/Phone row moves below Title/Website.
  const ei = overview.rows.findIndex((r) => r.some((c) => c && c.name === "emailAddress"));
  if (ei >= 0) overview.rows.splice(ei + 1, 0, ...overview.rows.splice(ei, 1));
  return [details, overview, ...copy.filter((p) => p !== overview && p !== details)];
}

export const DRIFTS: Record<DriftName, { apply(): Promise<string>; revert(): Promise<string> }> = {
  label: {
    async apply() {
      for (const [field, [, to]] of Object.entries(LABELS))
        await espoApi("PUT", `Admin/fieldManager/Lead/${field}`, { label: to });
      return Object.entries(LABELS)
        .map(([, [from, to]]) => `"${from}" -> "${to}"`)
        .join(", ");
    },
    async revert() {
      for (const field of Object.keys(LABELS)) await resetField(field);
      return "labels reset to default";
    },
  },
  layout: {
    async apply() {
      const next = reorder(await layout());
      await espoApi("PUT", "Lead/layout/detail", next);
      return `layout now ${cellNames(await layout()).join(" || ")}`;
    },
    async revert() {
      await resetLayout();
      return "layout reset to default";
    },
  },
  required: {
    async apply() {
      const defs = await espoApi<{ fields?: Record<string, unknown> }>("GET", "Metadata?key=entityDefs.Lead");
      const exists = Boolean((defs as { fields?: Record<string, unknown> }).fields?.[REQUIRED_FIELD]);
      if (!exists)
        await espoApi("POST", "Admin/fieldManager/Lead", {
          name: "taxId",
          type: "varchar",
          label: "Tax ID",
          required: true,
          maxLength: 40,
        });
      const panels = await layout();
      const placed = panels.some((p) => p.rows.some((r) => r.some((c) => c && c.name === REQUIRED_FIELD)));
      if (!placed) {
        const overview = panels.find((p) => p.rows.some((r) => r.some((c) => c && c.name === "name")));
        if (!overview) throw new Error("unexpected Lead detail layout");
        // Next to Address, which has a free right-hand cell in the default layout.
        const row = overview.rows.find((r) => r.some((c) => c && c.name === "address"));
        const free = row ? row.indexOf(false) : -1;
        if (row && free >= 0) row[free] = { name: REQUIRED_FIELD };
        else overview.rows.push([{ name: REQUIRED_FIELD }, false]);
        await espoApi("PUT", "Lead/layout/detail", panels);
      }
      return `required field "Tax ID" (${REQUIRED_FIELD}) on the Lead form`;
    },
    async revert() {
      await resetLayout();
      try {
        await espoApi("DELETE", `Admin/fieldManager/Lead/${REQUIRED_FIELD}`);
      } catch (err) {
        if (!/HTTP 404/.test((err as Error).message)) throw err;
      }
      return `"Tax ID" removed, layout reset to default`;
    },
  },
};

export const REQUIRED_DRIFT_ATTR = REQUIRED_FIELD;

async function status(): Promise<string> {
  const defs = await espoApi<{ fields?: Record<string, { label?: string; required?: boolean }> }>(
    "GET",
    "Metadata?key=entityDefs.Lead",
  );
  const labels = await Promise.all(
    Object.keys(LABELS).map(
      async (f) =>
        `${f}="${(await espoApi<{ label?: string }>("GET", `Admin/fieldManager/Lead/${f}`)).label}"`,
    ),
  );
  return [
    `labels: ${labels.join(", ")}`,
    `Tax ID field: ${defs.fields?.[REQUIRED_FIELD] ? "present" : "absent"}`,
    `layout: ${cellNames(await layout()).join(" || ")}`,
  ].join("\n");
}

if (
  import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, "/")}` ||
  process.argv[1]?.endsWith("espocrm-drift.ts")
) {
  const [cmd, which = "all"] = process.argv.slice(2);
  const names = (which === "all" ? Object.keys(DRIFTS) : [which]) as DriftName[];
  if (cmd === "status") console.log(await status());
  else if (cmd === "apply" || cmd === "revert") {
    for (const n of names) {
      const d = DRIFTS[n];
      if (!d) throw new Error(`unknown drift ${n} (label | layout | required | all)`);
      console.log(`${cmd} ${n}: ${await d[cmd]()}`);
    }
  } else {
    console.log("usage: tsx scripts/oss/espocrm-drift.ts apply|revert|status [label|layout|required|all]");
    process.exitCode = 2;
  }
}

// Slash commands, answered from the database (no model call): /skills [name], /rollback <name> <version>, /stats.

import type { Ledger, SkillStore } from "@dockhand/core";
import { WHAT_I_DO } from "../plan.ts";
import type { Repos } from "../repo.ts";
import { usd } from "../tools/receipts.ts";

export function isCommand(text: string | undefined): boolean {
  return /^\/[a-z]/i.test(text?.trim() ?? "");
}

export function runCommand(text: string, deps: { skills: SkillStore; repos: Repos; ledger: Ledger }): string {
  const [cmd = "", ...args] = text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/skills":
      return args[0] ? skillDetail(deps.skills, args[0]) : skillList(deps.skills);
    case "/rollback":
      return rollback(deps.skills, args[0], args[1]);
    case "/stats":
      return stats(deps);
    default:
      return WHAT_I_DO;
  }
}

function skillList(skills: SkillStore): string {
  const rows = skills.list();
  if (rows.length === 0) return "No skills yet. Send me a screen recording of a portal task to teach one.";
  return [
    "Skills:",
    ...rows.map(
      (r) =>
        `• ${r.name} v${r.activeVersion} (${r.versions} version${r.versions === 1 ? "" : "s"}): ${r.title}`,
    ),
    "Details: /skills <name>",
  ].join("\n");
}

function skillDetail(skills: SkillStore, name: string): string {
  const s = skills.active(name);
  if (!s) return `No skill named ${name}. /skills lists them.`;
  const versions = skills.list().find((r) => r.name === name)?.versions ?? 1;
  const history: string[] = [];
  for (let v = s.version; v >= 1 && history.length < 3; v--) {
    const old = skills.get(name, v);
    if (old?.changelog) history.push(`v${v}: ${old.changelog.split("\n")[0]}`);
  }
  return [
    `${s.name} v${s.version} (active; ${versions} version${versions === 1 ? "" : "s"}): ${s.title}`,
    `Portal: ${s.portalId}. ${s.steps.length} steps.`,
    `Params: ${s.params.map((p) => `${p.name}${p.required ? "" : "?"} (${p.type})`).join(", ")}`,
    ...(history.length ? ["Changes:", ...history] : []),
    ...(s.version > 1 ? [`Undo the last change: /rollback ${s.name} ${s.version - 1}`] : []),
  ].join("\n");
}

function rollback(skills: SkillStore, name: string | undefined, version: string | undefined): string {
  const v = Number(version);
  if (!name || !Number.isInteger(v) || v < 1)
    return "Usage: /rollback <skill> <version>, e.g. /rollback register_partner_deal 1";
  const target = skills.get(name, v);
  if (!target) return `${name} has no version ${v}.`;
  const current = skills.active(name);
  if (current?.version === v) return `${name} v${v} is already active.`;
  skills.activate(name, v);
  return `Rolled back: ${name} v${v} is active${current ? ` (v${current.version} kept: /rollback ${name} ${current.version})` : ""}.`;
}

function stats(deps: { repos: Repos; ledger: Ledger }): string {
  const rows = deps.repos.runs.summary();
  const total = (mode?: string, outcome?: string) =>
    rows
      .filter((r) => (!mode || r.mode === mode) && (!outcome || r.outcome === outcome))
      .reduce((n, r) => n + r.runs, 0);
  const avg = (mode: string) => {
    const ok = rows.filter((r) => r.mode === mode && r.outcome === "success" && r.avgMs !== null);
    const n = ok.reduce((s, r) => s + r.runs, 0);
    return n ? ok.reduce((s, r) => s + (r.avgMs ?? 0) * r.runs, 0) / n / 1000 : null;
  };
  const all = deps.ledger.totals({});
  const intake = deps.ledger.totals({ purposes: ["transcribe", "extract", "understand"] });
  const exec = deps.ledger.totals({
    purposes: ["cu_first_run", "cu_repair", "heal_match", "compile_annotate", "teach"],
  });
  const line = (mode: string, label: string) => {
    const n = total(mode);
    if (n === 0) return null;
    const a = avg(mode);
    return `• ${label}: ${total(mode, "success")}/${n} succeeded${a !== null ? `, avg ${a.toFixed(1)} s` : ""}`;
  };
  return [
    "Dockhand stats",
    ...[
      line("agentic", "First runs (computer use)"),
      line("replay", "Replays"),
      line("repair", "Repaired replays"),
    ].filter((l): l is string => l !== null),
    `• Model calls: ${all.calls}, ${usd(all.costUsd)} (intake ${usd(intake.costUsd)}, execution ${usd(exec.costUsd)})`,
  ].join("\n");
}

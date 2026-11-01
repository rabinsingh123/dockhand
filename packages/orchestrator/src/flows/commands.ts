// Slash commands, answered from the database (no model call): /skills [name], /rollback <name> <version>,
// /history, /stats, /help.

import type { Ledger, SkillStore } from "@dockhand/core";
import { humanize } from "../params.ts";
import { WHAT_I_DO } from "../plan.ts";
import type { Repos } from "../repo.ts";
import { seconds, usd } from "../tools/receipts.ts";

export const COMMANDS =
  "/skills, /skills <name>, /history, /stats, /watch, /rollback <skill> <version>, /help";

export function isCommand(text: string | undefined): boolean {
  return /^\/[a-z]/i.test(text?.trim() ?? "");
}

export interface CommandDeps {
  skills: SkillStore;
  repos: Repos;
  ledger: Ledger;
  /** Who asked (for /history) and their time zone. */
  rep?: { phone: string; tz: string };
  /** Portal id -> display name. */
  portalNames?: Record<string, string>;
}

export function runCommand(text: string, deps: CommandDeps): string {
  const [cmd = "", ...args] = text.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case "/skills":
    case "/skill":
      return args[0] ? skillDetail(deps, args[0]) : skillList(deps.skills);
    case "/rollback":
      return rollback(deps.skills, args[0], args[1]);
    case "/history":
      return history(deps);
    case "/stats":
      return stats(deps);
    case "/help":
    case "/start":
      return WHAT_I_DO;
    default:
      return `I don't know ${cmd.slice(0, 30)}. Commands: ${COMMANDS}`;
  }
}

function skillList(skills: SkillStore): string {
  const rows = skills.list();
  if (rows.length === 0) return "No skills yet. Send me a screen recording of a portal task to teach one.";
  return [
    "*Skills*",
    ...rows.map(
      (r) =>
        `• ${r.name} v${r.activeVersion}${r.versions > 1 ? ` (${r.versions} versions)` : ""}: ${r.title}`,
    ),
    "Details: /skills <name>",
  ].join("\n");
}

function skillDetail(deps: CommandDeps, name: string): string {
  const { skills } = deps;
  const s = skills.active(name);
  if (!s) return `No skill named ${name.slice(0, 40)}. /skills lists them.`;
  const versions = skills.list().find((r) => r.name === name)?.versions ?? 1;
  const history: string[] = [];
  for (let v = versions; v >= 1 && history.length < 3; v--) {
    const old = skills.get(name, v);
    if (old?.changelog) history.push(`v${v}: ${old.changelog.split("\n")[0]}`);
  }
  const values = s.params.map((p) => `${humanize(p.name)}${p.required ? "" : " (optional)"}`);
  const portal = deps.portalNames?.[s.portalId] ?? s.portalId;
  return [
    `*${s.name} v${s.version}* (active${versions > 1 ? `, ${versions} versions` : ""})`,
    s.title,
    `${portal} · ${s.steps.length} steps`,
    `Values: ${values.join(", ")}`,
    ...(history.length ? ["Changes:", ...history] : []),
    ...(s.version > 1 ? [`Undo the last change: /rollback ${s.name} ${s.version - 1}`] : []),
  ].join("\n");
}

function rollback(skills: SkillStore, name: string | undefined, version: string | undefined): string {
  const v = Number(version);
  if (!name || !Number.isInteger(v) || v < 1)
    return "Usage: /rollback <skill> <version>, e.g. /rollback register_partner_deal 1";
  const target = skills.get(name, v);
  if (!target) {
    return skills.active(name)
      ? `${name} has no version ${v}.`
      : `No skill named ${name.slice(0, 40)}. /skills lists them.`;
  }
  const current = skills.active(name);
  if (current?.version === v) return `${name} v${v} is already active.`;
  skills.activate(name, v);
  return `Rolled back: ${name} v${v} is active${current ? ` (v${current.version} kept: /rollback ${name} ${current.version})` : ""}.`;
}

const STATUS_WORDS: Record<string, string> = {
  succeeded: "done",
  failed: "stopped",
  cancelled: "cancelled",
  expired: "expired",
  awaiting_approval: "waiting for your tap",
  awaiting_input: "waiting for details from you",
  executing: "in progress",
  understanding: "in progress",
  received: "in progress",
};

const MODE_WORDS: Record<string, string> = {
  agentic: "first run",
  replay: "replay",
  repair: "repaired replay",
};

function history(deps: CommandDeps): string {
  if (!deps.rep) return "No history yet.";
  const tz = deps.rep.tz;
  const rows = deps.repos.jobs.recentForRep(deps.rep.phone, 6);
  if (rows.length === 0)
    return "No requests yet. Forward me a referral form, an invitation or a pricing request.";
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const lines = rows.map((j) => {
    const u = j.understanding;
    const what =
      j.intent === "register_deal"
        ? `Register ${u?.company ?? "a deal"}`
        : j.intent === "supplier_onboarding"
          ? `Supplier registration for ${u?.buyerName ?? u?.company ?? u?.tenant ?? "a buyer"}`
          : j.intent === "quote"
            ? `Quote for ${u?.company ?? "a customer"}`
            : j.intent === "create_lead"
              ? `Lead ${u?.contactName ?? u?.company ?? ""} in EspoCRM`.replace("  ", " ")
              : "Teach a portal task";
    const id = j.run ? Object.values(j.run.extracted)[0] : undefined;
    const status =
      j.status === "succeeded" && id ? `submitted ${id}` : (STATUS_WORDS[j.status] ?? "in progress");
    const run =
      j.run && j.run.ms !== null && j.status === "succeeded"
        ? ` (${MODE_WORDS[j.run.mode] ?? j.run.mode}, ${seconds(j.run.ms / 1000)})`
        : "";
    return `• ${clock.format(new Date(j.createdAt))} ${what}: ${status}${run}`;
  });
  return ["*Recent requests*", ...lines].join("\n");
}

function stats(deps: CommandDeps): string {
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
    return `• ${label}: ${total(mode, "success")}/${n} succeeded${a !== null ? `, avg ${seconds(a)}` : ""}`;
  };
  const runs = [
    line("agentic", "First runs (computer use)"),
    line("replay", "Replays"),
    line("repair", "Repaired replays"),
  ].filter((l): l is string => l !== null);
  return [
    "*Dockhand stats*",
    ...(runs.length > 0 ? runs : ["• No portal runs yet"]),
    `• Model calls: ${all.calls}, ${usd(all.costUsd)} (intake ${usd(intake.costUsd)}, execution ${usd(exec.costUsd)})`,
  ].join("\n");
}

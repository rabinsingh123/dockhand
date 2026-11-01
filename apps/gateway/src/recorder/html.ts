// HTML helpers for the flight recorder: escaping, the page shell, formatting and a small code highlighter.

import { fontCss, RECORDER_CSS } from "./style.ts";

/** A fragment that is already HTML (everything else is escaped). */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Tagged template: interpolations are escaped unless they are Html (or arrays of Html). */
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0] ?? "";
  values.forEach((v, i) => {
    out += render(v) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

function render(v: unknown): string {
  if (v instanceof Html) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return esc(v);
}

export const raw = (s: string) => new Html(s);

export const LOGO = raw(
  '<svg width="20" height="20" viewBox="0 0 18 18" aria-hidden="true"><rect width="18" height="18" rx="4.5" fill="#111111"/><path d="M5.2 4.6h3.6a4.4 4.4 0 0 1 0 8.8H5.2z" fill="none" stroke="#FFFFFF" stroke-width="1.9" stroke-linejoin="round"/><circle cx="9.1" cy="9" r="1.35" fill="#FFFFFF"/></svg>',
);

export function page(o: {
  title: string;
  nav: "runs" | "skills" | "teach";
  body: Html;
  base: string;
  /** Filming: no header, paper background, content inside the 1.15x push-in safe area. */
  focus?: boolean;
}): string {
  const b = o.base;
  const home = b.endsWith("/") ? b.slice(0, -1) : b; // "/recorder" (the mount path has no trailing slash)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(o.title)} · Dockhand flight recorder</title><style>${fontCss(b)}${RECORDER_CSS}</style></head><body${o.focus ? ' class="focus"' : ""}>
${
  o.focus
    ? `<main class="stage">${o.body.value}</main>`
    : `<header class="top"><a class="brand" href="${home}">${LOGO.value}<span>Dockhand</span><small>Flight recorder</small></a>
<nav class="nav"><a href="${home}#runs" class="${o.nav === "runs" ? "on" : ""}">Runs</a><a href="${home}#skills" class="${o.nav === "skills" ? "on" : ""}">Skills</a><a href="${home}#teach" class="${o.nav === "teach" ? "on" : ""}">Teach</a></nav>
<span class="note">Read-only view of the run ledger · synthetic data</span></header>
<main class="wrap">${o.body.value}</main>`
}
<script>
for (const t of document.querySelectorAll('[data-tabs]')) {
  const bs = t.querySelectorAll('button[data-tab]');
  bs.forEach((b) => b.addEventListener('click', () => {
    bs.forEach((x) => x.classList.toggle('on', x === b));
    for (const p of document.querySelectorAll('[data-pane="' + t.dataset.tabs + '"]')) p.hidden = p.dataset.name !== b.dataset.tab;
  }));
}
for (const r of document.querySelectorAll('tr[data-href]')) r.addEventListener('click', () => { location.href = r.dataset.href; });
</script></body></html>`;
}

// ---------- formatting ----------

export const COLORS = {
  agentic: "var(--cu)",
  replay: "var(--replay)",
  repair: "var(--heal)",
  dry: "var(--dry)",
  ok: "var(--ok)",
  bad: "var(--bad)",
  wait: "var(--wait)",
  muted: "#94a3b8",
} as const;

export function chip(
  text: string,
  color: string,
  o: { dot?: boolean; lg?: boolean; title?: string } = {},
): Html {
  return html`<span class="chip${o.dot ? " dot" : ""}${o.lg ? " lg" : ""}" style="--c:${raw(color)}"${raw(o.title ? ` title="${esc(o.title)}"` : "")}>${text}</span>`;
}

export function ms(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(v < 10_000 ? 2 : 1)} s`;
  const m = Math.floor(v / 60_000);
  return `${m} min ${Math.round((v % 60_000) / 1000)} s`;
}

/** A model call's latency from the ledger; a cassette answers in milliseconds, so it says "replayed". */
export function latency(v: number | null | undefined, provider: string): string {
  if (provider === "cassette") return "replayed";
  if (provider === "fake" || provider === "scripted") return `${provider} model`;
  return ms(v);
}

export function usd(v: number | null | undefined): string {
  if (v === null || v === undefined) return "–";
  if (v === 0) return "$0.00";
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

export function when(epochMs: number | null | undefined): string {
  if (!epochMs) return "–";
  const d = new Date(epochMs);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function int(v: number | null | undefined): string {
  return v === null || v === undefined ? "–" : Math.round(v).toLocaleString("en-US");
}

export const OUTCOME_COLOR: Record<string, string> = {
  success: COLORS.ok,
  dry_run_ok: COLORS.ok,
  done: COLORS.ok,
  failed: COLORS.bad,
  rejected: COLORS.bad,
  expired: COLORS.muted,
  unknown: COLORS.wait,
  needs_input: COLORS.wait,
};

export const MODE_LABEL: Record<string, string> = {
  agentic: "Computer use · first run",
  replay: "Replay",
  repair: "Replay + heal",
};

export const MODE_COLOR: Record<string, string> = {
  agentic: COLORS.agentic,
  replay: COLORS.replay,
  repair: COLORS.repair,
};

export const RUNG: Record<string, { n: number; how: string; color: string }> = {
  fallback: { n: 1, how: "stored fallback selector", color: COLORS.repair },
  similarity: { n: 1, how: "fingerprint match", color: COLORS.repair },
  open_weights: { n: 2, how: "Muse Spark Open", color: COLORS.repair },
  computer_use: { n: 3, how: "Muse computer use", color: COLORS.repair },
  ask_rep: { n: 4, how: "asked the rep", color: COLORS.wait },
};

// ---------- code highlighting ----------

const TS_KEYWORDS = new Set(
  "import export from type interface const let var async await function return if else for of in new try catch throw extends as true false null undefined void typeof".split(
    " ",
  ),
);

/** JSON or TypeScript to highlighted HTML (escaped). Small tokenizer: strings, comments, numbers, words. */
export function highlight(code: string, lang: "json" | "ts"): Html {
  const re =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)|([{}[\]()])/g;
  let out = "";
  let last = 0;
  for (const m of code.matchAll(re)) {
    const i = m.index ?? 0;
    out += esc(code.slice(last, i));
    const [tok, comment, str, num, word, punct] = m;
    if (comment) out += `<span class="c">${esc(comment)}</span>`;
    else if (str) {
      const isKey = lang === "json" && /^\s*:/.test(code.slice(i + tok.length));
      out += `<span class="${isKey ? "p" : "s"}">${esc(str)}</span>`;
    } else if (num) out += `<span class="n">${esc(num)}</span>`;
    else if (word) {
      if (lang === "json" && (word === "true" || word === "false" || word === "null"))
        out += `<span class="b">${word}</span>`;
      else if (lang === "ts" && TS_KEYWORDS.has(word)) out += `<span class="k">${word}</span>`;
      else if (lang === "ts" && /^\s*\(/.test(code.slice(i + tok.length)))
        out += `<span class="f">${esc(word)}</span>`;
      else out += esc(word);
    } else if (punct) out += `<span class="faint">${esc(punct)}</span>`;
    else out += esc(tok);
    last = i + tok.length;
  }
  out += esc(code.slice(last));
  return raw(out);
}

// The cue screen: a local page Rabin keeps open on the laptop (never filmed: nothing on the desktop is
// recorded). It shows the current take, his exact phone steps, a live status read from the gateway's database
// (your turn, tap Approve, working, done), and Start / Redo buttons. The director owns the state; this only
// serves it and turns button presses into actions.

import { createServer, type Server } from "node:http";

export interface CueTake {
  id: string;
  title: string;
  shot: string;
  optional: boolean;
  state: "next" | "active" | "done" | "failed" | "skipped";
  attempts: number;
}

export interface CueState {
  session: string;
  mode: string;
  takes: CueTake[];
  current: {
    id: string;
    title: string;
    shot: string;
    director: string;
    phone: string[];
    approxMin: number;
    phase: "waiting_start" | "setting_up" | "running" | "done" | "failed" | "restarting";
    status: string;
    detail: string;
    readyAt: number | null;
    lastDockhand: string;
  } | null;
  spendUsd: number;
  notes: string[];
}

export type CueAction = "start" | "redo" | "skip" | "finish";

export interface Cue {
  url: string;
  state: CueState;
  /** Resolves with the next button press (or immediately with "start" when `auto`). */
  next(): Promise<CueAction>;
  /** A press that arrived while the director was busy, without waiting (null: none). */
  poll(): CueAction | null;
  close(): Promise<void>;
}

export async function startCue(o: { port: number; state: CueState; auto: boolean }): Promise<Cue> {
  const queue: CueAction[] = [];
  let waiter: ((a: CueAction) => void) | null = null;
  const push = (a: CueAction) => {
    if (waiter) {
      const w = waiter;
      waiter = null;
      w(a);
    } else queue.push(a);
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(o.state));
      return;
    }
    if (req.method === "POST" && /^\/(start|redo|skip|finish)$/.test(url.pathname)) {
      push(url.pathname.slice(1) as CueAction);
      res.writeHead(204).end();
      return;
    }
    if (req.method === "GET" && url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(PAGE);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, "127.0.0.1", () => resolve());
  });
  return {
    url: `http://localhost:${o.port}/`,
    state: o.state,
    next() {
      if (o.auto) return Promise.resolve("start");
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve) => {
        waiter = resolve;
      });
    },
    poll: () => queue.shift() ?? null,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Dockhand · cue</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#0e1116;--card:#171b22;--ink:#e8ecf2;--muted:#8b95a5;--ok:#4ade80;--warn:#fbbf24;--bad:#fb7185;--accent:#38bdf8}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:980px;margin:0 auto;padding:22px 20px 40px}
.top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;color:var(--muted);font-size:13px}
.takes{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 18px}
.pill{padding:3px 10px;border-radius:999px;background:var(--card);color:var(--muted);font-size:12.5px;border:1px solid #232a35}
.pill.active{color:#0b0d12;background:var(--accent);border-color:var(--accent);font-weight:700}
.pill.done{color:var(--ok);border-color:rgba(74,222,128,.4)}.pill.failed{color:var(--bad);border-color:rgba(251,113,133,.45)}
.pill.skipped{opacity:.5;text-decoration:line-through}
.card{background:var(--card);border:1px solid #232a35;border-radius:14px;padding:20px 22px}
h1{margin:0 0 2px;font-size:26px}.shot{color:var(--muted);font-size:14px}
.dir{margin:12px 0 0;padding:9px 12px;border-radius:9px;background:#10151c;color:#b9c3d1;font-size:14px}
ol{margin:16px 0 0;padding-left:24px;font-size:19px}li{margin:7px 0}
.status{margin-top:18px;padding:16px 18px;border-radius:12px;font-size:24px;font-weight:750;background:#10151c;border:1px solid #232a35}
.status.turn{border-color:var(--warn);color:var(--warn)}.status.tap{border-color:var(--accent);color:var(--accent)}
.status.done{border-color:var(--ok);color:var(--ok)}.status.failed{border-color:var(--bad);color:var(--bad)}
.detail{margin-top:6px;font-size:14.5px;font-weight:500;color:var(--muted);white-space:pre-wrap}
.row{display:flex;gap:10px;margin-top:18px;flex-wrap:wrap}
button{font:inherit;font-weight:700;border:0;border-radius:10px;padding:12px 18px;cursor:pointer}
.go{background:var(--ok);color:#06210f}.redo{background:#2b3240;color:var(--ink)}.skip{background:transparent;color:var(--muted);border:1px solid #2b3240}
.notes{margin-top:16px;color:var(--muted);font-size:13px;white-space:pre-wrap}
</style></head><body><div class="wrap">
<div class="top"><span id="session"></span><span id="spend"></span></div>
<div class="takes" id="takes"></div>
<div class="card" id="card"><h1>Connecting…</h1></div>
<div class="notes" id="notes"></div>
</div><script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
async function act(a) { await fetch("/" + a, { method: "POST" }); tick(); }
function cls(status, phase) {
  if (phase === "done") return "done"; if (phase === "failed") return "failed";
  if (/^Tap /.test(status)) return "tap"; if (/^Your turn/.test(status)) return "turn"; return "";
}
async function tick() {
  let s; try { s = await (await fetch("/state", { cache: "no-store" })).json(); } catch { return; }
  $("session").textContent = s.session + " · " + s.mode;
  $("spend").textContent = s.mode === "live" ? "model spend this session: $" + s.spendUsd.toFixed(3) : "rehearsal: $0";
  $("takes").innerHTML = s.takes.map((t) => '<span class="pill ' + t.state + '">' + esc(t.title.split(":")[0]) + (t.attempts > 1 ? " ×" + t.attempts : "") + "</span>").join("");
  const c = s.current;
  if (!c) { $("card").innerHTML = "<h1>Session finished</h1><p>Copy your phone recording into the session folder; I take it from there.</p>"; return; }
  const secs = c.readyAt ? Math.round((Date.now() - c.readyAt) / 1000) : null;
  const buttons = c.phase === "waiting_start"
    ? '<button class="go" onclick="act(\\'start\\')">Start this take</button><button class="redo" onclick="act(\\'redo\\')">Redo the previous take</button><button class="skip" onclick="act(\\'skip\\')">Skip</button><button class="skip" onclick="act(\\'finish\\')">End session</button>'
    : c.phase === "running" ? '<button class="redo" onclick="act(\\'redo\\')">Something went wrong: redo this take</button>' : "";
  $("card").innerHTML =
    "<h1>" + esc(c.title) + '</h1><div class="shot">' + esc(c.shot) + " · about " + c.approxMin + " min" + (secs !== null ? " · " + secs + " s in" : "") + "</div>" +
    '<div class="dir">I set: ' + esc(c.director) + "</div>" +
    "<ol>" + c.phone.map((p) => "<li>" + esc(p) + "</li>").join("") + "</ol>" +
    '<div class="status ' + cls(c.status, c.phase) + '">' + esc(c.status) + '<div class="detail">' + esc(c.detail) + (c.lastDockhand ? "\\nDockhand: " + esc(c.lastDockhand) : "") + "</div></div>" +
    '<div class="row">' + buttons + "</div>";
  $("notes").textContent = (s.notes || []).slice(-6).join("\\n");
}
setInterval(tick, 700); tick();
</script></body></html>`;

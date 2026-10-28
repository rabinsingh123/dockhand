// Flight recorder styles: the same dark, high-contrast language as the demo HUD (packages/browser/src/hud),
// tuned to read at 1080p. One stylesheet, no external fonts or scripts.

export const RECORDER_CSS = `
:root{
  --bg:#0a0c10;--panel:#11141a;--panel-2:#161a22;--line:rgba(255,255,255,.08);--line-2:rgba(255,255,255,.14);
  --text:#e9edf3;--text-2:#c2cad6;--muted:#8a94a4;--faint:#5d6676;
  --cu:#a78bfa;--replay:#22d3ee;--heal:#fbbf24;--dry:#60a5fa;--wait:#f472b6;--ok:#4ade80;--bad:#fb7185;
  --mono:"Cascadia Code","Cascadia Mono",Consolas,ui-monospace,"SFMono-Regular",monospace;
  --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}
body{font:14px/1.45 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
a:hover{color:#fff}
code,pre,.mono{font-family:var(--mono);font-size:12.5px}
h1,h2,h3,p{margin:0}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:18px;height:52px;padding:0 28px;background:rgba(10,12,16,.92);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:15px;letter-spacing:.1px}
.brand small{font-weight:600;color:var(--muted);font-size:13px;padding-left:10px;border-left:1px solid var(--line-2)}
.nav{display:flex;gap:4px;margin-left:12px}
.nav a{padding:6px 11px;border-radius:7px;color:var(--text-2);font-weight:600;font-size:13px}
.nav a:hover,.nav a.on{background:rgba(255,255,255,.06);color:#fff}
.top .note{margin-left:auto;color:var(--faint);font-size:12px}
.wrap{max-width:1680px;margin:0 auto;padding:22px 28px 60px}
.crumbs{color:var(--muted);font-size:12.5px;margin-bottom:8px}
.crumbs a{color:var(--text-2)}
.crumbs a:hover{color:#fff}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:18px}
.title{font-size:26px;font-weight:750;letter-spacing:-.3px;line-height:1.2;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sub{margin-top:5px;color:var(--muted);font-size:13.5px}
.chip{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:999px;font-size:11.5px;font-weight:700;letter-spacing:.2px;white-space:nowrap;border:1px solid color-mix(in srgb,var(--c,#94a3b8) 45%,transparent);color:var(--c,#cbd5e1);background:color-mix(in srgb,var(--c,#94a3b8) 12%,transparent)}
.chip.dot::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
.chip.lg{height:26px;font-size:12.5px;padding:0 11px}
.op{display:inline-block;min-width:54px;padding:2px 7px;border-radius:5px;background:rgba(255,255,255,.06);color:var(--text-2);font:600 11.5px var(--mono);text-align:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:20px}
.stat{background:var(--panel);padding:13px 16px 12px}
.stat .k{font-size:11px;font-weight:700;letter-spacing:.7px;text-transform:uppercase;color:var(--muted)}
.stat .v{margin-top:4px;font-size:22px;font-weight:750;letter-spacing:-.2px;white-space:nowrap}
.stat .v small{font-size:12.5px;font-weight:600;color:var(--muted);margin-left:4px}
.stat .n{margin-top:1px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:20px;align-items:start}
.side{display:flex;flex-direction:column;gap:16px;position:sticky;top:72px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.panel>h2,.ph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px;font-weight:750;letter-spacing:.2px}
.panel>h2 span,.ph span{color:var(--muted);font-weight:600;font-size:12px}
.pb{padding:14px 16px}
.empty{padding:22px 16px;color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:13px}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
tr.link{cursor:pointer}
tr.link:hover td{background:rgba(255,255,255,.025)}
.muted{color:var(--muted)}
.faint{color:var(--faint)}
.ok{color:var(--ok)}
.bad{color:var(--bad)}
.ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shot{position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--line-2);background:#000;line-height:0}
.shot img{width:100%;height:auto;display:block}
.shot .bx{position:absolute;border:2px solid var(--c,var(--replay));border-radius:4px;box-shadow:0 0 0 3px color-mix(in srgb,var(--c,var(--replay)) 25%,transparent)}
.shot .pt{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:var(--c,var(--cu));color:#0b0d12;font:800 11px/22px var(--sans);text-align:center;box-shadow:0 0 0 2px #fff,0 3px 8px rgba(0,0,0,.5)}
.shot .cap{position:absolute;left:8px;bottom:8px;padding:3px 8px;border-radius:6px;background:rgba(10,12,16,.85);color:#fff;font:600 11.5px/1.3 var(--sans)}
figure{margin:0}
.steps{list-style:none;margin:0;padding:0}
.st{display:grid;grid-template-columns:34px 64px minmax(0,1fr) 150px 120px;gap:0 12px;align-items:start;padding:11px 16px;border-bottom:1px solid var(--line)}
.st:last-child{border-bottom:0}
.st .i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:800;font-size:12px;color:#0b0d12;background:var(--c,var(--replay))}
.st .what{min-width:0}
.st .what b{font-weight:650}
.st .what .t{color:var(--text-2);font-size:12.5px;margin-top:2px}
.st .what .val{font-family:var(--mono);font-size:12px;color:#d9f99d}
.st .what .tpl{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.st .what .err{margin-top:5px;color:var(--bad);font-size:12.5px}
.st .what .chg{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12px;color:var(--text-2)}
.st .rung{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.bar{height:6px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;border-radius:3px;background:var(--c,var(--replay))}
.ms{font-size:12.5px;font-weight:650;text-align:right}
.batch{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;padding:16px;border-bottom:1px solid var(--line)}
.batch:last-child{border-bottom:0}
.bh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:12.5px;color:var(--muted)}
.bh b{color:var(--text);font-size:13px}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.act{display:grid;grid-template-columns:24px minmax(0,1fr);gap:9px}
.act .n{width:22px;height:22px;border-radius:50%;background:var(--c,var(--cu));color:#0b0d12;font:800 11px/22px var(--sans);text-align:center}
.act .d{font-size:13px}
.act .d b{font-weight:650}
.cands{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.cand{font:500 11px/1.35 var(--mono);padding:2px 6px;border-radius:5px;background:rgba(255,255,255,.05);border:1px solid var(--line);color:var(--text-2);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cand em{font-style:normal;color:var(--muted)}
.tags{display:inline-flex;gap:5px;margin-left:6px;vertical-align:1px}
.tag{font-size:10.5px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;padding:1px 6px;border-radius:4px;background:rgba(255,255,255,.07);color:var(--text-2)}
.tag.commit{background:color-mix(in srgb,var(--ok) 18%,transparent);color:var(--ok)}
.tag.blocked{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.tag.noise{color:var(--faint)}
.rb td:first-child{color:var(--text-2)}
.rb td.v{font-family:var(--mono);font-size:12px;color:#fff}
.rb .ic{width:18px;height:18px;border-radius:50%;display:inline-grid;place-items:center;font-size:11px;font-weight:900;color:#0b0d12}
.rb .ic.ok{background:var(--ok)}
.rb .ic.bad{background:var(--bad)}
.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:7px 12px;font-size:13px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.code{margin:0;padding:14px 16px;overflow:auto;max-height:640px;background:#0c0f14;font:12.5px/1.6 var(--mono);color:#d6dde8;tab-size:2}
.code .k{color:#c4b5fd}.code .s{color:#86efac}.code .n{color:#fcd34d}.code .c{color:#64748b;font-style:italic}.code .p{color:#7dd3fc}.code .f{color:#67e8f9}.code .b{color:#f9a8d4}
.tabs{display:flex;gap:4px}
.tabs button{all:unset;cursor:pointer;padding:5px 10px;border-radius:7px;font-size:12.5px;font-weight:650;color:var(--text-2)}
.tabs button.on{background:rgba(255,255,255,.08);color:#fff}
.diff{list-style:none;margin:0;padding:6px 0}
.diff li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:13.5px}
.diff li .m{font:800 14px/1.2 var(--mono)}
.diff li.add .m{color:var(--ok)}.diff li.del .m{color:var(--bad)}.diff li.chg .m{color:var(--heal)}.diff li.inf .m{color:var(--muted)}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);gap:10px;align-items:center;padding:12px 16px;border-top:1px solid var(--line)}
.pair .side-a,.pair .side-b{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--panel-2);min-width:0}
.pair .side-a{border-color:color-mix(in srgb,var(--bad) 40%,transparent)}
.pair .side-b{border-color:color-mix(in srgb,var(--ok) 40%,transparent)}
.pair .arrow{text-align:center;color:var(--heal);font-size:18px;font-weight:800}
.pair h4{margin:0 0 5px;font-size:12px;color:var(--muted);font-weight:700}
.versions{display:flex;gap:8px;flex-wrap:wrap}
.ver{display:flex;flex-direction:column;gap:2px;min-width:150px;padding:10px 12px;border-radius:11px;border:1px solid var(--line);background:var(--panel)}
.ver.on{border-color:color-mix(in srgb,var(--replay) 60%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--replay) 14%,transparent)}
.ver b{font-size:15px}
.ver span{font-size:12px;color:var(--muted)}
.film{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 16px}
.film figure{position:relative}
.film img{width:100%;border-radius:8px;border:1px solid var(--line-2);display:block}
.film figcaption{position:absolute;left:6px;top:6px;padding:1px 6px;border-radius:5px;background:rgba(10,12,16,.85);font:700 11px var(--mono)}
.dsteps{list-style:none;margin:0;padding:6px 0;counter-reset:s}
.dsteps li{counter-increment:s;display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:13.5px}
.dsteps li::before{content:counter(s);width:22px;height:22px;border-radius:50%;display:grid;place-items:center;background:rgba(167,139,250,.16);color:var(--cu);font-weight:800;font-size:11.5px}
.pchip{display:inline-block;padding:0 6px;border-radius:5px;background:color-mix(in srgb,var(--cu) 18%,transparent);color:#ddd6fe;font:600 12px/1.55 var(--mono)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px;background:var(--c)}
.foot{margin-top:28px;color:var(--faint);font-size:12px}
@media (max-width:1180px){.grid{grid-template-columns:minmax(0,1fr)}.side{position:static}.batch{grid-template-columns:minmax(0,1fr)}.st{grid-template-columns:30px 56px minmax(0,1fr) 110px}.st .ms-col{display:none}}
`;

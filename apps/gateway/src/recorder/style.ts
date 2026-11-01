// Flight recorder styles: the same light, editorial language as the demo HUD (packages/browser/src/hud). Paper,
// white surfaces, ink and one gray; the accent #FF4F00 marks only what Dockhand did (a pick, a patched line), at
// most once per screen; the error red only a real failure. Geist and Geist Mono are served by the recorder itself
// (fonts/), so a page needs nothing from the network.

export const RECORDER_CSS = `
:root{
  --paper:#F6F5F1;--surface:#FFFFFF;--ink:#111111;--gray:#6B6B6B;--hair:#E3E1DB;--accent:#FF4F00;--error:#B42318;
  --bg:var(--paper);--panel:var(--surface);--panel-2:#FBFAF7;--line:var(--hair);--line-2:#D6D3CB;
  --text:var(--ink);--text-2:#2B2B2B;--muted:var(--gray);--faint:#9A988F;
  --cu:var(--ink);--replay:var(--ink);--heal:var(--ink);--dry:var(--gray);--wait:var(--gray);--ok:var(--ink);--bad:var(--error);
  --mono:"Geist Mono",ui-monospace,Consolas,monospace;
  --sans:"Geist","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  color-scheme:light;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--text)}
body{font:15px/1.5 var(--sans);-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
code,pre,.mono{font-family:var(--mono);font-size:13px}
h1,h2,h3,p{margin:0}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:18px;height:56px;padding:0 32px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:10px;font-weight:600;font-size:16px;letter-spacing:-.02em}
.brand small{font-weight:500;color:var(--muted);font-size:14px;letter-spacing:0;padding-left:12px;border-left:1px solid var(--line)}
.nav{display:flex;gap:4px;margin-left:12px}
.nav a{padding:6px 11px;border-radius:7px;color:var(--muted);font-weight:500;font-size:14px}
.nav a:hover,.nav a.on{color:var(--ink);background:var(--paper);text-decoration:none}
.top .note{margin-left:auto;color:var(--muted);font-size:13px}
.wrap{max-width:1680px;margin:0 auto;padding:26px 32px 60px}
.crumbs{color:var(--muted);font-size:13px;margin-bottom:8px}
.crumbs a{color:var(--text-2)}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:20px}
.title{font-size:30px;font-weight:600;letter-spacing:-.02em;line-height:1.15;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.sub{margin-top:6px;color:var(--muted);font-size:14px}
.chip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:6px;font-size:12.5px;font-weight:500;white-space:nowrap;border:1px solid var(--line);color:var(--c,var(--ink));background:var(--surface)}
.chip.dot::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.chip.lg{height:28px;font-size:14px;padding:0 11px}
.op{display:inline-block;min-width:54px;padding:2px 7px;border-radius:5px;background:var(--paper);color:var(--text-2);font:500 12px var(--mono);text-align:center}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:22px}
.stat{background:var(--panel);padding:14px 16px 13px}
.stat .k{font-size:13px;font-weight:500;color:var(--muted)}
.stat .v{margin-top:4px;font-size:24px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}
.stat .v small{font-size:13px;font-weight:500;color:var(--muted);margin-left:4px;letter-spacing:0}
.stat .n{margin-top:1px;font-size:12.5px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 440px;gap:22px;align-items:start}
.side{display:flex;flex-direction:column;gap:16px;position:sticky;top:76px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.panel>h2,.ph{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:13px 16px;border-bottom:1px solid var(--line);font-size:15px;font-weight:600;letter-spacing:-.01em}
.panel>h2 span,.ph span{color:var(--muted);font-weight:500;font-size:13px;letter-spacing:0}
.pb{padding:14px 16px}
.empty{padding:22px 16px;color:var(--muted);font-size:14px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:12.5px;font-weight:500;color:var(--muted);padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
tr.link{cursor:pointer}
tr.link:hover td{background:var(--paper)}
.muted{color:var(--muted)}
.faint{color:var(--faint)}
.ok{color:var(--ink)}
.bad{color:var(--error)}
.ellip{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.shot{position:relative;border-radius:8px;overflow:hidden;border:1px solid var(--line);background:var(--surface);line-height:0}
.shot img{width:100%;height:auto;display:block}
.shot .bx{position:absolute;border:2px solid var(--ink);border-radius:4px}
.shot .pt{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:var(--ink);color:#fff;font:600 11px/22px var(--sans);text-align:center;box-shadow:0 0 0 2px #fff}
.shot .cap{position:absolute;left:8px;bottom:8px;padding:3px 8px;border-radius:6px;background:var(--surface);border:1px solid var(--line);color:var(--ink);font:500 12px/1.3 var(--sans)}
figure{margin:0}
.steps{list-style:none;margin:0;padding:0}
.st{display:grid;grid-template-columns:34px 64px minmax(0,1fr) 170px 120px;gap:0 12px;align-items:start;padding:11px 16px;border-bottom:1px solid var(--line)}
.st:last-child{border-bottom:0}
.st .i{width:26px;height:26px;border-radius:50%;display:grid;place-items:center;font-weight:600;font-size:12px;color:#fff;background:var(--c,var(--ink))}
.st .what{min-width:0}
.st .what b{font-weight:600}
.st .what .t{color:var(--text-2);font-size:13px;margin-top:2px}
.st .what .val{font-family:var(--mono);font-size:12.5px;color:var(--ink)}
.st .what .tpl{font-family:var(--mono);font-size:12px;color:var(--muted)}
.st .what .err{margin-top:5px;color:var(--error);font-size:13px}
.st .what .chg{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:12.5px;color:var(--text-2)}
.st .rung{display:flex;flex-direction:column;gap:4px;align-items:flex-start}
.bar{height:4px;border-radius:2px;background:var(--paper);overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;border-radius:2px;background:var(--line-2)}
.ms{font-size:13px;font-weight:500;text-align:right}
.batch{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:16px;padding:16px;border-bottom:1px solid var(--line)}
.batch:last-child{border-bottom:0}
.bh{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;font-size:13px;color:var(--muted)}
.bh b{color:var(--text);font-size:14px}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.act{display:grid;grid-template-columns:24px minmax(0,1fr);gap:9px}
.act .n{width:22px;height:22px;border-radius:50%;background:var(--c,var(--ink));color:#fff;font:600 11px/22px var(--sans);text-align:center}
.act .d{font-size:14px}
.act .d b{font-weight:600}
.cands{display:flex;flex-wrap:wrap;gap:5px;margin-top:5px}
.cand{font:400 12px/1.4 var(--mono);padding:2px 6px;border-radius:5px;background:var(--paper);border:1px solid var(--line);color:var(--text-2);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cand em{font-style:normal;color:var(--muted)}
.tags{display:inline-flex;gap:5px;margin-left:6px;vertical-align:1px}
.tag{font-size:12px;font-weight:500;padding:1px 6px;border-radius:4px;background:var(--paper);border:1px solid var(--line);color:var(--text-2)}
.tag.commit{color:var(--ink);border-color:var(--ink)}
.tag.blocked{color:var(--error);border-color:var(--error)}
.tag.noise{color:var(--faint)}
.rb td:first-child{color:var(--text-2)}
.rb td.v{font-family:var(--mono);font-size:13px;color:var(--ink)}
.rb .ic{width:18px;height:18px;border-radius:50%;display:inline-grid;place-items:center;font-size:11px;font-weight:700;color:#fff}
.rb .ic.ok{background:var(--ink)}
.rb .ic.bad{background:var(--error)}
.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:7px 12px;font-size:14px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.code{margin:0;padding:14px 16px;overflow:auto;max-height:640px;background:var(--panel-2);font:13px/1.6 var(--mono);color:var(--ink);tab-size:2}
.code .k,.editor .k{color:#5B3FA8}.code .s,.editor .s{color:#1F6F43}.code .n,.editor .n{color:#9A5B00}.code .c,.editor .c{color:#8A877F;font-style:italic}.code .p,.editor .p{color:#1D5C8C}.code .f,.editor .f{color:#111111;font-weight:500}.code .b,.editor .b{color:#9A5B00}
.tabs{display:flex;gap:4px}
.tabs button{all:unset;cursor:pointer;padding:5px 10px;border-radius:7px;font-size:13px;font-weight:500;color:var(--muted)}
.tabs button.on{background:var(--paper);color:var(--ink)}
.diff{list-style:none;margin:0;padding:6px 0}
.diff li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:14px}
.diff li .m{font:600 14px/1.2 var(--mono)}
.diff li.add .m{color:var(--ink)}.diff li.del .m{color:var(--error)}.diff li.chg .m{color:var(--ink)}.diff li.inf .m{color:var(--muted)}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 28px minmax(0,1fr);gap:10px;align-items:center;padding:12px 16px;border-top:1px solid var(--line)}
.pair .side-a,.pair .side-b{border:1px solid var(--line);border-radius:10px;padding:9px 11px;background:var(--panel-2);min-width:0}
.pair .side-b{border-color:var(--ink)}
.pair .arrow{text-align:center;color:var(--muted);font-size:18px;font-weight:600}
.pair h4{margin:0 0 5px;font-size:12.5px;color:var(--muted);font-weight:500}
.versions{display:flex;gap:8px;flex-wrap:wrap}
.ver{display:flex;flex-direction:column;gap:2px;min-width:150px;padding:10px 12px;border-radius:10px;border:1px solid var(--line);background:var(--panel)}
.ver.on{border-color:var(--ink)}
.ver b{font-size:16px;font-weight:600}
.ver span{font-size:12.5px;color:var(--muted)}
.film{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:14px 16px}
.film figure{position:relative}
.film img{width:100%;border-radius:6px;border:1px solid var(--line);display:block}
.film figcaption{position:absolute;left:6px;top:6px;padding:1px 6px;border-radius:5px;background:var(--surface);border:1px solid var(--line);font:500 11.5px var(--mono)}
.dsteps{list-style:none;margin:0;padding:6px 0;counter-reset:s}
.dsteps li{counter-increment:s;display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;padding:7px 16px;font-size:14px}
.dsteps li::before{content:counter(s);width:22px;height:22px;border-radius:50%;display:grid;place-items:center;border:1px solid var(--line);color:var(--muted);font-weight:500;font-size:12px}
.pchip{display:inline-block;padding:0 6px;border-radius:5px;background:var(--paper);border:1px solid var(--line);color:var(--ink);font:500 12.5px/1.55 var(--mono)}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-size:13px;color:var(--muted)}
.legend i{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:var(--c)}
.foot{margin-top:28px;color:var(--faint);font-size:13px}
@media (max-width:1180px){.grid{grid-template-columns:minmax(0,1fr)}.side{position:static}.batch{grid-template-columns:minmax(0,1fr)}.st{grid-template-columns:30px 56px minmax(0,1fr) 120px}.st .ms-col{display:none}}
`;

/** @font-face rules for Geist and Geist Mono, served by the recorder at `<base>fonts/`. */
export function fontCss(base: string): string {
  return `@font-face{font-family:"Geist";src:url("${base}fonts/geist.woff2") format("woff2");font-weight:100 900;font-display:block}
@font-face{font-family:"Geist Mono";src:url("${base}fonts/geist-mono.woff2") format("woff2");font-weight:100 900;font-display:block}`;
}

// Flight recorder styles: Dockhand's black ground, white text and hairlines (the palette of packages/design/src/
// tokens.ts), Archivo for reading, Geist Mono for real code and selectors. Orange marks what Dockhand did (a pick, a
// patch), once per screen; the error red only a real failure. Status is a word, never a pill. The fonts are served by
// the recorder itself (fonts/), so a page needs nothing from the network.

export const RECORDER_CSS = `
:root{
  --ground:#0A0A0A;--surface:#171717;--text:#FFFFFF;--gray:#A3A3A3;--faint:#6F6F6F;--hair:#2A2A2A;--rule:#404040;
  --accent:#FF4F00;--on-accent:#0A0A0A;--error:#FF5C4D;
  --cu:var(--text);--replay:var(--text);--heal:var(--text);--dry:var(--gray);--wait:var(--gray);--ok:var(--text);--bad:var(--error);
  --mono:"Geist Mono",ui-monospace,Consolas,monospace;
  --sans:"Archivo","Segoe UI",system-ui,sans-serif;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--ground);color:var(--text)}
body{font:500 16px/1.4 var(--sans);letter-spacing:-.01em;-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
code,pre,.mono{font-family:var(--mono);font-size:13.5px;letter-spacing:-.01em}
h1,h2,h3,p{margin:0}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:32px;height:64px;padding:0 40px;background:var(--ground);border-bottom:1px solid var(--hair)}
.brand{display:flex;align-items:center;gap:9px;font-weight:700;font-size:21px;letter-spacing:-.035em}
.brand:hover{text-decoration:none}
.brand svg{height:18px;width:auto;fill:currentColor;display:block}
.brand small{font-weight:500;color:var(--gray);font-size:16px;letter-spacing:-.01em;margin-left:6px}
.nav{display:flex;gap:24px}
.nav a{color:var(--gray);font-size:16px}
.nav a:hover,.nav a.on{color:var(--text);text-decoration:none}
.top .note{margin-left:auto;color:var(--gray);font-size:14px}
.wrap{max-width:1680px;margin:0 auto;padding:40px 40px 80px}
.crumbs{color:var(--gray);font-size:14px;margin-bottom:12px}
.crumbs a{color:var(--text)}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:32px;margin-bottom:32px}
.title{font-size:48px;font-weight:700;letter-spacing:-.04em;line-height:1.05;display:flex;align-items:baseline;gap:8px 20px;flex-wrap:wrap}
.sub{margin-top:10px;color:var(--gray);font-size:17px;max-width:900px}
.chip{font-size:14px;font-weight:500;letter-spacing:-.01em;white-space:nowrap;color:var(--c,var(--text))}
.chip.lg{font-size:20px;font-weight:500}
.op{font:400 13.5px var(--mono);color:var(--gray)}
.stats{display:flex;flex-wrap:wrap;gap:20px 56px;padding:20px 0 24px;margin-bottom:32px;border-top:1px solid var(--hair);border-bottom:1px solid var(--hair)}
.stat .k{font-size:14px;color:var(--gray)}
.stat .v{margin-top:2px;font-size:32px;font-weight:700;letter-spacing:-.04em;line-height:1.1;white-space:nowrap}
.stat .v small{font-size:17px;font-weight:500;color:var(--gray);margin-left:4px;letter-spacing:-.01em}
.stat .n{margin-top:2px;font-size:13.5px;color:var(--gray);overflow-wrap:anywhere}
.grid{display:grid;grid-template-columns:minmax(0,1fr) 460px;gap:56px;align-items:start}
.side{display:flex;flex-direction:column;gap:32px;position:sticky;top:96px}
.panel{border-top:1px solid var(--text)}
.panel>h2,.ph{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:14px 0;font-size:24px;font-weight:700;letter-spacing:-.035em;line-height:1.15}
.panel>h2 span,.ph span{color:var(--gray);font-weight:500;font-size:15px;letter-spacing:-.01em}
.pb{padding:4px 0 16px}
.empty{padding:16px 0;color:var(--gray);font-size:16px}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:13.5px;font-weight:500;color:var(--gray);padding:8px 16px 8px 0;border-bottom:1px solid var(--hair);white-space:nowrap}
td{padding:10px 16px 10px 0;border-bottom:1px solid var(--hair);vertical-align:top;font-size:15px}
td:last-child,th:last-child{padding-right:0}
tr:last-child td{border-bottom:0}
td.num,th.num{text-align:right}
tr.link{cursor:pointer}
tr.link:hover td{background:var(--surface)}
.muted{color:var(--gray)}
.faint{color:var(--faint)}
.ok{color:var(--text)}
.bad{color:var(--error)}
.shot{position:relative;overflow:hidden;background:var(--surface);line-height:0}
.shot img{width:100%;height:auto;display:block}
.shot .bx{position:absolute;border:2px solid var(--ground)}
.shot .pt{position:absolute;width:22px;height:22px;margin:-11px 0 0 -11px;background:var(--ground);color:var(--text);font:600 12px/22px var(--sans);text-align:center}
.shot .cap{position:absolute;left:8px;bottom:8px;padding:3px 8px;background:var(--ground);color:var(--text);font:500 13px/1.3 var(--sans)}
figure{margin:0}
.steps{list-style:none;margin:0;padding:0}
.st{display:grid;grid-template-columns:30px 64px minmax(0,1fr) 236px 90px;gap:0 16px;align-items:start;padding:12px 0;border-top:1px solid var(--hair)}
.st .i{font-weight:600;font-size:15px;color:var(--c,var(--text))}
.st .what{min-width:0}
.st .what b{font-weight:600}
.st .what .t{color:var(--gray);font-size:14px;margin-top:2px}
.st .what .val{font-family:var(--mono);font-size:13.5px;color:var(--text)}
.st .what .tpl{font-family:var(--mono);font-size:13px;color:var(--gray)}
.st .what .err{margin-top:6px;color:var(--error);font-size:14px}
.st .what .chg{margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:13.5px;color:var(--gray)}
.st .rung{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.bar{height:2px;background:var(--hair);overflow:hidden;margin-top:8px}
.bar i{display:block;height:100%;background:var(--text)}
.ms{font-size:14px;text-align:right}
.batch{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:24px;padding:20px 0;border-top:1px solid var(--hair)}
.bh{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:10px;font-size:14px;color:var(--gray)}
.bh b{color:var(--text);font-size:17px;font-weight:700;letter-spacing:-.03em}
.acts{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:12px}
.act{display:grid;grid-template-columns:24px minmax(0,1fr);gap:8px}
.act .n{color:var(--c,var(--text));font:600 15px/1.4 var(--sans)}
.act .d{font-size:15px}
.act .d b{font-weight:600}
.cands{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.cand{font:400 12.5px/1.45 var(--mono);padding:1px 6px;background:var(--surface);color:var(--gray);max-width:100%;overflow-wrap:anywhere}
.cand em{font-style:normal;color:var(--faint)}
.tags{display:inline-flex;gap:6px;margin-left:8px;vertical-align:1px}
.tag{font-size:13px;color:var(--gray)}
.tag.commit{color:var(--text)}
.tag.blocked{color:var(--error)}
.tag.noise{color:var(--faint)}
.rb td:first-child{color:var(--gray)}
.rb td.v{font-family:var(--mono);font-size:13.5px;color:var(--text)}
.rb .ic{font-size:14px;font-weight:600;color:var(--text)}
.rb .ic.ok{color:var(--text)}
.rb .ic.bad{color:var(--error)}
.kv{display:grid;grid-template-columns:132px minmax(0,1fr);gap:8px 12px;font-size:15px}
.kv dt{color:var(--gray)}
.kv dd{margin:0;min-width:0;overflow-wrap:anywhere}
.code{margin:0;padding:16px;overflow:auto;max-height:640px;background:var(--surface);font:14px/1.6 var(--mono);color:var(--text);tab-size:2}
.code .k,.editor .k{color:var(--gray)}.code .s,.editor .s{color:var(--text)}.code .n,.editor .n{color:var(--text)}.code .c,.editor .c{color:var(--faint)}.code .p,.editor .p{color:var(--gray)}.code .f,.editor .f{color:var(--text);font-weight:500}.code .b,.editor .b{color:var(--gray)}
.tabs{display:flex;gap:16px}
.tabs button{all:unset;cursor:pointer;font-size:15px;color:var(--gray)}
.tabs button.on{color:var(--text)}
.diff{list-style:none;margin:0;padding:0 0 8px}
.diff li{display:grid;grid-template-columns:20px minmax(0,1fr);gap:8px;padding:6px 0;font-size:15px}
.diff li .m{font:500 15px/1.4 var(--mono)}
.diff li.add .m{color:var(--text)}.diff li.del .m{color:var(--error)}.diff li.chg .m{color:var(--text)}.diff li.inf .m{color:var(--gray)}
.pair{display:grid;grid-template-columns:minmax(0,1fr) 40px minmax(0,1fr);gap:12px;align-items:center;padding:12px 0;border-top:1px solid var(--hair)}
.pair .side-a,.pair .side-b{padding:10px 12px;background:var(--surface);min-width:0}
.pair .arrow{text-align:center;color:var(--gray);font-size:15px}
.pair h4{margin:0 0 4px;font-size:13.5px;color:var(--gray);font-weight:500}
.versions{display:flex;gap:40px;flex-wrap:wrap}
.ver{display:flex;flex-direction:column;gap:2px;padding-top:10px;border-top:2px solid var(--hair)}
.ver:hover{text-decoration:none}
.ver.on{border-top-color:var(--text)}
.ver b{font-size:24px;font-weight:700;letter-spacing:-.035em}
.ver span{font-size:14px;color:var(--gray)}
.film{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;padding:4px 0 16px}
.film figure{position:relative}
.film img{width:100%;display:block}
.film figcaption{position:absolute;left:6px;top:6px;padding:1px 6px;background:var(--ground);font:500 13px var(--sans)}
.dsteps{list-style:none;margin:0;padding:0 0 8px;counter-reset:s}
.dsteps li{counter-increment:s;display:grid;grid-template-columns:30px minmax(0,1fr);gap:8px;padding:8px 0;font-size:16px;border-top:1px solid var(--hair)}
.dsteps li::before{content:counter(s);color:var(--gray)}
.pchip{display:inline-block;padding:0 5px;background:var(--surface);color:var(--text);font:400 13.5px/1.55 var(--mono)}
.legend{display:flex;gap:16px;flex-wrap:wrap;font-size:14px;color:var(--gray)}
.legend i{display:inline-block;width:14px;height:2px;margin:0 6px 4px 0;background:var(--c)}
.foot{margin-top:32px;color:var(--faint);font-size:14px}
@media (max-width:1180px){.grid{grid-template-columns:minmax(0,1fr)}.side{position:static}.batch{grid-template-columns:minmax(0,1fr)}.st{grid-template-columns:30px 56px minmax(0,1fr) 120px}.st .ms-col{display:none}}
`;

/** @font-face rules for Archivo and Geist Mono, served by the recorder at `<base>fonts/`. */
export function fontCss(base: string): string {
  return `@font-face{font-family:"Archivo";src:url("${base}fonts/archivo.woff2") format("woff2");font-weight:100 900;font-stretch:62% 125%;font-display:block}
@font-face{font-family:"Geist Mono";src:url("${base}fonts/geist-mono.woff2") format("woff2");font-weight:100 900;font-display:block}`;
}

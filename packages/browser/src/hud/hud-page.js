// biome-ignore-all lint: in-page script (plain ES2022, serialized into every page as an init script).
// biome-ignore-all format: kept compact on purpose.
// hud-page.js: Dockhand's demo overlay (DEMO_MODE only). Drawn for the camera, invisible to automation:
// - one <dockhand-hud> host appended to <html> (outside <body>, so body.innerText and body locators never see it),
//   with a CLOSED shadow root (Playwright selectors, Playwright's screenshot style injection and the capture script
//   cannot reach inside), pointer-events:none on everything (elementFromPoint skips it), aria-hidden and inert
//   (no focus, not in the accessibility tree);
// - never touches page elements: markers follow elements by reading getBoundingClientRect each frame;
// - every motion is driven by requestAnimationFrame, not CSS animations, so screenshots taken with
//   animations:"disabled" (which finish or cancel document animations) leave it alone;
// - no network requests: Geist is inlined by hud.ts and registered under its own family names, which no page uses;
//   no globals except a non-enumerable window.__dockhandHud.
//
// Look (one design spec for the HUD and the flight recorder): light and editorial. Paper #F6F5F1, surface #FFF,
// ink #111, gray #6B6B6B, hairline #E3E1DB; one accent #FF4F00, only where Dockhand acts (the active step, the
// repaired element), at most once on screen; error #B42318 only for a real failure. Geist 600 for display at -2%
// tracking, Geist Mono for IDs, tabular figures. Overlays fade in over 150 ms; click ripples are gone in 360 ms.
// Sizes: what the viewer must read is 30 px or more (40 px in a 1080p frame once the 1280x800 page fills its
// height), and everything sits inside the area a 1.15x push-in keeps (84 px from the sides, 52 px from top/bottom).
(() => {
  if (window.__dockhandHud) return;

  const FONTS = /*__DOCKHAND_FONTS__*/null;
  // The palette of @dockhand/design (packages/design/src/tokens.ts).
  const C = { paper: '#F6F5F1', surface: '#FFFFFF', ink: '#111111', gray: '#6B6B6B', faint: '#8F8C85', hair: '#E3E1DB', rule: '#CFCCC4', accent: '#FF4F00', error: '#B42318' };
  const SAFE = { x: 84, y: 52 };
  const FADE = 150;
  const css = `
:host{all:initial}
*{box-sizing:border-box}
.root{position:fixed;inset:0;pointer-events:none;overflow:hidden;font:500 20px/1.25 "Dockhand Geist","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;color:${C.ink};-webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.root *{pointer-events:none}
.mono{font-family:"Dockhand Geist Mono",ui-monospace,Consolas,monospace;letter-spacing:0}
.card{position:absolute;left:0;top:0;background:${C.surface};border:1px solid ${C.rule};border-top:2px solid ${C.ink};border-radius:2px;opacity:0}
.strip{right:${SAFE.x}px;top:${SAFE.y}px;left:auto;max-width:700px;padding:13px 22px 14px}
.s1{display:flex;align-items:baseline;gap:14px;white-space:nowrap;min-width:0}
.stage{font-weight:600;font-size:30px;line-height:1.15;letter-spacing:-.02em}
.stage.fail{color:${C.error}}
.model{font-weight:500;font-size:30px;line-height:1.15;letter-spacing:-.02em;color:${C.gray};min-width:0}
.model.mono{font-weight:500;font-size:28px;color:${C.ink};letter-spacing:-.01em}
.s2{display:flex;align-items:baseline;gap:26px;margin-top:6px;font-size:30px;font-weight:500;line-height:1.15;letter-spacing:-.01em;white-space:nowrap}
.s2 .held{color:${C.gray}}
.s2 .fact.bad{color:${C.error}}
.s3{margin-top:8px;font-size:20px;line-height:1.35;color:${C.gray};max-width:654px}
.s3:empty{display:none}
.cursor{position:absolute;left:0;top:0;width:0;height:0;opacity:0;will-change:transform}
.cursor svg{position:absolute;left:-3px;top:-2px;width:26px;height:30px}
.ripple{position:absolute;left:0;top:0;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:2px;border:2px solid ${C.ink}}
.outline{position:absolute;left:0;top:0;border-radius:2px;border:2px solid var(--c)}
.outline.dash{border-style:dashed}
.tag{position:absolute;left:0;top:0;padding:6px 12px 7px;border-radius:2px;background:${C.surface};border:1px solid ${C.rule};color:${C.ink};font-size:22px;font-weight:600;letter-spacing:-.01em;max-width:560px}
.tag .sub{display:block;margin-top:1px;font-size:18px;font-weight:500;color:${C.gray}}
.tag.ink{background:${C.ink};border-color:${C.ink};color:#fff}.tag.ink .sub{color:#c9c7c1}
.tag.fail{color:${C.error}}
.mark{position:absolute;left:0;top:0;height:3px;background:${C.ink}}
.mark.free{background:${C.rule}}
.mark.bad{background:${C.error}}
.scrim{position:absolute;inset:0;width:100%;height:100%;opacity:0}
.spot{width:620px;padding:20px 24px 18px}
.sh{font-size:30px;font-weight:600;line-height:1.15;letter-spacing:-.02em}
.ss{margin-top:4px;font-size:22px;line-height:1.3;color:${C.gray}}
.rungs{margin-top:14px;border-top:1px solid ${C.hair}}
.rung{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;column-gap:16px;padding:9px 0 8px;border-bottom:1px solid ${C.hair}}
.rung .rn{font-size:28px;font-weight:600;letter-spacing:-.02em;line-height:1.15}
.rung .rs{font-size:24px;font-weight:600;letter-spacing:-.01em;text-align:right;white-space:nowrap}
.rung .rd{grid-column:1/-1;margin-top:2px;font-size:20px;color:${C.gray}}
.rung .rd:empty{display:none}
.rung.fail .rn,.rung.fail .rs{color:${C.gray};font-weight:500}
.rung.off .rn,.rung.na .rn,.rung.off .rs,.rung.na .rs,.rung.pending .rs{color:${C.faint};font-weight:500}
.rung.ok .rs{color:${C.ink}}
.pick{margin-top:16px}
.pick .ph{font-size:30px;font-weight:600;line-height:1.15;letter-spacing:-.02em}
.pick .pr{margin-top:8px;font-size:24px;line-height:1.3;color:${C.ink}}
.pick .pm{margin-top:10px;font-size:22px;color:${C.gray}}
.verified{margin-top:14px;padding-top:12px;border-top:1px solid ${C.ink};font-size:24px;line-height:1.3;font-weight:500;letter-spacing:-.01em}
.verified b{font-weight:600}
.verified.fail b{color:${C.gray}}
.rb{width:560px;padding:20px 24px 14px}
.rows{margin-top:12px;border-top:1px solid ${C.hair}}
.row{display:grid;grid-template-columns:minmax(0,190px) minmax(0,1fr) auto;align-items:baseline;gap:14px;padding:5px 0 4px;border-bottom:1px solid ${C.hair};opacity:.32}
.row.on{opacity:1}
.row .rl{font-size:18px;color:${C.gray};line-height:1.25}
.row .rv{font-size:21px;line-height:1.25;overflow-wrap:anywhere}
.row .rv.bad{color:${C.error}}
.row .rc{font-size:18px;font-weight:600;opacity:0;white-space:nowrap}
.row.on .rc{opacity:1}
.row .rc.bad{color:${C.error}}
.row.cur{box-shadow:inset 3px 0 0 ${C.accent}}
.hint{position:absolute;left:0;top:0;padding:6px 12px;border-radius:2px;background:${C.surface};border:1px solid ${C.rule};color:${C.ink};font-size:22px;font-weight:600;white-space:nowrap}
.flash{position:absolute;inset:0;opacity:0;box-shadow:inset 0 0 0 3px ${C.ink}}
`;
  const ARROW = '<svg viewBox="0 0 26 30"><path d="M2.5 2v22.4l6-5.7 4 8.9 3.8-1.7-3.9-8.7h8.3z" fill="#111111" stroke="#FFFFFF" stroke-width="1.6" stroke-linejoin="round"/></svg>';

  function loadFonts() {
    if (!FONTS || typeof FontFace !== 'function' || !document.fonts) return;
    for (const [family, b64] of [['Dockhand Geist', FONTS.sans], ['Dockhand Geist Mono', FONTS.mono]]) {
      try {
        const bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const face = new FontFace(family, bytes, { weight: '100 900', style: 'normal' });
        document.fonts.add(face);
        face.load().catch(() => {});
      } catch {}
    }
  }
  try { loadFonts(); } catch {}

  let host = null, root = null, ui = null;
  let state = null;                 // last view() payload
  const items = new Map();          // key -> { update(now) -> bool (false = remove), remove() }
  const anims = new Set();          // one-shot animations
  let running = false;
  const cur = { x: 640, y: 420, shown: false, tween: null };
  let spotCard = null, rbCard = null;
  const cards = new Set();          // every card on screen, closing ones included
  const scrim = { on: false, op: 0, from: 0, t0: 0 };

  const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const now = () => performance.now();
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };
  const txt = (tag, cls, text) => { const e = el(tag, cls); e.textContent = text == null ? '' : String(text); return e; };

  function mount() {
    if (host && host.isConnected) return true;
    const parent = document.documentElement;
    if (!parent) return false;
    if (!host) {
      host = document.createElement('dockhand-hud');
      host.setAttribute('aria-hidden', 'true');
      host.inert = true;
      // Layout props are pinned inline; opacity/visibility are left to stylesheets so the screenshot style
      // (HUD_HIDE_CSS, !important) can hide it. :host{all:initial} below resets inherited page styles.
      host.style.cssText = 'position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:strict!important;display:block!important;margin:0!important;transform:none!important;filter:none!important';
      root = host.attachShadow({ mode: 'closed' });
      const style = el('style'); style.textContent = css; root.appendChild(style);
      const r = el('div', 'root');
      const svgNS = 'http://www.w3.org/2000/svg';
      const sc = document.createElementNS(svgNS, 'svg'); sc.setAttribute('class', 'scrim');
      const scPath = document.createElementNS(svgNS, 'path'); scPath.setAttribute('fill', C.paper); scPath.setAttribute('fill-opacity', '0.86'); scPath.setAttribute('fill-rule', 'evenodd');
      sc.appendChild(scPath);
      const under = el('div', 'layer');   // marks: dimmed with the page when the scrim is up
      const layer = el('div', 'layer');
      const top = el('div', 'layer');
      const cursor = el('div', 'cursor', ARROW);
      const strip = el('div', 'card strip', '<div class="s1"><span class="stage"></span><span class="model"></span></div><div class="s2"><span class="clock"></span><span class="cost"></span><span class="facts"></span></div><div class="s3"></div>');
      const flash = el('div', 'flash');
      r.append(under, sc, layer, top, cursor, strip, flash);
      root.appendChild(r);
      ui = { r, under, sc, scPath, layer, top, cursor, strip, flash,
        stage: strip.querySelector('.stage'), model: strip.querySelector('.model'),
        clock: strip.querySelector('.clock'), cost: strip.querySelector('.cost'), facts: strip.querySelector('.facts'),
        s3: strip.querySelector('.s3') };
    }
    parent.appendChild(host);       // after <body>: outside body.innerText, body locators and form ordinals
    if (state) render(state);
    kick();
    return true;
  }
  const ensure = () => mount();

  // ---------- frame loop ----------
  let lastClockText = '';
  let lastHref = location.href;
  function tick() {
    running = false;
    if (!host) return;
    if (!host.isConnected) mount();
    if (location.href !== lastHref) {
      lastHref = location.href;
      for (const [k, it] of items) if (it.target && !(it.target instanceof Element)) { it.remove(); items.delete(k); }
    }
    const t = now();
    let busy = false;
    if (cur.tween) {
      const tw = cur.tween, k = Math.min(1, (t - tw.t0) / tw.ms), e = ease(k);
      cur.x = tw.x0 + (tw.x1 - tw.x0) * e; cur.y = tw.y0 + (tw.y1 - tw.y0) * e;
      if (k >= 1) { cur.tween = null; tw.done(); for (const f of tw.after) f(); }
      busy = true;
    }
    if (ui) ui.cursor.style.transform = `translate(${cur.x.toFixed(1)}px,${cur.y.toFixed(1)}px)`;
    for (const a of anims) { if (a(t) === false) anims.delete(a); else busy = true; }
    for (const [k, it] of items) { if (it.update(t) === false) { it.remove(); items.delete(k); } else busy = true; }
    if (drawScrim(t)) busy = true;
    for (const c of cards) { const live = c.update(t); if (!c.node.isConnected) cards.delete(c); else if (live) busy = true; }
    if (state && state.clock && ui) {
      const c = state.clock;
      const ms = Math.max(0, (c.frozenAt ?? Date.now()) - c.startedAt - c.pausedMs - (c.pausedAt ? Date.now() - c.pausedAt : 0));
      const text = fmtClock(ms);
      if (text !== lastClockText) { ui.clock.textContent = text; lastClockText = text; }
      ui.clock.classList.toggle('held', !!c.pausedAt && !c.frozenAt);
      if (!c.frozenAt) busy = true;
    }
    if (busy) kick();
  }
  function kick() { if (!running) { running = true; requestAnimationFrame(tick); } }
  function fmtClock(ms) {
    const s = ms / 1000, m = Math.floor(s / 60), r = s - m * 60;
    return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`;
  }

  // ---------- geometry ----------
  // target: an Element, or {x,y,w,h,space:'doc'|'view'}
  function rectOf(target) {
    if (!target) return null;
    if (target instanceof Element) {
      if (!target.isConnected) return null;
      const b = target.getBoundingClientRect();
      if (b.width < 1 && b.height < 1) return null;
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    if (typeof target.x !== 'number') return null;
    const dx = target.space === 'doc' ? scrollX : 0, dy = target.space === 'doc' ? scrollY : 0;
    return { x: target.x - dx, y: target.y - dy, w: target.w || 0, h: target.h || 0 };
  }
  function onScreen(r) { return r && r.x + r.w > -4 && r.y + r.h > -4 && r.x < innerWidth + 4 && r.y < innerHeight + 4; }
  // Where a pointer would aim on a control: text fields a little left of centre, like a person clicking in.
  const TEXTY = 'input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]),textarea,[role=combobox],[role=textbox]';
  function aim(r, target) {
    const texty = target instanceof Element && target.matches(TEXTY) && r.w > 60;
    return { x: texty ? r.x + Math.min(r.w / 2, Math.max(22, r.w * .2)) : r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  // A fade value for something born at t0 that may die at dieAt (both performance.now()).
  function life(t, t0, dieAt) {
    const born = Math.min(1, (t - t0) / FADE);
    const dying = dieAt ? Math.max(0, Math.min(1, (dieAt - t) / FADE)) : 1;
    return born * dying;
  }
  function place(node, x, y) { node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`; }

  // ---------- status strip ----------
  function render(s) {
    if (!ensure() || !ui) return;
    ui.stage.textContent = s.stage || '';
    ui.stage.classList.toggle('fail', !!s.fail);
    ui.model.textContent = s.model || '';
    ui.model.classList.toggle('mono', !!s.modelMono);
    ui.model.style.display = s.model ? '' : 'none';
    ui.clock.style.display = s.clock ? '' : 'none';
    ui.cost.style.display = s.cost == null ? 'none' : '';
    if (s.cost != null) ui.cost.textContent = fmtCost(s.cost);
    ui.facts.innerHTML = '';
    for (const f of s.facts || []) { const n = txt('span', 'fact' + (f.bad ? ' bad' : ''), f.text); ui.facts.appendChild(n); }
    ui.facts.style.display = (s.facts || []).length ? 'flex' : 'none';
    ui.facts.style.gap = '26px';
    ui.s3.innerHTML = '';
    (s.notes || []).forEach((n, i) => {
      if (i) ui.s3.appendChild(document.createTextNode('  ·  '));
      ui.s3.appendChild(document.createTextNode(n.text));
    });
    lastClockText = '';
    fadeTo(ui.strip, s.visible ? 1 : 0);
    if (!s.visible) fadeCursor(0);
  }
  function fmtCost(v) { return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`; }
  function fadeTo(node, to, ms = FADE) {
    const from = Number(node.style.opacity || 0), t0 = now();
    if (from === to) return;
    anims.add(t => { const k = Math.min(1, (t - t0) / ms); node.style.opacity = String(from + (to - from) * k); return k < 1; });
    kick();
  }
  function fadeCursor(to, ms = FADE) {
    if (!ui) return;
    cur.shown = to > 0;
    fadeTo(ui.cursor, to, ms);
  }

  // ---------- cursor ----------
  function glide(x, y, ms) {
    if (!ensure()) return Promise.resolve();
    if (!cur.shown) {                       // first appearance: fade in near the target, then travel
      if (!cur.tween) { cur.x = Math.min(innerWidth - 40, x + 140); cur.y = Math.min(innerHeight - 40, y + 90); }
      fadeCursor(1);
    }
    if (cur.tween) { const tw = cur.tween; cur.tween = null; tw.done(); for (const f of tw.after) f(); }
    return new Promise(resolve => {
      const dist = Math.hypot(x - cur.x, y - cur.y);
      const d = Math.max(90, Math.min(ms, 140 + dist * .55));
      cur.tween = { x0: cur.x, y0: cur.y, x1: x, y1: y, t0: now(), ms: d, done: resolve, after: [] };
      kick();
    });
  }
  // A thin ink ring where a click landed: grows a little and is gone in 360 ms.
  function ripple(x, y) {
    if (!ensure()) return;
    const ring = el('div', 'ripple');
    ui.layer.appendChild(ring);
    const t0 = now();
    anims.add(t => {
      const k = Math.min(1, (t - t0) / 360), e = 1 - Math.pow(1 - k, 2);
      ring.style.transform = `translate(${x}px,${y}px) scale(${1 + e * 2.2})`;
      ring.style.opacity = String(.55 * (1 - k));
      if (k >= 1) { ring.remove(); return false; }
      return true;
    });
    kick();
  }
  function landAndRipple(x, y) {
    const tw = cur.tween;
    if (tw && Math.hypot(tw.x1 - x, tw.y1 - y) < 10) { tw.after.push(() => ripple(x, y)); return; }
    if (Math.hypot(cur.x - x, cur.y - y) > 3 || !cur.shown) { glide(x, y, 200).then(() => ripple(x, y)); return; }
    ripple(x, y);
  }

  // ---------- anchored items ----------
  function put(key, it) { const old = items.get(key); if (old && old !== it) old.remove(); items.set(key, it); kick(); }
  function drop(key) { const it = items.get(key); if (it) { it.remove(); items.delete(key); } }
  function fadeOut(key) { const it = items.get(key); if (it && !it.dieAt) { it.dieAt = now() + FADE; kick(); } }

  // An outline around a target with an optional tag. o = {tone:'accent'|'ink'|'error'|'gray', dash, label, sub,
  // tagTone:'plain'|'ink'|'fail', below, hole (cut out of the scrim), delay (ms before it appears), ttl}
  function outline(key, target, o) {
    if (!ensure()) return;
    const prev = items.get(key);
    const frame = prev ? prev.frame : el('div', 'outline');
    const tag = prev ? prev.tag : el('div', 'tag');
    frame.className = 'outline' + (o.dash ? ' dash' : '');
    frame.style.setProperty('--c', C[o.tone] || o.tone || C.accent);
    tag.className = 'tag' + (o.tagTone === 'ink' ? ' ink' : o.tagTone === 'fail' ? ' fail' : '');
    tag.innerHTML = '';
    if (o.label) tag.appendChild(document.createTextNode(o.label));
    if (o.sub) tag.appendChild(txt('span', 'sub', o.sub));
    if (!frame.isConnected) ui.layer.append(frame, tag);
    const t0 = prev && !prev.dieAt ? prev.t0 : now() + (o.delay || 0);
    const it = {
      frame, tag, target, hole: !!o.hole, t0, dieAt: o.ttl ? t0 + o.ttl : 0,
      update(t) {
        if (this.dieAt && t >= this.dieAt) return false;
        const r = rectOf(target);
        const vis = onScreen(r) && t >= this.t0;
        frame.style.display = vis ? '' : 'none';
        tag.style.display = vis && (o.label || o.sub) ? '' : 'none';
        if (!vis) return true;
        const pad = o.pad ?? 5;
        frame.style.width = `${r.w + pad * 2}px`; frame.style.height = `${r.h + pad * 2}px`;
        place(frame, r.x - pad, r.y - pad);
        if (o.label || o.sub) {
          const lw = tag.offsetWidth, lh = tag.offsetHeight;
          const above = !o.below && r.y - lh - 12 > SAFE.y;
          const lx = Math.min(innerWidth - SAFE.x - lw, Math.max(SAFE.x, r.x + r.w + pad - lw));
          place(tag, lx, above ? r.y - pad - lh - 8 : r.y + r.h + pad + 8);
        }
        const k = life(t, this.t0, this.dieAt);
        frame.style.opacity = String(k); tag.style.opacity = String(k);
        return true;
      },
      remove() { frame.remove(); tag.remove(); },
    };
    put(key, it);
  }
  // The one accent: the step Dockhand is acting on now. Moving it fades the old one out.
  function active(target, o = {}) {
    const prev = items.get('active');
    if (prev && prev.target !== target) { items.delete('active'); prev.dieAt = now() + FADE; items.set('active~' + now(), prev); }
    outline('active', target, { tone: 'accent', pad: 4, ...o });
  }
  function activeOff() { const prev = items.get('active'); if (prev) { items.delete('active'); prev.dieAt = now() + FADE; items.set('active~' + now(), prev); kick(); } }

  // A mark under a field: a short hairline-gray rule (fixed free), ink (read back), error (mismatch). No glyphs.
  function mark(target, key, kind, delay = 0) {
    if (!ensure()) return;
    const prev = items.get('m:' + key);
    const node = prev ? prev.node : el('div');
    node.className = 'mark' + (kind === 'free' ? ' free' : kind === 'bad' ? ' bad' : '');
    if (!node.isConnected) ui.under.appendChild(node);
    const t0 = now() + delay;
    put('m:' + key, {
      node, target, t0,
      update(t) {
        const r = rectOf(target);
        const vis = onScreen(r) && t >= this.t0;
        node.style.display = vis ? '' : 'none';
        if (!vis) return true;
        const w = Math.max(14, Math.min(r.w, 56));
        node.style.width = `${w}px`;
        place(node, r.x, r.y + r.h + 3);
        node.style.opacity = String(Math.min(1, (t - this.t0) / FADE));
        return true;
      },
      remove() { node.remove(); },
    });
  }

  // ---------- scrim (the spotlight) ----------
  function holes() {
    const out = [];
    for (const it of items.values()) {
      if (!it.hole || it.dieAt) continue;
      const r = rectOf(it.target);
      if (onScreen(r)) out.push(r);
    }
    return out;
  }
  function drawScrim(t) {
    if (!ui) return false;
    const k = Math.min(1, (t - scrim.t0) / FADE);
    scrim.op = scrim.from + ((scrim.on ? 1 : 0) - scrim.from) * k;
    ui.sc.style.opacity = String(scrim.op);
    if (scrim.op <= 0.001) return k < 1;
    const W = innerWidth, H = innerHeight;
    let d = `M0 0H${W}V${H}H0Z`;
    for (const r of holes()) {
      const p = 12, x = r.x - p, y = r.y - p, w = r.w + 2 * p, h = r.h + 2 * p, rr = 2;
      d += `M${x + rr} ${y}H${x + w - rr}Q${x + w} ${y} ${x + w} ${y + rr}V${y + h - rr}Q${x + w} ${y + h} ${x + w - rr} ${y + h}H${x + rr}Q${x} ${y + h} ${x} ${y + h - rr}V${y + rr}Q${x} ${y} ${x + rr} ${y}Z`;
    }
    ui.scPath.setAttribute('d', d);
    return true; // holes follow their targets while the scrim is up
  }
  function setScrim(on) { if (!ensure()) return; if (scrim.on === on) return; scrim.from = scrim.op; scrim.on = on; scrim.t0 = now(); kick(); }

  // ---------- cards ----------
  // A card that fades in, can move (eased over 200 ms) and fades out. place() picks its spot each frame.
  function card(cls, where) {
    const node = el('div', 'card ' + cls);
    ui.top.appendChild(node);
    const c = {
      node, t0: now(), dieAt: 0, x: null, y: null, tx: 0, ty: 0, m0: 0, mx: 0, my: 0,
      update(t) {
        if (!node.isConnected) return false;
        const k = life(t, this.t0, this.dieAt);
        node.style.opacity = String(k);
        if (this.dieAt && t >= this.dieAt) { node.remove(); return false; }
        const p = where(node.offsetWidth, node.offsetHeight);
        if (this.x === null) { this.x = p.x; this.y = p.y; this.tx = p.x; this.ty = p.y; }
        if (Math.abs(p.x - this.tx) > 1 || Math.abs(p.y - this.ty) > 1) { this.mx = this.x; this.my = this.y; this.tx = p.x; this.ty = p.y; this.m0 = t; }
        const m = this.m0 ? Math.min(1, (t - this.m0) / 200) : 1, e = ease(m);
        this.x = this.mx + (this.tx - this.mx) * e; this.y = this.my + (this.ty - this.my) * e;
        if (m >= 1) { this.x = this.tx; this.y = this.ty; this.mx = this.tx; this.my = this.ty; this.m0 = 0; }
        place(node, this.x, this.y);
        return k < 1 || this.m0 !== 0 || !!this.dieAt;
      },
      close() { if (!this.dieAt) { this.dieAt = now() + FADE; kick(); } },
    };
    cards.add(c);
    kick();
    return c;
  }
  const clampY = (y, h) => Math.max(SAFE.y + 128, Math.min(innerHeight - SAFE.y - h, y));
  // Beside the newest hole (on the side with more room), else on the left under the strip.
  // Never over the lit element or the status strip: beside it, else above or below it, inside the safe area.
  function spotPlace(w, h) {
    let anchor = null;
    for (const it of items.values()) if (it.hole && !it.dieAt) { const r = rectOf(it.target); if (onScreen(r)) anchor = r; }
    const strip = ui.strip.getBoundingClientRect();
    const minX = SAFE.x, maxX = innerWidth - SAFE.x - w, minY = SAFE.y, maxY = innerHeight - SAFE.y - h;
    const cx = (x) => Math.max(minX, Math.min(maxX, x)), cy = (y) => Math.max(minY, Math.min(maxY, y));
    const hits = (x, y, r, m) => r && x < r.x + r.w + m && x + w > r.x - m && y < r.y + r.h + m && y + h > r.y - m;
    const ok = (p) => !hits(p.x, p.y, anchor, 18) && !hits(p.x, p.y, { x: strip.left, y: strip.top, w: strip.width, h: strip.height }, 12);
    if (!anchor) {
      const p = { x: minX, y: cy(strip.bottom + 24) };
      return ok(p) ? p : { x: minX, y: maxY };
    }
    const mid = anchor.y + anchor.h / 2 - h / 2;
    const tries = [
      { x: cx(anchor.x + anchor.w + 40), y: cy(mid) },
      { x: cx(anchor.x - 40 - w), y: cy(mid) },
      { x: cx(anchor.x + anchor.w / 2 - w / 2), y: cy(anchor.y - 30 - h) },
      { x: cx(anchor.x + anchor.w / 2 - w / 2), y: cy(anchor.y + anchor.h + 30) },
      { x: maxX, y: cy(strip.bottom + 16) },
      { x: minX, y: cy(strip.bottom + 16) },
      { x: minX, y: cy(anchor.y - 30 - h) },
      { x: maxX, y: cy(anchor.y - 30 - h) },
      { x: minX, y: cy(anchor.y + anchor.h + 30) },
      { x: maxX, y: cy(anchor.y + anchor.h + 30) },
    ];
    return tries.find(ok) ?? tries.find((p) => !hits(p.x, p.y, anchor, 18)) ?? tries[0];
  }
  // Status is a word: Fixed, No match, Trying, Next, Not needed.
  const RUNG_WORD = { ok: 'Fixed', fail: 'No match', trying: 'Trying', pending: 'Next', off: 'Off', na: 'Not needed' };
  function rungRow(r) {
    const row = el('div', 'rung ' + r.status);
    const word = RUNG_WORD[r.status] || '';
    const detail = (r.detail || '').toLowerCase() === word.toLowerCase() ? '' : r.detail || '';
    row.append(txt('span', 'rn', r.name), txt('span', 'rs', word), txt('span', 'rd', detail));
    return row;
  }
  // st = {title, sub, rungs:[{name,status,detail}], pick:{title, reason, meta}, verified:{ok,text}}
  function spot(st) {
    if (!ensure()) return;
    if (!spotCard || spotCard.dieAt) { spotCard = card('spot', spotPlace); }
    const n = spotCard.node;
    n.innerHTML = '';
    n.appendChild(txt('div', 'sh', st.title));
    if (st.sub) n.appendChild(txt('div', 'ss', st.sub));
    if (st.rungs && st.rungs.length) { const list = el('div', 'rungs'); for (const r of st.rungs) list.appendChild(rungRow(r)); n.appendChild(list); }
    if (st.pick) {
      const p = el('div', 'pick');
      p.appendChild(txt('div', 'ph', st.pick.title));
      if (st.pick.reason) p.appendChild(txt('div', 'pr', st.pick.reason));
      if (st.pick.meta) p.appendChild(txt('div', 'pm', st.pick.meta));
      n.appendChild(p);
    }
    if (st.verified) {
      const v = el('div', 'verified' + (st.verified.ok ? '' : ' fail'));
      v.append(txt('b', '', st.verified.ok ? 'Verified. ' : 'Not verified. '), txt('span', '', st.verified.text));
      n.appendChild(v);
    }
    kick();
  }
  function spotOff() { if (spotCard) spotCard.close(); spotCard = null; }

  // The read-back before submit: each written field, read from the page, one row at a time.
  // st = {title, rows:[{label, value, ok, expected}], stepMs, instant}
  function readback(st) {
    if (!ensure()) return;
    if (rbCard && !rbCard.dieAt) rbCard.close();
    rbCard = card('rb', (w, h) => ({ x: SAFE.x, y: clampY(SAFE.y + 128, h) }));
    const n = rbCard.node;
    const head = txt('div', 'sh', st.title);
    const sub = txt('div', 'ss', st.sub || '');
    const list = el('div', 'rows');
    const rows = st.rows.map(r => {
      const row = el('div', 'row');
      const v = txt('span', 'rv' + (r.ok ? '' : ' bad'), r.value === '' ? '(empty)' : r.value);
      row.append(txt('span', 'rl', r.label), v, txt('span', 'rc' + (r.ok ? '' : ' bad'), r.ok ? 'Match' : 'Mismatch'));
      list.appendChild(row);
      return row;
    });
    n.append(head, sub, list);
    const t0 = now(), step = st.instant ? 0 : (st.stepMs || 120);
    let shown = -1;
    // One row per step: it lights up with its check; the row being read carries the accent until the sweep ends.
    anims.add(t => {
      if (!n.isConnected) return false;
      const k = step ? Math.floor((t - t0) / step) : rows.length;
      const upTo = Math.min(rows.length - 1, k);
      while (shown < upTo) { shown++; rows[shown].classList.add('on'); }
      const sweeping = step > 0 && k < rows.length;
      rows.forEach((row, i) => row.classList.toggle('cur', sweeping && i === shown));
      return sweeping;
    });
    kick();
  }
  function readbackOff() { if (rbCard) rbCard.close(); rbCard = null; }

  function hint(text, x, y, ms = 1000) {
    if (!ensure()) return;
    const node = txt('div', 'hint', text); ui.top.appendChild(node);
    const t0 = now();
    anims.add(t => {
      place(node, Math.max(SAFE.x, Math.min(innerWidth - SAFE.x - node.offsetWidth, x + 18)), Math.max(SAFE.y, Math.min(innerHeight - SAFE.y - node.offsetHeight, y + 14)));
      node.style.opacity = String(life(t, t0, t0 + ms));
      if (t >= t0 + ms) { node.remove(); return false; }
      return true;
    });
    kick();
  }
  function shutter() {
    if (!ensure()) return;
    const node = ui.flash, t0 = now();
    anims.add(t => { const k = Math.min(1, (t - t0) / 240); node.style.opacity = String(.35 * (1 - k)); return k < 1; });
    kick();
  }
  function clear(all) {
    for (const [k, it] of items) { if (all || !k.startsWith('keep:')) { it.remove(); items.delete(k); } }
    if (all) { spotOff(); readbackOff(); setScrim(false); }
  }
  function retire(prefix, ms) {
    const at = now() + (ms || 0);
    for (const [k, it] of items) if (k.startsWith(prefix) && !it.dieAt) it.dieAt = at + FADE;
    kick();
  }

  const api = {
    view(s) { state = s; render(s); kick(); },
    glide(x, y, ms) { return glide(x, y, ms || 260); },
    glideTo(target, ms) { const r = rectOf(target); if (!r || !onScreen(r)) return Promise.resolve(false); const p = aim(r, target); return glide(p.x, p.y, ms || 260).then(() => true); },
    ripple(x, y) { landAndRipple(x, y); },
    rippleOn(target) { const r = rectOf(target); if (!r || !onScreen(r)) return; const p = aim(r, target); landAndRipple(p.x, p.y); },
    glideClick(x, y, ms) { return glide(x, y, ms || 300).then(() => landAndRipple(x, y)); },
    // element-first variants (Node passes the element as the first argument)
    activeOn(target, o) { active(target, o || {}); },
    activeBox(box, o) { active(box, o || {}); },
    activeOff,
    markOn(target, key, kind, delay) { mark(target, key, kind, delay || 0); },
    outlineOn(target, key, o) { outline(key, target, o); },
    outline(key, box, o) { outline(key, box, o); },
    acted(target, o) { if (o.click) api.rippleOn(target); },
    unbox(key) { fadeOut(key); },
    scrim: setScrim,
    spot, spotOff, readback, readbackOff,
    hint,
    hintBottom(text, ms) { hint(text, innerWidth / 2 - 60, innerHeight - SAFE.y - 60, ms); },
    shutter, clear, retire,
    hideCursor() { fadeCursor(0); },
    cursorAt() { return { x: cur.x, y: cur.y }; },
  };
  try { Object.defineProperty(window, '__dockhandHud', { value: api, enumerable: false, configurable: false, writable: false }); }
  catch { return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

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
// - no network requests, no fonts to load, no globals except a non-enumerable window.__dockhandHud.
(() => {
  if (window.__dockhandHud) return;

  const TONES = {
    cu: '#a78bfa', replay: '#22d3ee', heal: '#fbbf24', dry: '#60a5fa', wait: '#f472b6',
    done: '#4ade80', fail: '#fb7185', idle: '#94a3b8',
  };
  const OK = '#22c55e', BAD = '#f43f5e';
  const css = `
:host{all:initial}
*{box-sizing:border-box}
.root{position:fixed;inset:0;pointer-events:none;overflow:hidden;font:500 13px/1.3 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,sans-serif;color:#f4f6fa;-webkit-font-smoothing:antialiased;letter-spacing:0}
.root *{pointer-events:none}
.num{font-variant-numeric:tabular-nums}
.panel{position:absolute;top:9px;right:12px;width:640px;border-radius:14px;background:rgba(12,14,19,.9);backdrop-filter:blur(16px) saturate(150%);border:1px solid rgba(255,255,255,.13);box-shadow:0 12px 32px rgba(3,6,12,.42),0 2px 6px rgba(3,6,12,.3);overflow:hidden;opacity:0;transform:translateY(-6px)}
.r1{display:flex;align-items:center;gap:11px;height:40px;padding:0 12px 0 11px}
.brand{display:flex;align-items:center;gap:7px;font-weight:700;font-size:13px;color:#fff;padding-right:11px;border-right:1px solid rgba(255,255,255,.12);height:20px;letter-spacing:.1px}
.logo{width:18px;height:18px;flex:none}
.phase{display:flex;align-items:center;gap:8px;min-width:0;flex:1;white-space:nowrap}
.dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--c);box-shadow:0 0 0 3px color-mix(in srgb,var(--c) 28%,transparent),0 0 14px var(--c)}
.title{font-weight:700;font-size:13.5px;color:#fff}
.detail{color:#c3cbd8;font-weight:500;overflow:hidden;text-overflow:ellipsis;min-width:0}
.detail:not(:empty)::before{content:"\\00b7";margin:0 7px 0 1px;color:#6f7a8a}
.metrics{display:flex;align-items:center;gap:13px;flex:none}
.m{display:flex;align-items:center;gap:5px;font-weight:650;font-size:13px;color:#eef1f6}
.m svg{width:13px;height:13px;color:#8b95a5;flex:none}
.m.off{display:none}
.r2{display:flex;align-items:center;gap:9px;height:31px;padding:0 12px;border-top:1px solid rgba(255,255,255,.08);background:rgba(255,255,255,.035);font-size:12.5px;color:#c9d1dc}
.stepn{font-weight:700;color:#fff;white-space:nowrap;flex:none}
.stepn:empty{display:none}
.ticker{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.calls{flex:none;color:#9aa4b2;font-weight:650;font-size:12px;white-space:nowrap}
.calls:empty{display:none}
.tags{display:flex;gap:6px;flex:none}
.tag{height:20px;display:inline-flex;align-items:center;gap:5px;padding:0 7px;border-radius:999px;font-size:11px;font-weight:700;letter-spacing:.2px;border:1px solid}
.tag.slow{color:#fcd34d;border-color:rgba(252,211,77,.45);background:rgba(252,211,77,.1)}
.tag.sim{color:#93c5fd;border-color:rgba(147,197,253,.42);background:rgba(147,197,253,.1)}
.tag.ok{color:#86efac;border-color:rgba(134,239,172,.42);background:rgba(134,239,172,.1)}
.tag.bad{color:#fda4af;border-color:rgba(253,164,175,.45);background:rgba(253,164,175,.1)}
.cursor{position:absolute;left:0;top:0;width:0;height:0;opacity:0;will-change:transform}
.cursor .halo{position:absolute;left:-17px;top:-17px;width:34px;height:34px;border-radius:50%;background:radial-gradient(circle,color-mix(in srgb,var(--c) 55%,transparent) 0,color-mix(in srgb,var(--c) 18%,transparent) 45%,transparent 70%)}
.cursor svg{position:absolute;left:-2px;top:-1px;width:23px;height:27px;filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
.ripple{position:absolute;left:0;top:0;width:12px;height:12px;margin:-6px 0 0 -6px;border-radius:50%;border:2.5px solid var(--c)}
.ripdot{position:absolute;left:0;top:0;width:8px;height:8px;margin:-4px 0 0 -4px;border-radius:50%;background:var(--c)}
.badge{position:absolute;left:0;top:0;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;display:grid;place-items:center;background:var(--c);box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.28)}
.badge svg{width:12px;height:12px;color:#fff}
.glow{position:absolute;left:0;top:0;border-radius:8px;border:2px solid var(--c);box-shadow:0 0 0 4px color-mix(in srgb,var(--c) 22%,transparent)}
.box{position:absolute;left:0;top:0;border-radius:8px;border:2px solid var(--c)}
.box.dash{border-style:dashed;background:color-mix(in srgb,var(--c) 9%,transparent)}
.box.halo{box-shadow:0 0 0 5px color-mix(in srgb,var(--c) 22%,transparent)}
.label{position:absolute;left:0;top:0;display:flex;flex-direction:column;gap:2px;max-width:520px;padding:5px 9px 6px;border-radius:7px;background:var(--c);color:#0b0d12;font-size:12.5px;font-weight:700;white-space:nowrap;box-shadow:0 6px 16px rgba(3,6,12,.3)}
.label.dark{background:rgba(12,14,19,.93);color:#fff;border:1px solid color-mix(in srgb,var(--c) 70%,transparent)}
.label .sub{font-weight:600;font-size:11.5px;opacity:.85}
.label.dark .sub{color:var(--c);opacity:1}
.links{position:absolute;inset:0;width:100%;height:100%;overflow:visible}
.flash{position:absolute;inset:0;opacity:0;box-shadow:inset 0 0 0 3px rgba(255,255,255,.95),inset 0 0 46px rgba(255,255,255,.28)}
.pill{position:absolute;left:0;top:0;height:18px;display:inline-flex;align-items:center;padding:0 7px;border-radius:999px;background:var(--c);color:#0b0d12;font-size:10.5px;font-weight:800;letter-spacing:.3px;white-space:nowrap;box-shadow:0 0 0 2px #fff,0 2px 6px rgba(0,0,0,.25)}
.hint{position:absolute;left:0;top:0;padding:3px 8px;border-radius:6px;background:rgba(12,14,19,.9);color:#fff;font-size:12px;font-weight:700;white-space:nowrap;border:1px solid rgba(255,255,255,.16)}
`;
  const ICON = {
    check: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.4 6.3l2.3 2.3 4.9-5"/></svg>',
    cross: '<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
    pen: '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="6" cy="6" r="2.6"/></svg>',
    clock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="8" cy="9" r="5.6"/><path d="M8 6v3.2l2 1.3M6.4 1.6h3.2" stroke-linecap="round"/></svg>',
    coin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><ellipse cx="8" cy="5" rx="5.2" ry="2.4"/><path d="M2.8 5v6c0 1.3 2.3 2.4 5.2 2.4s5.2-1.1 5.2-2.4V5M2.8 8c0 1.3 2.3 2.4 5.2 2.4s5.2-1.1 5.2-2.4"/></svg>',
    calls: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M8 1.8l1.6 3.9 4.1.4-3.1 2.7.9 4-3.5-2.1-3.5 2.1.9-4L2.3 6.1l4.1-.4z"/></svg>',
  };
  const LOGO = '<svg class="logo" viewBox="0 0 18 18"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs><rect width="18" height="18" rx="5" fill="url(#g)"/><path d="M5.2 4.6h3.6a4.4 4.4 0 0 1 0 8.8H5.2z" fill="none" stroke="#0b0d12" stroke-width="1.9" stroke-linejoin="round"/><circle cx="9.1" cy="9" r="1.35" fill="#0b0d12"/></svg>';
  const ARROW = '<svg viewBox="0 0 23 27"><path d="M2 1.6v20.6l5.6-5.3 3.7 8.2 3.5-1.6-3.6-8h7.6z" fill="#fff" stroke="#0b0d12" stroke-width="1.5" stroke-linejoin="round"/></svg>';

  let host = null, root = null, ui = null;
  let state = null;                 // last view() payload
  const items = new Map();          // key -> renderable with update(now) -> bool (false = remove)
  const anims = new Set();          // one-shot animations
  let running = false;
  const cur = { x: 640, y: 420, shown: false, tween: null, tone: TONES.cu };

  const ease = t => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const now = () => performance.now();
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; };

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
      const layer = el('div', 'layer');
      const links = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); links.setAttribute('class', 'links');
      const cursor = el('div', 'cursor', '<div class="halo"></div>' + ARROW);
      const panel = el('div', 'panel', `<div class="r1"><div class="brand">${LOGO}<span>Dockhand</span></div><div class="phase"><i class="dot"></i><span class="title"></span><span class="detail"></span></div><div class="metrics"><div class="m clock num">${ICON.clock}<span></span></div><div class="m cost num">${ICON.coin}<span></span></div></div></div><div class="r2"><span class="stepn num"></span><span class="ticker"></span><span class="calls num"></span><span class="tags"></span></div>`);
      const flash = el('div', 'flash');
      r.append(layer, links, cursor, panel, flash);
      root.appendChild(r);
      ui = { r, layer, links, cursor, panel, flash,
        title: panel.querySelector('.title'), detail: panel.querySelector('.detail'), dot: panel.querySelector('.dot'),
        clock: panel.querySelector('.clock span'), clockBox: panel.querySelector('.clock'),
        cost: panel.querySelector('.cost span'), costBox: panel.querySelector('.cost'),
        calls: panel.querySelector('.calls'),
        stepn: panel.querySelector('.stepn'), ticker: panel.querySelector('.ticker'), tags: panel.querySelector('.tags') };
    }
    parent.appendChild(host);       // after <body>: outside body.innerText, body locators and form ordinals
    if (state) render(state);
    kick();
    return true;
  }
  function ensure() { return mount(); }

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
    if (state && state.clock && ui) {
      const c = state.clock;
      const ms = Math.max(0, (c.frozenAt ?? Date.now()) - c.startedAt - c.pausedMs - (c.pausedAt ? Date.now() - c.pausedAt : 0));
      const text = fmtClock(ms);
      if (text !== lastClockText) { ui.clock.textContent = text; lastClockText = text; }
      if (!c.frozenAt) busy = true;
    }
    if (state && state.pulse && ui) {
      const a = .55 + .45 * Math.sin(t / 260);
      ui.dot.style.opacity = a.toFixed(2); busy = true;
    } else if (ui) ui.dot.style.opacity = '1';
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
  function center(r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; }
  // Where a pointer would aim on a control: text fields a little left of centre, like a person clicking in.
  const TEXTY = 'input:not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=file]),textarea,[role=combobox],[role=textbox]';
  function aim(r, target) {
    const texty = target instanceof Element && target.matches(TEXTY) && r.w > 60;
    return { x: texty ? r.x + Math.min(r.w / 2, Math.max(22, r.w * .2)) : r.x + r.w / 2, y: r.y + r.h / 2 };
  }
  // Ripple where the cursor lands: after the running glide when it heads there, else after a short glide.
  function landAndRipple(x, y) {
    const tw = cur.tween;
    if (tw && Math.hypot(tw.x1 - x, tw.y1 - y) < 10) { tw.after.push(() => ripple(x, y)); return; }
    if (Math.hypot(cur.x - x, cur.y - y) > 3 || !cur.shown) { glide(x, y, 200).then(() => ripple(x, y)); return; }
    ripple(x, y);
  }

  // ---------- panel ----------
  function render(s) {
    if (!ensure() || !ui) return;
    const tone = TONES[s.tone] || s.tone || TONES.idle;
    ui.r.style.setProperty('--c', tone);
    cur.tone = tone;
    ui.title.textContent = s.title || '';
    ui.detail.textContent = s.detail || '';
    ui.stepn.textContent = s.step || '';
    ui.ticker.textContent = s.ticker || '';
    ui.costBox.classList.toggle('off', s.cost == null);
    if (s.cost != null) ui.cost.textContent = fmtCost(s.cost);
    ui.calls.textContent = s.calls == null ? '' : `${s.calls} model call${s.calls === 1 ? '' : 's'}`;
    ui.clockBox.classList.toggle('off', !s.clock);
    lastClockText = '';
    ui.tags.innerHTML = '';
    for (const t of s.tags || []) { const g = el('span', `tag ${t.kind}`); g.textContent = t.text; ui.tags.appendChild(g); }
    const show = !!s.visible;
    fade(ui.panel, show ? 1 : 0, show ? 0 : -6, 180);
    if (!show) fadeCursor(0);
  }
  function fmtCost(v) { return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`; }
  function fade(node, to, ty, ms) {
    const from = Number(node.style.opacity || 0), t0 = now();
    const fromY = Number(node.dataset.ty || (to ? -6 : 0));
    node.dataset.ty = String(ty);
    anims.add(t => {
      const k = Math.min(1, (t - t0) / ms), e = ease(k);
      node.style.opacity = String(from + (to - from) * e);
      node.style.transform = `translateY(${(fromY + (ty - fromY) * e).toFixed(2)}px)`;
      return k < 1;
    });
    kick();
  }
  function fadeCursor(to, ms = 160) {
    if (!ui) return;
    cur.shown = to > 0;
    const node = ui.cursor, from = Number(node.style.opacity || 0), t0 = now();
    anims.add(t => { const k = Math.min(1, (t - t0) / ms); node.style.opacity = String(from + (to - from) * k); return k < 1; });
    kick();
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
  function ripple(x, y) {
    if (!ensure()) return;
    const tone = cur.tone;
    const ring = el('div', 'ripple'), dot = el('div', 'ripdot');
    ring.style.setProperty('--c', tone); dot.style.setProperty('--c', tone);
    ui.layer.append(ring, dot);
    const t0 = now();
    anims.add(t => {
      const k = Math.min(1, (t - t0) / 520), e = 1 - Math.pow(1 - k, 3);
      ring.style.transform = `translate(${x}px,${y}px) scale(${1 + e * 4.2})`;
      ring.style.opacity = String(.95 * (1 - k));
      dot.style.transform = `translate(${x}px,${y}px) scale(${1 - k * .6})`;
      dot.style.opacity = String(1 - k);
      if (k >= 1) { ring.remove(); dot.remove(); return false; }
      return true;
    });
    kick();
  }

  // ---------- anchored items ----------
  function place(node, x, y) { node.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`; }
  function put(key, it) { const old = items.get(key); if (old) old.remove(); items.set(key, it); kick(); }
  function drop(key) { const it = items.get(key); if (it) { it.remove(); items.delete(key); } }

  function badge(target, key, kind, note) {
    if (!ensure()) return;
    const prev = items.get('b:' + key);
    const color = kind === 'ok' ? OK : kind === 'bad' ? BAD : cur.tone;
    const node = prev && prev.node ? prev.node : el('div', 'badge');
    node.style.setProperty('--c', color);
    node.innerHTML = kind === 'ok' ? ICON.check : kind === 'bad' ? ICON.cross : ICON.pen;
    let callout = prev && prev.callout;
    if (kind === 'bad' && note) {
      if (!callout) { callout = el('div', 'label'); ui.layer.appendChild(callout); }
      callout.style.setProperty('--c', TONES.fail);
      callout.textContent = note;
    } else if (callout) { callout.remove(); callout = null; }
    if (!node.isConnected) ui.layer.appendChild(node);
    const t0 = now();
    const it = {
      node, callout, target,
      update() {
        const r = rectOf(target);
        const vis = onScreen(r);
        node.style.display = vis ? '' : 'none';
        if (callout) callout.style.display = vis ? '' : 'none';
        if (!vis) return true;
        const k = Math.min(1, (now() - t0) / 260), s = k < 1 ? .55 + .45 * (1 - Math.pow(1 - k, 3)) + Math.sin(k * Math.PI) * .18 : 1;
        const small = r.w < 44;
        const bx = small ? r.x - 15 : r.x + r.w - 4, by = small ? r.y + r.h / 2 : r.y + 1;
        node.style.transform = `translate(${Math.round(bx)}px,${Math.round(by)}px) scale(${s.toFixed(3)})`;
        if (callout) place(callout, Math.min(innerWidth - callout.offsetWidth - 8, Math.max(8, r.x)), r.y + r.h + 6);
        return true;
      },
      remove() { node.remove(); if (callout) callout.remove(); },
    };
    items.set('b:' + key, it);
    kick();
  }
  function glow(target, color, ms = 900) {
    if (!ensure()) return;
    const node = el('div', 'glow'); node.style.setProperty('--c', color || cur.tone);
    ui.layer.appendChild(node);
    const t0 = now();
    anims.add(t => {
      const k = Math.min(1, (t - t0) / ms), r = rectOf(target);
      if (!r || k >= 1) { node.remove(); return false; }
      node.style.width = `${r.w + 8}px`; node.style.height = `${r.h + 8}px`;
      place(node, r.x - 4, r.y - 4);
      node.style.opacity = String(k < .2 ? k / .2 : 1 - (k - .2) / .8);
      return true;
    });
    kick();
  }
  // A box with a label: o = {tone, dashed, halo, label, sub, dark, below}
  function box(key, target, o) {
    if (!ensure()) return;
    const color = TONES[o.tone] || o.tone || cur.tone;
    const prev = items.get('x:' + key);
    const frame = prev ? prev.frame : el('div', 'box');
    const label = prev ? prev.label : el('div', 'label');
    frame.className = `box${o.dashed ? ' dash' : ''}${o.halo ? ' halo' : ''}`;
    frame.style.setProperty('--c', color); label.style.setProperty('--c', color);
    label.className = `label${o.dark ? ' dark' : ''}`;
    label.innerHTML = '';
    if (o.label) { const a = el('span'); a.textContent = o.label; label.appendChild(a); }
    if (o.sub) { const b = el('span', 'sub'); b.textContent = o.sub; label.appendChild(b); }
    label.style.display = o.label || o.sub ? '' : 'none';
    if (!frame.isConnected) ui.layer.append(frame, label);
    const t0 = prev ? prev.t0 : now();
    frame.style.boxShadow = '';
    const it = {
      frame, label, t0, target, dim: !!o.dim, dieAt: o.ttl ? now() + o.ttl : 0,
      update(t) {
        let fadeK = 1;
        if (this.dieAt) { fadeK = Math.max(0, Math.min(1, (this.dieAt - t) / 350)); if (fadeK <= 0) return false; }
        const r = rectOf(target);
        const vis = onScreen(r);
        frame.style.display = vis ? '' : 'none';
        if (!vis) { label.style.display = 'none'; return true; }
        label.style.display = o.label || o.sub ? '' : 'none';
        frame.style.width = `${r.w + 10}px`; frame.style.height = `${r.h + 10}px`;
        place(frame, r.x - 5, r.y - 5);
        const lw = label.offsetWidth, lh = label.offsetHeight;
        const above = !o.below && r.y - lh - 9 > 4;
        const lx = o.left ? Math.min(innerWidth - lw - 8, Math.max(8, r.x - 5)) : Math.min(innerWidth - lw - 8, Math.max(8, r.x + r.w + 5 - lw));
        place(label, lx, above ? r.y - lh - 9 : r.y + r.h + 9);
        const k = Math.min(1, (t - this.t0) / 220);
        const base = this.dim ? .45 : 1;
        frame.style.opacity = String(base * k * fadeK); label.style.opacity = String((this.dim ? .75 : 1) * k * fadeK);
        if (o.pulse) frame.style.boxShadow = `0 0 0 ${(4 + 3 * Math.sin(t / 240)).toFixed(1)}px color-mix(in srgb, ${color} 24%, transparent)`;
        return true;
      },
      remove() { frame.remove(); label.remove(); },
    };
    items.set('x:' + key, it);
    kick();
  }
  function pill(target, key, text, tone) {
    if (!ensure()) return;
    const color = TONES[tone] || tone || TONES.heal;
    const prev = items.get('p:' + key);
    const node = prev ? prev.node : el('div', 'pill');
    node.textContent = text; node.style.setProperty('--c', color);
    if (!node.isConnected) ui.layer.appendChild(node);
    const t0 = prev ? prev.t0 : now();
    items.set('p:' + key, {
      node, t0,
      update(t) {
        const r = rectOf(target);
        if (!onScreen(r)) { node.style.display = 'none'; return true; }
        node.style.display = '';
        const small = r.w < 44, w = node.offsetWidth;
        const x = small ? r.x - 28 - w : r.x + r.w - 18 - w, y = small ? r.y + r.h / 2 - 9 : r.y - 8;
        place(node, x, y);
        node.style.opacity = String(Math.min(1, (t - t0) / 220));
        return true;
      },
      remove() { node.remove(); },
    });
    kick();
  }
  function retire(prefix, ms) {
    const at = now() + (ms || 0);
    for (const [k, it] of items) {
      if ((k.startsWith('x:' + prefix) || k.startsWith('l:' + prefix)) && !it.dieAt) it.dieAt = at;
    }
    kick();
  }
  function dim(key, on) { const it = items.get('x:' + key); if (it) { it.dim = on; kick(); } }
  // Dashed arrow from one box to another (old place -> new place of a healed control).
  function link(key, fromKey, toKey, tone) {
    if (!ensure()) return;
    const color = TONES[tone] || tone || TONES.heal;
    const ns = 'http://www.w3.org/2000/svg';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('fill', 'none'); path.setAttribute('stroke', color); path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-dasharray', '6 5'); path.setAttribute('stroke-linecap', 'round');
    const head = document.createElementNS(ns, 'path');
    head.setAttribute('fill', color);
    ui.links.append(path, head);
    const t0 = now();
    put('l:' + key, {
      dieAt: 0,
      update(t) {
        if (this.dieAt && t >= this.dieAt) return false;
        const a = items.get('x:' + fromKey), b = items.get('x:' + toKey);
        const ra = a && rectOf(a.target), rb = b && rectOf(b.target);
        if (!ra || !rb || !onScreen(ra) || !onScreen(rb)) { path.style.display = head.style.display = 'none'; return true; }
        path.style.display = head.style.display = '';
        const p = center(ra), q = center(rb);
        if (Math.hypot(q.x - p.x, q.y - p.y) < 30) { path.style.display = head.style.display = 'none'; return true; }
        const mx = (p.x + q.x) / 2 + (q.y - p.y) * .18, my = (p.y + q.y) / 2 - (q.x - p.x) * .18;
        // stop at the target box edge
        const ang = Math.atan2(q.y - my, q.x - mx);
        const ex = q.x - Math.cos(ang) * (Math.min(rb.w, rb.h) / 2 + 9), ey = q.y - Math.sin(ang) * (Math.min(rb.w, rb.h) / 2 + 9);
        path.setAttribute('d', `M${p.x},${p.y} Q${mx},${my} ${ex},${ey}`);
        const s = 8, l = ang + Math.PI * .82, r = ang - Math.PI * .82;
        head.setAttribute('d', `M${ex + Math.cos(ang) * 2},${ey + Math.sin(ang) * 2} L${ex + Math.cos(l) * s},${ey + Math.sin(l) * s} L${ex + Math.cos(r) * s},${ey + Math.sin(r) * s}Z`);
        const k = Math.min(1, (t - t0) / 300);
        path.style.opacity = head.style.opacity = String(k);
        path.setAttribute('stroke-dashoffset', String(-(t / 40) % 11));
        return true;
      },
      remove() { path.remove(); head.remove(); },
    });
  }
  function hint(text, x, y, ms = 1100) {
    if (!ensure()) return;
    const node = el('div', 'hint'); node.textContent = text; ui.layer.appendChild(node);
    const t0 = now();
    anims.add(t => {
      const k = Math.min(1, (t - t0) / ms);
      place(node, Math.min(innerWidth - node.offsetWidth - 8, x + 18), Math.min(innerHeight - 30, y + 14));
      node.style.opacity = String(k < .15 ? k / .15 : k > .75 ? (1 - k) / .25 : 1);
      if (k >= 1) { node.remove(); return false; }
      return true;
    });
    kick();
  }
  function shutter() {
    if (!ensure()) return;
    const node = ui.flash, t0 = now();
    anims.add(t => { const k = Math.min(1, (t - t0) / 320); node.style.opacity = String(.85 * (1 - k)); return k < 1; });
    kick();
  }
  function clear(all) {
    for (const [k, it] of items) { if (all || !k.startsWith('keep:')) { it.remove(); items.delete(k); } }
  }

  const api = {
    view(s) { state = s; render(s); kick(); },
    glide(x, y, ms) { return glide(x, y, ms || 260); },
    glideTo(target, ms) { const r = rectOf(target); if (!r || !onScreen(r)) return Promise.resolve(false); const p = aim(r, target); return glide(p.x, p.y, ms || 260).then(() => true); },
    ripple(x, y) { landAndRipple(x, y); },
    rippleOn(target) { const r = rectOf(target); if (!r || !onScreen(r)) return; const p = aim(r, target); landAndRipple(p.x, p.y); },
    badge, glow, box, dim, link, hint, shutter, clear, pill, retire,
    pillOn(target, key, text, tone) { pill(target, key, text, tone); },
    unbox(key) { drop('x:' + key); },
    // element-first variants (Node passes the element as the first argument)
    boxOn(target, key, o) { box(key, target, o); },
    acted(target, o) { if (o.click) api.rippleOn(target); if (o.write) { badge(target, o.key, 'filled'); glow(target); } },
    glideClick(x, y, ms) { return glide(x, y, ms || 300).then(() => landAndRipple(x, y)); },
    hintBottom(text, ms) { hint(text, innerWidth / 2 - 40, innerHeight - 96, ms); },
    hideCursor() { fadeCursor(0); },
    cursorAt() { return { x: cur.x, y: cur.y }; },
  };
  try { Object.defineProperty(window, '__dockhandHud', { value: api, enumerable: false, configurable: false, writable: false }); }
  catch { return; }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();

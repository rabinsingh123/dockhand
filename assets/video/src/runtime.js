// Dockhand motion graphics runtime. Every clip draws itself as a pure function of time: a page calls
// DH.clip({ duration, init, frame(t) }) and frame(t) sets every animated style from t alone (no CSS animations,
// no transitions, no timers, no randomness). render.ts sets window.__DH_RENDER__ before the page loads, awaits
// window.__dh.ready, then calls window.__dh.frame(n / fps) and screenshots each frame. Opened directly in a
// browser, the clip plays in real time and loops; ?t=4.2 freezes it at 4.2 s.
(() => {
  const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    linear: (x) => x,
    out: (x) => 1 - (1 - x) ** 3,
    out4: (x) => 1 - (1 - x) ** 4,
    outExpo: (x) => (x >= 1 ? 1 : 1 - 2 ** (-10 * x)),
    in: (x) => x ** 3,
    inOut: (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2),
    outBack: (x) => {
      const c1 = 1.5;
      const c3 = c1 + 1;
      return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
    },
  };
  /** Eased progress 0..1 of a segment that starts at `at` and lasts `dur` seconds. */
  const seg = (t, at, dur, e = ease.out) => e(clamp((t - at) / dur));
  const r2 = (v) => Math.round(v * 100) / 100;

  /** Sets an element's look. o: opacity; x, y: px offsets; s: scale; b: blur in px. */
  function fx(el, { o = 1, x = 0, y = 0, s = 1, b = 0 } = {}) {
    const op = clamp(o);
    el.style.opacity = op < 0.002 ? "0" : op > 0.998 ? "1" : op.toFixed(4);
    el.style.visibility = op < 0.002 ? "hidden" : "visible";
    el.style.transform = `translate(${r2(x)}px,${r2(y)}px)${s === 1 ? "" : ` scale(${s.toFixed(4)})`}`;
    el.style.filter = b > 0.05 ? `blur(${r2(b)}px)` : "none";
  }

  /**
   * Enter (and optionally leave): rises `dy` px while fading in and sharpening; `out` fades it away upward.
   * Returns the enter progress.
   */
  function rise(el, t, at, o = {}) {
    const { dur = 0.6, dy = 30, dx = 0, blur = 10, s0 = 1, e = ease.out, out = null } = o;
    const p = seg(t, at, dur, e);
    let op = p;
    let y = (1 - p) * dy;
    let b = (1 - p) * blur;
    if (out) {
      const q = seg(t, out.at, out.dur ?? 0.5, ease.in);
      op *= 1 - q;
      y -= q * (out.dy ?? 24);
      b += q * (out.blur ?? 8);
    }
    fx(el, { o: op, x: (1 - p) * dx, y, b, s: lerp(s0, 1, p) });
    return p;
  }

  let markN = 0;
  /** The Dockhand "D" mark: the same drawing as the HUD, the recorder and the phone cards. */
  function mark(size) {
    markN += 1;
    const id = `dmg${markN}`;
    return (
      `<svg class="dmark" width="${size}" height="${size}" viewBox="0 0 18 18" aria-hidden="true">` +
      `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#a78bfa"/>` +
      `<stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>` +
      `<g class="dm-tile" style="transform-origin:9px 9px"><rect width="18" height="18" rx="5" fill="url(#${id})"/>` +
      `<path class="dm-d" pathLength="1" d="M5.2 4.6h3.6a4.4 4.4 0 0 1 0 8.8H5.2z" fill="none" stroke="#0b0d12" ` +
      `stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1 1"/>` +
      `<circle class="dm-dot" cx="9.1" cy="9" r="1.35" fill="#0b0d12" style="transform-origin:9.1px 9px"/></g></svg>`
    );
  }
  /** Mark build: the tile pops in, the D strokes on, the dot lands. */
  function drawMark(svg, t, at) {
    const tile = svg.querySelector(".dm-tile");
    const d = svg.querySelector(".dm-d");
    const dot = svg.querySelector(".dm-dot");
    const pt = seg(t, at, 0.5, ease.outBack);
    const pd = seg(t, at + 0.18, 0.55, ease.inOut);
    const pp = seg(t, at + 0.55, 0.35, ease.outBack);
    tile.style.transform = `scale(${lerp(0.6, 1, pt).toFixed(4)})`;
    svg.style.opacity = seg(t, at, 0.25, ease.linear).toFixed(4);
    d.style.strokeDashoffset = (1 - pd).toFixed(4);
    dot.style.transform = `scale(${pp.toFixed(4)})`;
  }

  // No count-up helper on purpose: a number that ticks up shows values that are not in the results.
  const fmt = {
    usd: (v, digits = 2) => `$${v.toFixed(digits)}`,
    secs: (ms) => `${(ms / 1000).toFixed(1)} s`,
    date: (iso) => {
      const [y, m, d] = iso.split("-").map(Number);
      const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
      return `${mon} ${d}, ${y}`;
    },
  };

  function clip(def) {
    const fps = def.fps ?? 30;
    let inited = false;
    const init = () => {
      if (inited) return;
      inited = true;
      def.init?.();
    };
    const ready = document.fonts.ready.then(() => {
      init();
      def.frame(0);
    });
    const api = {
      duration: def.duration,
      fps,
      frames: Math.round(def.duration * fps),
      ready,
      /** Draws time t, then waits two animation frames so the screenshot sees the new styles painted. */
      frame(t) {
        init();
        def.frame(t);
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(t))));
      },
    };
    window.__dh = api;
    if (window.__DH_RENDER__) return;

    // Preview in a normal browser window: fit the stage, then play in real time (1 s hold before the loop).
    ready.then(() => {
      const stage = document.querySelector(".stage");
      const fit = () => {
        const s = Math.min(innerWidth / 1920, innerHeight / 1080);
        stage.style.transform = `translate(${(innerWidth - 1920 * s) / 2}px,${(innerHeight - 1080 * s) / 2}px) scale(${s})`;
      };
      fit();
      addEventListener("resize", fit);
      const fixed = new URLSearchParams(location.search).get("t");
      if (fixed !== null) {
        def.frame(Number(fixed));
        return;
      }
      const t0 = performance.now();
      const tick = (now) => {
        const t = ((now - t0) / 1000) % (def.duration + 1);
        def.frame(Math.min(t, def.duration - 1 / fps));
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  window.DH = { clamp, lerp, ease, seg, fx, rise, mark, drawMark, fmt, clip };
})();

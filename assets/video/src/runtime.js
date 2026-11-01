// Dockhand motion graphics runtime. Every clip draws itself as a pure function of time: a page calls
// DH.clip({ duration, init, frame(t) }) and frame(t) sets every animated style from t alone (no CSS animations,
// no transitions, no timers, no randomness). render.ts sets window.__DH_RENDER__ before the page loads, awaits
// window.__dh.ready, then calls window.__dh.frame(n / fps) and screenshots each frame. Opened directly in a
// browser, the clip plays in real time and loops; ?t=4.2 freezes it at 4.2 s.
//
// The motion vocabulary is deliberately small: hard cuts, overlays that fade in over 150 ms, and at most one
// push-in per shot (ease-out, 500-700 ms, at most 1.15x). No blur, no bounce, no count-up.
(() => {
  const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
  const lerp = (a, b, p) => a + (b - a) * p;
  const ease = {
    linear: (x) => x,
    out: (x) => 1 - (1 - x) ** 3,
  };
  /** Eased progress 0..1 of a segment that starts at `at` and lasts `dur` seconds. */
  const seg = (t, at, dur, e = ease.out) => e(clamp((t - at) / dur));
  const r2 = (v) => Math.round(v * 100) / 100;

  /** Sets an element's look. o: opacity; x, y: px offsets; s: scale. */
  function fx(el, { o = 1, x = 0, y = 0, s = 1 } = {}) {
    const op = clamp(o);
    el.style.opacity = op < 0.002 ? "0" : op > 0.998 ? "1" : op.toFixed(4);
    el.style.visibility = op < 0.002 ? "hidden" : "visible";
    el.style.transform = `translate(${r2(x)}px,${r2(y)}px)${s === 1 ? "" : ` scale(${s.toFixed(4)})`}`;
  }

  /** An overlay: fades in over 150 ms at `at`; with `out`, fades out over 150 ms at `out`. Returns the opacity. */
  function fade(el, t, at, out = Number.POSITIVE_INFINITY) {
    const o = seg(t, at, 0.15, ease.linear) * (1 - seg(t, out, 0.15, ease.linear));
    fx(el, { o });
    return o;
  }

  /** A hard cut: visible from `at` until `until`. */
  function cut(el, t, at, until = Number.POSITIVE_INFINITY) {
    fx(el, { o: t >= at && t < until ? 1 : 0 });
  }

  /** The one push-in a shot may have: ease-out over 600 ms from 1 to `to` (at most 1.15), about `origin`. */
  function push(el, t, at, to = 1.06, origin = "50% 50%") {
    el.style.transformOrigin = origin;
    el.style.transform = `scale(${lerp(1, Math.min(to, 1.15), seg(t, at, 0.6, ease.out)).toFixed(4)})`;
  }

  // No count-up helper on purpose: a number that ticks up shows values that are not in the results.
  const fmt = {
    usd: (v, digits = 2) => `$${v.toFixed(digits)}`,
    secs: (ms) => `${(ms / 1000).toFixed(1)} s`,
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

  window.DH = { clamp, lerp, ease, seg, fx, fade, cut, push, fmt, clip };
})();

// Dockhand chart primitives (browser, classic script: window.DHChart). The title states the finding, the subtitle
// the unit; horizontal hairline gridlines, a white zero line; every series is labelled directly where it ends, in
// words. No legends, no markers or dots on lines, no rounded bars. Lemon is Dockhand, once per frame; gray is the
// comparison; a dashed gray line is a projection. Sizes are 1080p frame px (film scale). Colors are
// packages/design/src/tokens.ts (text, gray, hair, accent).
(() => {
  const NS = "http://www.w3.org/2000/svg";
  const TEXT = "#FFFFFF";
  const GRAY = "#A4AEA6";
  const HAIR = "#262C28";
  const ACCENT = "#F9E76A";
  const f2 = (v) => Number(v).toFixed(2);

  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  const group = (svg, id) => el("g", id ? { id } : {}, svg);

  /** Text. cls: "tick" (gray), "lbl" (label), "val" (value), "note" (gray). */
  function text(g, x, y, s, cls = "lbl", anchor = "start", fill) {
    return el(
      "text",
      { x: f2(x), y: f2(y), class: cls, "text-anchor": anchor, ...(fill ? { style: `fill:${fill}` } : {}) },
      g,
      s,
    );
  }

  /** A y axis: hairline gridlines at each step above zero, a white zero line, tick labels at the left. */
  function axisY(g, box, max, step, fmt = (v) => String(v)) {
    const Y = (v) => box.B - (v / max) * (box.B - box.T);
    for (let v = step; v < max - 1e-9; v += step) {
      el("line", { x1: box.L, x2: box.R, y1: f2(Y(v)), y2: f2(Y(v)), stroke: HAIR, "stroke-width": 2 }, g);
      text(g, box.L - 20, Y(v) + 13, fmt(v), "tick", "end");
    }
    el("line", { x1: box.L, x2: box.R, y1: box.B, y2: box.B, stroke: TEXT, "stroke-width": 2 }, g);
    text(g, box.L - 20, box.B + 13, fmt(0), "tick", "end");
    return Y;
  }

  /**
   * An x axis under the zero line: short ticks and labels on one row, the unit in the first label ("Run 1"), so the
   * chart needs no axis-title row for a caption to clip. The first and last labels stay inside the plot.
   */
  function axisX(g, box, max, ticks, unit) {
    const X = (v) => box.L + (v / max) * (box.R - box.L);
    ticks.forEach((v, i) => {
      el(
        "line",
        { x1: f2(X(v)), x2: f2(X(v)), y1: box.B, y2: box.B + 12, stroke: TEXT, "stroke-width": 2 },
        g,
      );
      const edge = i === 0 ? "start" : i === ticks.length - 1 ? "end" : "middle";
      text(g, X(v), box.B + 56, i === 0 && unit ? `${unit} ${v}` : String(v), "tick", edge);
    });
    return X;
  }

  /** A series as a line from index a to b (inclusive). No markers. */
  function line(g, X, Y, series, a, b, o = {}) {
    let d = "";
    for (let i = a; i <= b; i++) d += `${i === a ? "M" : "L"}${f2(X(i))},${f2(Y(series[i]))}`;
    return el(
      "path",
      {
        d,
        fill: "none",
        stroke: o.color ?? TEXT,
        "stroke-width": o.width ?? 5,
        "stroke-linejoin": "round",
        "stroke-linecap": "butt",
        ...(o.dash ? { "stroke-dasharray": o.dash } : {}),
      },
      g,
    );
  }

  /** A square-cornered horizontal bar. */
  function bar(g, x, y, w, h, color = TEXT) {
    return el("rect", { x: f2(x), y: f2(y), width: f2(Math.max(0, w)), height: h, fill: color }, g);
  }

  /** An annotation: a thin leader (no arrowhead) from a point to its text. */
  function annotation(g, from, to, s, anchor = "start") {
    el(
      "line",
      { x1: f2(from.x), y1: f2(from.y), x2: f2(to.x), y2: f2(to.y), stroke: GRAY, "stroke-width": 2 },
      g,
    );
    return text(g, to.x + (anchor === "end" ? -10 : 10), to.y + 13, s, "note", anchor);
  }

  /**
   * Cumulative cost, run by run: computer use solid while measured, dashed once projected; Dockhand in `dockColor`
   * (lemon unless the frame's one lemon is already spent). Each line is labelled where it ends: to its right with
   * `o.side` when the box leaves room, otherwise above the end of the line. Returns the groups to reveal, in order.
   */
  function costChart(svg, box, data, o = {}) {
    const C = data.cost;
    const N = C.totalRuns;
    const M = C.measuredCuRuns;
    const cu = [0, ...C.cuCum];
    const co = [0, ...C.compileCum];
    const axes = group(svg, "axes");
    const Y = axisY(axes, box, o.yMax ?? 12, o.yStep ?? 4, (v) => `$${v}`);
    const X = axisX(axes, box, N, o.xTicks ?? [1, 25, 50, 75, N], o.xUnit ?? "Run");
    const usd = (v) => `$${v.toFixed(2)}`;

    const measured = group(svg, "cuMeasured");
    line(measured, X, Y, cu, 0, M, { color: GRAY });
    const projected = group(svg, "cuProjected");
    line(projected, X, Y, cu, M, N, { color: GRAY, dash: "14 12" });
    const dock = group(svg, "dockhand");
    line(dock, X, Y, co, 0, N, { color: o.dockColor ?? ACCENT, width: 8 });

    const cuLabel = group(svg, "cuLabel");
    const dockLabel = group(svg, "dockLabel");
    const rows = (g, x, y, lines, anchor) => {
      lines.forEach((s, i) => {
        text(g, x, y + i * 50, s, i === 0 ? "lbl" : "note", anchor);
      });
    };
    if (o.side) {
      const x = box.R + 32;
      text(cuLabel, x, Y(cu[N]) + 24, usd(C.cuTotalUsd), "val", "start", GRAY);
      rows(cuLabel, x, Y(cu[N]) + 84, o.cuLines ?? ["Computer use every run"], "start");
      text(dockLabel, x, Y(co[N]) - 96, usd(C.compileTotalUsd), "val", "start");
      rows(dockLabel, x, Y(co[N]) - 44, o.dockLines ?? ["Dockhand"], "start");
    } else {
      const x = X(N) - 24;
      rows(cuLabel, x, Y(cu[N]) - 76, o.cuLines ?? ["Computer use every run"], "end");
      text(cuLabel, x, Y(cu[N]) - 14, usd(C.cuTotalUsd), "val", "end", GRAY);
      rows(dockLabel, x, Y(co[N]) - 84, o.dockLines ?? ["Dockhand"], "end");
      text(dockLabel, x, Y(co[N]) - 22, usd(C.compileTotalUsd), "val", "end");
    }
    return { axes, measured, projected, cuLabel, dock, dockLabel, X, Y };
  }

  /**
   * The same cases for each arm, as horizontal bars on one 0..cases scale with a hairline at the end of the scale.
   * Each bar is labelled above in words and at its end with the count. rows: [{ name, qual, handled, cases, dock }];
   * the `dock` row is Dockhand's, and takes the frame's lemon.
   */
  function armBars(svg, box, rows, o = {}) {
    const cases = rows[0]?.cases ?? 1;
    const W = box.R - box.L;
    const pitch = o.pitch ?? 150;
    const h = o.barHeight ?? 44;
    const groups = [];
    const frame = group(svg, "scale");
    const top = box.T;
    const first = top + 56;
    const bottom = top + (rows.length - 1) * pitch + 56 + h + 14;
    // The scale: a white zero line, a hairline at all the cases, and their values below.
    el("line", { x1: box.R, x2: box.R, y1: first - 10, y2: bottom, stroke: HAIR, "stroke-width": 2 }, frame);
    el("line", { x1: box.L, x2: box.R, y1: bottom, y2: bottom, stroke: TEXT, "stroke-width": 2 }, frame);
    text(frame, box.L, bottom + 50, "0", "tick", "start");
    text(frame, box.R, bottom + 50, String(cases), "tick", "middle");
    rows.forEach((r, i) => {
      const g = group(svg, `arm${i}`);
      const y = top + i * pitch + 56;
      const t = text(g, box.L + 0, y - 18, r.name, "lbl", "start");
      if (r.qual) el("tspan", { class: "note" }, t, `, ${r.qual}`);
      const w = (r.handled / cases) * W;
      bar(g, box.L, y, w, h, r.dock ? ACCENT : GRAY);
      text(g, box.L + w + 20, y + h - 2, `${r.handled}`, "val", "start", r.dock ? TEXT : GRAY);
      groups.push(g);
    });
    return { frame, groups };
  }

  window.DHChart = {
    el,
    group,
    text,
    axisY,
    axisX,
    line,
    bar,
    annotation,
    costChart,
    armBars,
    TEXT,
    GRAY,
    HAIR,
    ACCENT,
  };
})();

// Human-paced browser actions for screen recordings: a visible arrow cursor drawn into the page
// (headless recordings show no system cursor), eased mouse travel, wheel scrolling and typing with
// seeded, uneven key timing. Every action is a real Playwright mouse/keyboard event at the point the
// arrow shows.

import type { Locator, Page } from "playwright";
import { between, createRng, type Rng } from "./html.ts";

/**
 * Plain JS (not a serialized TS function, which tsx could decorate with helpers the page lacks).
 * Installs window.__dhCursor with moveTo(x, y, ms) and ripple(). The arrow lives on <html>, outside
 * the app root, so client-side navigation never removes it.
 */
export const CURSOR_OVERLAY_JS = `(() => {
  if (window.__dhCursor) return;
  let x = 930, y = 260, el = null;
  const arrow = '<svg width="24" height="30" viewBox="0 0 24 30"><path d="M3 2.5 L3 23.5 L8.6 18.3 L12.3 27 L16.2 25.3 L12.6 16.8 L20 16.8 Z" fill="#111" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>';
  const ensure = () => {
    if (el && el.isConnected) return el;
    el = document.createElement("div");
    el.setAttribute("aria-hidden", "true");
    el.style.cssText = "position:fixed;left:0;top:0;width:24px;height:30px;margin:-3px 0 0 -3px;z-index:2147483647;pointer-events:none;will-change:transform;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.35))";
    el.innerHTML = arrow;
    document.documentElement.appendChild(el);
    return el;
  };
  const place = () => { ensure().style.transform = "translate(" + x + "px," + y + "px)"; };
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  window.__dhCursor = {
    moveTo(tx, ty, ms) {
      return new Promise((resolve) => {
        const sx = x, sy = y, t0 = performance.now();
        // A slight arc, like a wrist movement, instead of a ruler-straight line.
        const cx = (sx + tx) / 2 + (ty - sy) * 0.12, cy = (sy + ty) / 2 - (tx - sx) * 0.12;
        const step = (now) => {
          const t = Math.min(1, (now - t0) / ms), e = ease(t), u = 1 - e;
          x = u * u * sx + 2 * u * e * cx + e * e * tx;
          y = u * u * sy + 2 * u * e * cy + e * e * ty;
          place();
          if (t < 1) requestAnimationFrame(step); else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    ripple() {
      const r = document.createElement("div");
      r.setAttribute("aria-hidden", "true");
      r.style.cssText = "position:fixed;left:" + (x - 15) + "px;top:" + (y - 15) + "px;width:30px;height:30px;border-radius:50%;border:2px solid rgba(37,99,235,.9);background:rgba(37,99,235,.18);z-index:2147483646;pointer-events:none;transform:scale(.35);opacity:1;transition:transform .38s ease-out,opacity .38s ease-out";
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = "scale(1.35)"; r.style.opacity = "0"; }));
      setTimeout(() => r.remove(), 500);
    },
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", place); else place();
})();`;

export interface Human {
  pause(minMs: number, maxMs: number): Promise<void>;
  /** Wheel-scrolls until the element's centre sits inside [top, bottom] of the viewport. */
  scrollInto(target: Locator, zone?: { top: number; bottom: number }): Promise<void>;
  moveTo(x: number, y: number): Promise<void>;
  /** "field": a point in the left part of an input, where people click; "center" otherwise. */
  click(target: Locator, aim?: "field" | "center"): Promise<void>;
  type(text: string): Promise<void>;
  fill(target: Locator, text: string): Promise<void>;
  /** Opens a combobox, optionally types a filter, then clicks the option by its accessible name. */
  pick(combobox: Locator, option: string, query?: string): Promise<void>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createHuman(page: Page, seed: number): Human {
  const rng: Rng = createRng(seed);
  let pos = { x: 930, y: 260 };

  async function pause(minMs: number, maxMs: number): Promise<void> {
    await sleep(between(rng, minMs, maxMs));
  }

  async function moveTo(x: number, y: number): Promise<void> {
    const dist = Math.hypot(x - pos.x, y - pos.y);
    const ms = Math.round(Math.min(900, Math.max(260, 200 + dist * 0.75)));
    await page.evaluate((a) => (window as unknown as CursorWindow).__dhCursor.moveTo(a.x, a.y, a.ms), {
      x,
      y,
      ms,
    });
    await page.mouse.move(x, y);
    pos = { x, y };
  }

  async function scrollInto(target: Locator, zone = { top: 140, bottom: 470 }): Promise<void> {
    const viewportHeight = page.viewportSize()?.height ?? 800;
    for (let i = 0; i < 40; i++) {
      const box = await target.boundingBox();
      if (!box) throw new Error("scroll target is not visible");
      const centre = box.y + box.height / 2;
      if (centre >= zone.top && centre <= zone.bottom) return;
      const want = centre - (zone.top + zone.bottom) / 2;
      const step = Math.sign(want) * Math.min(Math.abs(want), between(rng, 95, 125));
      await page.mouse.wheel(0, step);
      await pause(70, 110);
      const moved = (await target.boundingBox())?.y !== box.y;
      // At the top or bottom of the page: good enough when the element is fully on screen.
      if (!moved && box.y >= 0 && box.y + box.height <= viewportHeight) return;
    }
    throw new Error("could not scroll the target into view");
  }

  async function aimAt(target: Locator, aim: "field" | "center"): Promise<{ x: number; y: number }> {
    const box = await target.boundingBox();
    if (!box) throw new Error("click target is not visible");
    const x =
      aim === "field"
        ? box.x + Math.min(box.width * 0.3, 70 + between(rng, 0, 50))
        : box.x + box.width / 2 + between(rng, -box.width * 0.12, box.width * 0.12);
    const y = box.y + box.height / 2 + between(rng, -box.height * 0.15, box.height * 0.15);
    return { x: Math.round(x), y: Math.round(y) };
  }

  async function click(target: Locator, aim: "field" | "center" = "center"): Promise<void> {
    await scrollInto(target);
    const p = await aimAt(target, aim);
    await moveTo(p.x, p.y);
    await pause(90, 170);
    await page.evaluate(() => (window as unknown as CursorWindow).__dhCursor.ripple());
    await page.mouse.click(p.x, p.y);
  }

  async function type(text: string): Promise<void> {
    let prev = "";
    for (const ch of text) {
      await page.keyboard.type(ch);
      let delay = between(rng, 60, 135);
      if (ch === " ") delay += 55;
      if (ch === "@" || ch === "." || ch === "/") delay += 70;
      if (prev === ch) delay -= 20;
      if (rng() < 0.05) delay += between(rng, 150, 320);
      prev = ch;
      await sleep(delay);
    }
  }

  async function fill(target: Locator, text: string): Promise<void> {
    await click(target, "field");
    await pause(140, 260);
    await type(text);
    await pause(200, 380);
  }

  async function pick(combobox: Locator, option: string, query?: string): Promise<void> {
    await click(combobox, "field");
    await pause(260, 420);
    if (query) {
      await type(query);
      await pause(300, 450);
    }
    const opt = page.getByRole("option", { name: option, exact: true });
    await opt.waitFor({ state: "visible" });
    const p = await aimAt(opt, "field");
    await moveTo(p.x, p.y);
    await pause(160, 280);
    await page.evaluate(() => (window as unknown as CursorWindow).__dhCursor.ripple());
    await page.mouse.click(p.x, p.y);
    await pause(250, 400);
  }

  return { pause, scrollInto, moveTo, click, type, fill, pick };
}

interface CursorWindow {
  __dhCursor: { moveTo(x: number, y: number, ms: number): Promise<void>; ripple(): void };
}

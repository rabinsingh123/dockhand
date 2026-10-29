// One shared Chromium; a fresh context per lease with fixed geometry; lease TTLs; a cap on open contexts.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  type BrowserPool,
  type Clock,
  type CookieSpec,
  type Id,
  type Lease,
  systemClock,
  VIEWPORT,
} from "@dockhand/core";
import { type Browser, type BrowserContext, chromium, type LaunchOptions, type Page } from "playwright";
import { DH_SCRIPT } from "./dom/script.ts";
import { trackNetwork } from "./helpers/settle.ts";
import { attachHud, HUD_SCRIPT, type HudOptions, hudOptionsFromEnv } from "./hud/hud.ts";
import { renderHtmlWith } from "./render.ts";

// Playwright adds these only in headless mode; headed runs need them for the same layout (no 15 px scrollbar,
// fine pointer and hover media features even on a touchscreen laptop).
const HEADED_ARGS = [
  "--hide-scrollbars",
  "--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4",
];

export const CONTEXT_DEFAULTS = {
  viewport: { width: VIEWPORT.w, height: VIEWPORT.h },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
  timezoneId: "America/Sao_Paulo",
  locale: "en-US",
  colorScheme: "light",
} as const;

export interface BrowserPoolConfig {
  headless: boolean;
  /** Open contexts at most; further leases wait in FIFO order. */
  maxContexts: number;
  /** `<portalId>.json` here, if present, seeds the context's storage state (saved logins). */
  storageStateDir: string;
  clock?: Clock;
  /** Extra launch options (tests: executablePath, slowMo). */
  launch?: LaunchOptions;
  /**
   * Demo overlay on every leased page (null: off). Default: from DEMO_MODE / DEMO_PACING_MS, and only for a
   * headed browser, so headless tests and evals never get it.
   */
  hud?: HudOptions | null;
}

export interface DockhandBrowserPool extends BrowserPool {
  /** Renders HTML in the shared browser to a PNG of exactly w x h CSS pixels (fullPage: full height). */
  renderHtml(
    html: string,
    size: { w: number; h: number },
    opts?: { fullPage?: boolean; scale?: number },
  ): Promise<Uint8Array>;
  /** Writes the lease's cookies and storage to `<storageStateDir>/<portalId>.json`; returns the path. */
  saveStorageState(portalId: string, page: Page): Promise<string>;
  openContexts(): number;
  waiting(): number;
}

export function launchArgs(headless: boolean): string[] {
  return headless ? [] : [...HEADED_ARGS];
}

function storageFile(dir: string, portalId: string): string {
  return join(dir, `${portalId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

interface Waiter {
  resolve(): void;
  reject(e: Error): void;
}

export function createBrowserPool(cfg: BrowserPoolConfig): DockhandBrowserPool {
  if (cfg.maxContexts < 1) throw new RangeError("maxContexts must be at least 1");
  const clock = cfg.clock ?? systemClock;
  const hud = cfg.hud !== undefined ? cfg.hud : cfg.headless ? null : hudOptionsFromEnv();
  let browserPromise: Promise<Browser> | null = null;
  let open = 0;
  const waiters: Waiter[] = [];
  const leases = new Set<{ close(reason: "release" | "expired" | "shutdown"): Promise<void> }>();

  function browser(): Promise<Browser> {
    if (!browserPromise) {
      const launching = chromium.launch({
        ...cfg.launch,
        headless: cfg.headless,
        args: [...launchArgs(cfg.headless), ...(cfg.launch?.args ?? [])],
      });
      browserPromise = launching;
      launching.then(
        (b) =>
          b.on("disconnected", () => {
            if (browserPromise === launching) browserPromise = null;
          }),
        () => {
          if (browserPromise === launching) browserPromise = null;
        },
      );
    }
    return browserPromise;
  }

  function acquireSlot(): Promise<void> {
    if (open < cfg.maxContexts) {
      open++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  }

  function releaseSlot(): void {
    const next = waiters.shift();
    if (next)
      next.resolve(); // the slot passes straight to the next waiter
    else open--;
  }

  async function newContext(portalId: string): Promise<BrowserContext> {
    const state = storageFile(cfg.storageStateDir, portalId);
    const context = await (await browser()).newContext({
      ...CONTEXT_DEFAULTS,
      ...(existsSync(state) ? { storageState: state } : {}),
    });
    await context.addInitScript({ content: DH_SCRIPT });
    if (hud) await context.addInitScript({ content: HUD_SCRIPT });
    return context;
  }

  async function lease(o: {
    portalId: string;
    runId: Id;
    cookies?: CookieSpec[];
    ttlMs: number;
  }): Promise<Lease> {
    await acquireSlot();
    let context: BrowserContext;
    let page: Page;
    try {
      context = await newContext(o.portalId);
      if (o.cookies?.length) await context.addCookies(o.cookies);
      page = await context.newPage();
      trackNetwork(page);
      if (hud) attachHud(page, hud);
    } catch (e) {
      releaseSlot();
      throw e;
    }
    let expiresAt = clock.now() + o.ttlMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed: Promise<void> | null = null;

    const entry = {
      close(reason: "release" | "expired" | "shutdown"): Promise<void> {
        closed ??= (async () => {
          if (timer) clearTimeout(timer);
          leases.delete(entry);
          await context.close({ reason: `dockhand lease ${reason}` }).catch(() => {});
          releaseSlot();
        })();
        return closed;
      },
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void entry.close("expired"), Math.max(0, expiresAt - clock.now()));
      timer.unref?.();
    };
    leases.add(entry);
    arm();

    return {
      page,
      get expiresAt() {
        return expiresAt;
      },
      extend(ms: number) {
        if (closed) return;
        expiresAt = Math.max(expiresAt, clock.now() + ms);
        arm();
      },
      release: () => entry.close("release"),
    };
  }

  async function closeAll(): Promise<void> {
    for (const w of waiters.splice(0)) w.reject(new Error("browser pool closed"));
    await Promise.all([...leases].map((l) => l.close("shutdown")));
    const current = browserPromise;
    browserPromise = null;
    if (current) await (await current.catch(() => null))?.close().catch(() => {});
  }

  return {
    lease,
    closeAll,
    async renderHtml(html, size, opts) {
      return renderHtmlWith(await browser(), html, size, opts);
    },
    async saveStorageState(portalId, page) {
      await mkdir(cfg.storageStateDir, { recursive: true });
      const path = storageFile(cfg.storageStateDir, portalId);
      await page.context().storageState({ path });
      return path;
    },
    openContexts: () => open,
    waiting: () => waiters.length,
  };
}

/**
 * Closes the pool's browser on Ctrl+C, SIGTERM and (Windows) Ctrl+Break, then exits with 128 + signal number,
 * so no orphaned Chromium outlives the dev process. Returns a function that removes the handlers.
 */
export function closeBrowserOnSignals(
  pool: Pick<BrowserPool, "closeAll">,
  opts: { exit?: (code: number) => void; graceMs?: number } = {},
): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const signals: [NodeJS.Signals, number][] = [
    ["SIGINT", 2],
    ["SIGTERM", 15],
  ];
  if (process.platform === "win32") signals.push(["SIGBREAK", 21]);
  let closing = false;
  const handlers = signals.map(([signal, n]) => {
    const handler = () => {
      if (closing) return;
      closing = true;
      const grace = new Promise<void>((r) => setTimeout(r, opts.graceMs ?? 5000).unref?.());
      void Promise.race([pool.closeAll().catch(() => {}), grace]).then(() => exit(128 + n));
    };
    process.on(signal, handler);
    return { signal, handler };
  });
  return () => {
    for (const { signal, handler } of handlers) process.off(signal, handler);
  };
}

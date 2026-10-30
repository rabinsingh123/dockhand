import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBrowserPool } from "../pool.ts";
import { launchTestBrowser } from "../test-support.ts";
import { concatScript, encodeClip, readClipInfo, readIndex, startScreencast } from "./screencast.ts";

describe("concatScript", () => {
  it("holds each frame until the next one, quantized to output frames from the first frame", () => {
    const s = concatScript(
      [
        { f: "a.jpg", t: 1000 },
        { f: "b.jpg", t: 1010 }, // same output frame as a: a is superseded
        { f: "c.jpg", t: 1100 },
      ],
      2000,
      30,
    );
    expect(s.split("\n")).toEqual([
      "ffconcat version 1.0",
      "file 'frames/b.jpg'",
      "duration 0.100000",
      "file 'frames/c.jpg'",
      "duration 0.900000",
      "file 'frames/c.jpg'",
      "",
    ]);
  });

  it("gives a lone frame at least one output frame", () => {
    expect(concatScript([{ f: "a.jpg", t: 5000 }], 5000, 30)).toContain("duration 0.033333");
  });
});

describe("startScreencast and encodeClip", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await launchTestBrowser();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("films a headless page into a constant 30 fps clip whose length is the wall-clock time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dockhand-capture-"));
    const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
    await page.setContent(
      "<body style='margin:0;background:#fff'><div id=b style='width:80px;height:80px;background:red'></div>",
    );
    const cap = await startScreencast(page, { dir, label: "unit", meta: { runId: "r1" } });
    for (let i = 1; i <= 8; i++) {
      await page.evaluate((x) => {
        (document.getElementById("b") as HTMLElement).style.marginLeft = `${x}px`;
      }, i * 50);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(400); // a still stretch: no frames, but the clip still lasts
    const info = await cap.stop();
    await page.close();
    expect(info.frames).toBeGreaterThanOrEqual(2);
    expect(info.startedAt).not.toBeNull();
    expect(info.width).toBe(640);
    expect(readClipInfo(cap.folder)?.meta).toEqual({ runId: "r1" });
    expect(readIndex(cap.folder).length).toBe(info.frames);
    const out = await encodeClip(cap.folder);
    expect(out && existsSync(out)).toBe(true);
    const probe = JSON.parse(
      execFileSync("ffprobe", [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=r_frame_rate,nb_read_frames,width,height",
        "-of",
        "json",
        out as string,
      ]).toString(),
    ) as { streams: { r_frame_rate: string; nb_read_frames: string; width: number; height: number }[] };
    const s = probe.streams[0];
    expect(s?.r_frame_rate).toBe("30/1");
    expect([s?.width, s?.height]).toEqual([640, 400]);
    const wallFrames = (((info.endedAt as number) - (info.startedAt as number)) / 1000) * 30;
    expect(Math.abs(Number(s?.nb_read_frames) - wallFrames)).toBeLessThanOrEqual(2);
  });

  it("films every page a capture-enabled pool leases, with the HUD on even headless", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dockhand-capture-pool-"));
    const stateDir = mkdtempSync(join(tmpdir(), "dockhand-capture-state-"));
    const pool = createBrowserPool({
      headless: true,
      maxContexts: 1,
      storageStateDir: stateDir,
      capture: { dir },
      hud: { pacingMs: 0, metaMode: "fake" },
    });
    try {
      const lease = await pool.lease({ portalId: "portal", runId: "run-1", ttlMs: 60_000 });
      await lease.page.setContent("<h1>filmed</h1>");
      // A page that never changes after the screencast starts may send no frame at all: change it a few times.
      for (const color of ["#eee", "#ddd", "#ccc", "#bbb"]) {
        await lease.page.evaluate((c) => {
          document.body.style.background = c;
        }, color);
        await lease.page.waitForTimeout(150);
      }
      await lease.release();
      const folders = readdirSync(dir);
      expect(folders).toHaveLength(1);
      const info = readClipInfo(join(dir, folders[0] as string));
      expect(info?.meta).toEqual({ portalId: "portal", runId: "run-1" });
      expect(info?.endedAt).not.toBeNull();
      expect(info?.frames).toBeGreaterThan(0);
      expect(pool.setHudPacing(400)).toBe(true);
    } finally {
      await pool.closeAll();
    }
  });
});

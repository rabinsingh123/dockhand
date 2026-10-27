// Kept in its own file (own process, no browser launched): Playwright installs its own SIGINT handler while a
// browser it launched is running, and that handler exits the process.
import { describe, expect, it } from "vitest";
import { closeBrowserOnSignals } from "./pool.ts";

describe("closeBrowserOnSignals", () => {
  it("closes the pool on SIGINT and exits with 130, once", async () => {
    let closed = 0;
    const exits: number[] = [];
    const uninstall = closeBrowserOnSignals(
      {
        closeAll: async () => {
          closed++;
        },
      },
      { exit: (code) => exits.push(code) },
    );
    try {
      process.emit("SIGINT");
      process.emit("SIGINT");
      await expect.poll(() => exits).toEqual([130]);
      expect(closed).toBe(1);
    } finally {
      uninstall();
    }
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("exits with 128 + signal number for SIGTERM, and on Windows for SIGBREAK", async () => {
    const exits: number[] = [];
    const uninstall = closeBrowserOnSignals(
      { closeAll: async () => {} },
      { exit: (code) => exits.push(code) },
    );
    try {
      process.emit(process.platform === "win32" ? "SIGBREAK" : "SIGTERM");
      await expect.poll(() => exits).toEqual([process.platform === "win32" ? 149 : 143]);
    } finally {
      uninstall();
    }
  });
});

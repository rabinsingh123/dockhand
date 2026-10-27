import { describe, expect, it, vi } from "vitest";

// Own file: node:sqlite must not be loaded yet in this worker when openDb() runs for the first time.
describe("openDb warning filter", () => {
  it("drops only node:sqlite's ExperimentalWarning", async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(process, "emitWarning").mockImplementation(((warning: string | Error) => {
      seen.push(typeof warning === "string" ? warning : warning.message);
    }) as typeof process.emitWarning);
    try {
      const { openDb } = await import("./db.ts");
      openDb(":memory:").close();
      expect(seen.filter((m) => m.includes("SQLite"))).toEqual([]);

      process.emitWarning("something else is experimental", "ExperimentalWarning");
      process.emitWarning(
        "SQLite is an experimental feature (but a DeprecationWarning)",
        "DeprecationWarning",
      );
      expect(seen).toEqual([
        "something else is experimental",
        "SQLite is an experimental feature (but a DeprecationWarning)",
      ]);
    } finally {
      spy.mockRestore();
    }
  });
});

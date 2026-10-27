import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { varDir, workspaceRoot } from "./paths.ts";

describe("paths", () => {
  it("finds the workspace root from the module location", () => {
    const root = workspaceRoot();
    expect(existsSync(join(root, "pnpm-workspace.yaml"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name).toBe("dockhand");
  });

  it("puts runtime data in <root>/var and creates it", () => {
    const dir = varDir();
    expect(dir).toBe(join(workspaceRoot(), "var"));
    expect(existsSync(dir)).toBe(true);
  });
});

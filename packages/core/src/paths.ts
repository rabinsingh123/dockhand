import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The directory holding pnpm-workspace.yaml, found by walking up from this file.
 * Never derived from cwd: pnpm runs package scripts with cwd set to the package.
 */
export function workspaceRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`pnpm-workspace.yaml not found in ${start} or any parent directory`);
    dir = parent;
  }
}

/** `<workspace root>/var` (runtime data, git-ignored), created on demand. */
export function varDir(): string {
  const dir = join(workspaceRoot(), "var");
  mkdirSync(dir, { recursive: true });
  return dir;
}

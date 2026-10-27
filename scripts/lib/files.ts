// Workspace paths and idempotent file writes for the fixture generators.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolved from this file's location, never from cwd. */
export const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES_DIR = resolve(WORKSPACE_ROOT, "fixtures");

export function fixturePath(rel: string): string {
  return resolve(FIXTURES_DIR, rel);
}

/** POSIX path relative to the workspace root, for logs and JSON references. */
export function workspaceRel(abs: string): string {
  return relative(WORKSPACE_ROOT, abs).split("\\").join("/");
}

export interface WriteResult {
  path: string;
  bytes: number;
  status: "created" | "updated" | "unchanged";
}

/** Writes only when the bytes differ, so a second run reports "unchanged" for deterministic output. */
export function writeIfChanged(absPath: string, data: Uint8Array | string): WriteResult {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data);
  const exists = existsSync(absPath);
  if (exists && Buffer.compare(readFileSync(absPath), bytes) === 0) {
    return { path: workspaceRel(absPath), bytes: bytes.length, status: "unchanged" };
  }
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, bytes);
  return { path: workspaceRel(absPath), bytes: bytes.length, status: exists ? "updated" : "created" };
}

export function toJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

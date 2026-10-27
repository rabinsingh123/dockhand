// Bundles a client entry in memory with esbuild (no Vite, nothing written to disk).
// Cached per process, so starting many portal instances (evals) bundles once.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export interface ClientBundle {
  code: string;
  hash: string;
}

const cache = new Map<string, Promise<ClientBundle>>();

export function clientEntry(name: "partner" | "supplier"): string {
  return fileURLToPath(new URL(`../client/${name}/main.tsx`, import.meta.url));
}

export function bundleClient(entry: string): Promise<ClientBundle> {
  let pending = cache.get(entry);
  if (!pending) {
    pending = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      jsx: "automatic",
      minify: true,
      legalComments: "none",
      charset: "utf8",
      define: { "process.env.NODE_ENV": '"production"' },
      logLevel: "silent",
    }).then((result) => {
      const file = result.outputFiles[0];
      if (!file) throw new Error(`esbuild produced no output for ${entry}`);
      return { code: file.text, hash: createHash("sha256").update(file.text).digest("hex").slice(0, 12) };
    });
    pending.catch(() => cache.delete(entry));
    cache.set(entry, pending);
  }
  return pending;
}

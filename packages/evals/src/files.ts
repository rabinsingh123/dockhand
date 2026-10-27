// File params. Cases are plain data, so a file param holds a placeholder ref ("fixture:<repo path>") that
// runCase turns into a real artifact in the run's own store just before the run.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ArtifactRef, ArtifactStore, ParamValue } from "@dockhand/core";
import { repoPath } from "./paths.ts";

export type FileParam = { file: ArtifactRef; filename: string };

const FIXTURE_PREFIX = "fixture:";

export function isFileParam(v: ParamValue | undefined): v is FileParam {
  return typeof v === "object" && v !== null && "file" in v;
}

/** A placeholder for a repo file (POSIX path relative to the workspace root). */
export function fixtureFile(relPath: string, filename = relPath.split("/").pop() ?? relPath): FileParam {
  return {
    file: { id: `${FIXTURE_PREFIX}${relPath}`, sha256: "", mime: "application/pdf", bytes: 0, relPath },
    filename,
  };
}

export interface MaterializedFiles {
  params: Record<string, ParamValue>;
  /** param name -> sha256 of the bytes handed to the run (ground truth checks the portal got these). */
  sha256: Record<string, string>;
}

/** Replaces fixture placeholders with artifacts in `store`; other values pass through. */
export async function materializeFiles(
  params: Record<string, ParamValue>,
  store: ArtifactStore,
): Promise<MaterializedFiles> {
  const out: Record<string, ParamValue> = {};
  const sha256: Record<string, string> = {};
  for (const [name, value] of Object.entries(params)) {
    if (isFileParam(value) && value.file.id.startsWith(FIXTURE_PREFIX)) {
      const bytes = new Uint8Array(readFileSync(repoPath(value.file.id.slice(FIXTURE_PREFIX.length))));
      const ref = await store.put(bytes, value.file.mime, {
        kind: "upload_fixture",
        filename: value.filename,
      });
      out[name] = { file: ref, filename: value.filename };
      sha256[name] = createHash("sha256").update(bytes).digest("hex");
    } else {
      out[name] = value;
    }
  }
  return { params: out, sha256 };
}

export const FIXTURE_DOCS = {
  w9: "fixtures/docs/w9-sample.pdf",
  coi: "fixtures/docs/insurance-certificate-sample.pdf",
} as const;

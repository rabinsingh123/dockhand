// The company profile Dockhand fills supplier portals from, and rep profiles.

import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { type ArtifactStore, type CompanyProfile, type RepProfile, workspaceRoot } from "@dockhand/core";
import { z } from "zod";
import type { FileParam } from "./params.ts";
import type { Repos } from "./repo.ts";

export interface CompanyKit {
  profile: CompanyProfile;
  /** Upload slot -> file, e.g. { w9, coi }. */
  files: Record<string, FileParam>;
}

const Profile = z.record(z.string(), z.string());

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** `w9File` -> `w9`, `coiFile` -> `coi`. */
export function slotForProfileKey(key: string): string {
  return key
    .replace(/File$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Reads the profile JSON (keys = the supplier portal's canonical fields) and stores every `*File` path it
 * names in the artifact store. Paths are workspace-relative unless absolute.
 */
export async function loadCompanyKit(
  artifacts: ArtifactStore,
  opts: { root?: string; path?: string } = {},
): Promise<CompanyKit> {
  const root = opts.root ?? workspaceRoot();
  const path = opts.path ?? join(root, "fixtures", "profile", "tidewater.json");
  const profile = Profile.parse(JSON.parse(await readFile(path, "utf8")));
  const files: Record<string, FileParam> = {};
  for (const [key, value] of Object.entries(profile)) {
    if (!key.endsWith("File")) continue;
    const abs = isAbsolute(value) ? value : join(root, value);
    const ext = abs.split(".").pop()?.toLowerCase() ?? "";
    const filename = basename(abs);
    const file = await artifacts.put(
      new Uint8Array(await readFile(abs)),
      MIME_BY_EXT[ext] ?? "application/octet-stream",
      {
        kind: "upload_fixture",
        filename,
      },
    );
    files[slotForProfileKey(key)] = { file, filename };
  }
  return { profile, files };
}

export const DEFAULT_REP: Omit<RepProfile, "phone"> = {
  name: "",
  tz: "America/Sao_Paulo",
  locale: "pt-BR",
  languageBias: ["Portuguese", "English"],
};

/** The rep's profile from the reps table, with Dockhand's defaults for anything unset. */
export function repProfile(repos: Repos, phone: string): RepProfile {
  const row = repos.reps.get(phone);
  return {
    phone,
    name: row?.name ?? DEFAULT_REP.name,
    tz: row?.tz ?? DEFAULT_REP.tz,
    locale: row?.locale === "en-US" ? "en-US" : "pt-BR",
    languageBias: row?.languageBias.length ? row.languageBias : DEFAULT_REP.languageBias,
  };
}

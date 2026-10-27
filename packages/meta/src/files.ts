import { type ArtifactRef, DockhandError, type Logger } from "@dockhand/core";
import { z } from "zod";
import type { ProviderClient, RequestScope } from "./http.ts";
import { baseMime } from "./media.ts";

/** FileObject from https://dev.meta.ai/docs/api-reference/files/schemas (only what we read). */
const FileObject = z.looseObject({ id: z.string().min(1), object: z.literal("file").optional() });

export interface FileUploader {
  /** Uploads once per sha256 for the life of the gateway (Files API, purpose user_data) and returns the file id. */
  fileId(ref: ArtifactRef, read: () => Promise<Uint8Array>, scope: RequestScope): Promise<string>;
}

export function createFileUploader(client: ProviderClient, log: Logger): FileUploader {
  const bySha = new Map<string, Promise<string>>();
  return {
    fileId(ref, read, scope) {
      const cached = bySha.get(ref.sha256);
      if (cached) return cached;
      const upload = (async () => {
        const bytes = await read();
        // The docs ask for purpose first and the file as the final part.
        const raw = await client.postMultipart(
          "/files",
          [
            { name: "purpose", value: "user_data" },
            { name: "file", value: bytes, filename: uploadName(ref), contentType: baseMime(ref.mime) },
          ],
          scope,
        );
        const parsed = FileObject.safeParse(raw);
        if (!parsed.success) throw new DockhandError("MODEL_ERROR", "Files API upload returned no file id");
        log.debug("file uploaded", {
          sha256: ref.sha256.slice(0, 12),
          bytes: ref.bytes,
          fileId: parsed.data.id,
        });
        return parsed.data.id;
      })();
      bySha.set(ref.sha256, upload);
      upload.catch(() => bySha.delete(ref.sha256));
      return upload;
    },
  };
}

function uploadName(ref: ArtifactRef): string {
  const last = ref.relPath.split("/").pop();
  return last && last.length > 0 ? last : ref.sha256;
}

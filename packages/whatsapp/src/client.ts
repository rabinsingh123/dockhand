import {
  type ArtifactRef,
  type ArtifactStore,
  type Button,
  DockhandError,
  type WhatsAppClient,
} from "@dockhand/core";
import { buttonProblems, captionProblems, mediaProblems, textProblems } from "./limits.ts";

export interface WhatsAppClientConfig {
  /** https://graph.facebook.com, or the emulator's `<origin>/graph`. */
  baseUrl: string;
  graphVersion: string;
  token: string;
  phoneNumberId: string;
  /** Source of the bytes for images, documents and header images (uploaded before each send). */
  artifacts: ArtifactStore;
  /** Defaults to global fetch; tests route requests to an in-process emulator. */
  fetch?: typeof fetch;
  /** Per HTTP request. Default 30 s. */
  timeoutMs?: number;
}

interface GraphErrorBody {
  error?: {
    message?: string;
    type?: string;
    code?: number;
    error_subcode?: number;
    error_data?: { details?: string };
    fbtrace_id?: string;
  };
}

interface MediaInfo {
  url?: string;
  mime_type?: string;
}

/**
 * The one WhatsApp client (Cloud API, Graph v26.0 shapes). Dev and demo differ only by baseUrl and
 * secrets. Limits are checked before any request; Graph errors become DockhandError("TOOL_ERROR").
 */
export function createWhatsAppClient(cfg: WhatsAppClientConfig): WhatsAppClient {
  const root = `${cfg.baseUrl.replace(/\/+$/, "")}/${cfg.graphVersion}`;
  const doFetch = cfg.fetch ?? globalThis.fetch;
  const timeoutMs = cfg.timeoutMs ?? 30_000;

  async function request(what: string, url: string, init: RequestInit = {}): Promise<Response> {
    let res: Response;
    try {
      res = await doFetch(url, {
        ...init,
        headers: {
          authorization: `Bearer ${cfg.token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const reason =
        err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : String(err);
      throw new DockhandError("TOOL_ERROR", `WhatsApp ${what}: request failed (${reason})`);
    }
    if (!res.ok) throw await graphError(what, res);
    return res;
  }

  async function json<T>(what: string, url: string, init?: RequestInit): Promise<T> {
    const res = await request(what, url, init);
    try {
      return (await res.json()) as T;
    } catch {
      throw new DockhandError("TOOL_ERROR", `WhatsApp ${what}: response was not JSON`);
    }
  }

  async function sendMessage(what: string, to: string, message: Record<string, unknown>): Promise<string> {
    const body = { messaging_product: "whatsapp", recipient_type: "individual", to: digits(to), ...message };
    const res = await json<{ messages?: { id?: string }[] }>(what, `${root}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const waId = res.messages?.[0]?.id;
    if (!waId) throw new DockhandError("TOOL_ERROR", `WhatsApp ${what}: response had no message id`);
    return waId;
  }

  async function upload(ref: ArtifactRef): Promise<string> {
    const data = await cfg.artifacts.read(ref);
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", ref.mime);
    // Artifact stores return plain ArrayBuffer-backed arrays; the cast only narrows the type for Blob.
    const bytes = data as Uint8Array<ArrayBuffer>;
    form.append("file", new Blob([bytes], { type: ref.mime }), ref.relPath.split("/").pop() ?? "file");
    const res = await json<{ id?: string }>("media upload", `${root}/${cfg.phoneNumberId}/media`, {
      method: "POST",
      body: form,
    });
    if (!res.id) throw new DockhandError("TOOL_ERROR", "WhatsApp media upload: response had no media id");
    return res.id;
  }

  async function mediaInfo(mediaId: string): Promise<MediaInfo> {
    const query = new URLSearchParams({ phone_number_id: cfg.phoneNumberId });
    return json<MediaInfo>("media lookup", `${root}/${encodeURIComponent(mediaId)}?${query}`);
  }

  return {
    async sendText(to, body, opts) {
      reject("text", textProblems(body));
      const context = opts?.replyTo ? { context: { message_id: opts.replyTo } } : {};
      return sendMessage("send text", to, { type: "text", text: { preview_url: false, body }, ...context });
    },

    async sendButtons(to, body, buttons: Button[], opts = {}) {
      // One header per message: the image (a filled-form screenshot) wins over header text.
      const headerText = opts.headerImage ? undefined : opts.headerText;
      reject("buttons", [
        ...buttonProblems(body, buttons, { headerText, footer: opts.footer }),
        ...(opts.headerImage ? mediaProblems("image", opts.headerImage.mime, opts.headerImage.bytes) : []),
      ]);
      const header = opts.headerImage
        ? { type: "image", image: { id: await upload(opts.headerImage) } }
        : headerText
          ? { type: "text", text: headerText }
          : undefined;
      return sendMessage("send buttons", to, {
        type: "interactive",
        interactive: {
          type: "button",
          ...(header ? { header } : {}),
          body: { text: body },
          ...(opts.footer ? { footer: { text: opts.footer } } : {}),
          action: { buttons: buttons.map((b) => ({ type: "reply", reply: { id: b.id, title: b.title } })) },
        },
      });
    },

    async sendImage(to, image, caption) {
      reject("image", [...mediaProblems("image", image.mime, image.bytes), ...captionProblems(caption)]);
      const id = await upload(image);
      return sendMessage("send image", to, { type: "image", image: { id, ...(caption ? { caption } : {}) } });
    },

    async sendDocument(to, doc, filename, caption) {
      reject("document", [...mediaProblems("document", doc.mime, doc.bytes), ...captionProblems(caption)]);
      const id = await upload(doc);
      return sendMessage("send document", to, {
        type: "document",
        document: { id, filename, ...(caption ? { caption } : {}) },
      });
    },

    async downloadMedia(mediaId) {
      // URLs expire after 5 minutes; on 404 the docs say to look the media up again and retry once.
      for (let attempt = 1; ; attempt++) {
        const info = await mediaInfo(mediaId);
        if (!info.url)
          throw new DockhandError("TOOL_ERROR", `WhatsApp media lookup: no url for media ${mediaId}`);
        try {
          const res = await request("media download", info.url);
          const data = new Uint8Array(await res.arrayBuffer());
          const mime = info.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream";
          return { data, mime };
        } catch (err) {
          const status = (err as DockhandError).detail as { status?: number } | undefined;
          if (attempt === 1 && status?.status === 404) continue;
          throw err;
        }
      }
    },

    async markRead(waId) {
      await json("mark read", `${root}/${cfg.phoneNumberId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", status: "read", message_id: waId }),
      });
    },
  };
}

function reject(what: string, problems: string[]): void {
  if (problems.length > 0) {
    throw new DockhandError("TOOL_ERROR", `WhatsApp ${what} message not sent: ${problems.join("; ")}`, {
      problems,
    });
  }
}

async function graphError(what: string, res: Response): Promise<DockhandError> {
  const text = await res.text().catch(() => "");
  let body: GraphErrorBody = {};
  try {
    body = JSON.parse(text) as GraphErrorBody;
  } catch {
    // not JSON (a proxy or the lookaside CDN); the status line is all we have
  }
  const err = body.error;
  const details = err?.error_data?.details;
  const message = err?.message ?? (text.slice(0, 200) || res.statusText);
  return new DockhandError(
    "TOOL_ERROR",
    `WhatsApp ${what} failed (HTTP ${res.status}): ${message}${details ? ` (${details})` : ""}`,
    {
      status: res.status,
      code: err?.code,
      subcode: err?.error_subcode,
      type: err?.type,
      fbtraceId: err?.fbtrace_id,
    },
  );
}

function digits(phone: string): string {
  return phone.replace(/^\+/, "");
}

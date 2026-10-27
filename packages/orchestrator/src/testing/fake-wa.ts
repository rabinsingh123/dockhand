// A WhatsAppClient that records what would be sent (unit tests; end-to-end tests use the emulator).

import type { ArtifactRef, Button, WhatsAppClient } from "@dockhand/core";

export type SentMessage =
  | { waId: string; type: "text"; to: string; body: string; replyTo?: string }
  | {
      waId: string;
      type: "buttons";
      to: string;
      body: string;
      buttons: Button[];
      headerImage?: ArtifactRef;
    }
  | { waId: string; type: "image"; to: string; image: ArtifactRef; caption?: string }
  | { waId: string; type: "document"; to: string; doc: ArtifactRef; filename: string; caption?: string };

export interface RecordingWhatsApp extends WhatsAppClient {
  sent: SentMessage[];
  media: Map<string, { data: Uint8Array; mime: string }>;
  /** Makes the next sendButtons call throw (tests the "card never arrived" path). */
  failNextButtons(): void;
}

export function createRecordingWhatsApp(): RecordingWhatsApp {
  let n = 0;
  let failButtons = false;
  const sent: SentMessage[] = [];
  const next = () => `wamid.out.${++n}`;
  return {
    sent,
    media: new Map(),
    failNextButtons() {
      failButtons = true;
    },
    async sendText(to, body, opts) {
      const waId = next();
      sent.push({ waId, type: "text", to, body, ...(opts?.replyTo ? { replyTo: opts.replyTo } : {}) });
      return waId;
    },
    async sendButtons(to, body, buttons, opts) {
      if (failButtons) {
        failButtons = false;
        throw new Error("WhatsApp is down");
      }
      const waId = next();
      sent.push({
        waId,
        type: "buttons",
        to,
        body,
        buttons,
        ...(opts?.headerImage ? { headerImage: opts.headerImage } : {}),
      });
      return waId;
    },
    async sendImage(to, image, caption) {
      const waId = next();
      sent.push({ waId, type: "image", to, image, ...(caption ? { caption } : {}) });
      return waId;
    },
    async sendDocument(to, doc, filename, caption) {
      const waId = next();
      sent.push({ waId, type: "document", to, doc, filename, ...(caption ? { caption } : {}) });
      return waId;
    },
    async downloadMedia(mediaId) {
      const item = this.media.get(mediaId);
      if (!item) throw new Error(`no media ${mediaId}`);
      return item;
    },
    async markRead() {},
  };
}

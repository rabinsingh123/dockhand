import type { ArtifactRef } from "./base.ts";

export type InboundKind = "text" | "audio" | "image" | "document" | "video" | "button" | "unsupported";

export interface InboundMessage {
  waId: string; // wamid.*, the dedupe key
  from: string; // E.164 digits, no '+'
  ts: number; // epoch ms
  kind: InboundKind;
  text?: string; // text body or media caption
  media?: { mediaId: string; mime: string; filename?: string; voice?: boolean };
  button?: { id: string; title: string };
  replyTo?: string; // context.id
  forwarded?: boolean; // only documented for text/image/video; never rely on it
}

export interface ParsedWebhook {
  messages: InboundMessage[];
  ignored: number; // statuses and unknown entries are counted, not parsed
}

/** Button id format: `g:<gateId>:<a|r|e>` (approve, reject, edit). Title max 20 chars. */
export interface Button {
  id: string;
  title: string;
}

/** Every send returns the outbound wamid. */
export interface WhatsAppClient {
  sendText(to: string, body: string, opts?: { replyTo?: string }): Promise<string>;
  /** 1..3 buttons; body <= 1024 chars. A header image is the way to show a filled form. */
  sendButtons(
    to: string,
    body: string,
    buttons: Button[],
    opts?: { headerImage?: ArtifactRef; headerText?: string; footer?: string },
  ): Promise<string>;
  sendImage(to: string, image: ArtifactRef, caption?: string): Promise<string>;
  sendDocument(to: string, doc: ArtifactRef, filename: string, caption?: string): Promise<string>;
  /** Media URLs expire within minutes: call this during intake, never later. */
  downloadMedia(mediaId: string): Promise<{ data: Uint8Array; mime: string }>;
  markRead(waId: string): Promise<void>;
}

export interface OutboundRecord {
  waId: string;
  to: string;
  ts: number;
  type: "text" | "interactive" | "image" | "document";
  body?: string;
  buttons?: Button[];
  caption?: string;
  headerImagePath?: string;
  media?: { mime: string; bytes: number; filename?: string; artifactPath: string };
}

/** Control surface of the fake Graph API, used by tests and the /dev/chat page. */
export interface EmulatorControl {
  /** Builds a Cloud API webhook payload, signs it with the dev app secret, POSTs it. Returns the inbound wamid. */
  send(
    from: string,
    msg: {
      text?: string;
      caption?: string;
      replyTo?: string;
      forwarded?: boolean;
      file?: { path: string; mime: string; voice?: boolean; filename?: string; asDocument?: boolean };
    },
  ): Promise<string>;
  tap(from: string, interactiveWaId: string, buttonId: string): Promise<string>;
  outbox(to?: string): OutboundRecord[];
  waitFor(pred: (m: OutboundRecord) => boolean, timeoutMs?: number): Promise<OutboundRecord>;
  reset(): void;
}

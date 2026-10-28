// The single dev process: gateway, emulator (in emulator mode) and both mock portals in one Node process.
//
// Routes on the gateway port:
//   GET  /webhook/whatsapp            Meta's verification handshake (hub.mode / hub.verify_token / hub.challenge)
//   POST /webhook/whatsapp            signed Cloud API webhooks
//   GET  /__health                    liveness + modes
// Emulator mode only (the fake Graph API and the chat page share the port):
//   POST /graph/{ver}/{phone-id}/messages, POST /graph/{ver}/{phone-id}/media, GET /graph/{ver}/{media-id}
//   GET  /lookaside/{media-id}        short-lived media download URL
//   GET  /dev/chat                    phone-sized chat UI (+ /dev/chat/events, /send, /tap, /reset, /timeline, /media/{id})
// The WhatsApp client's baseUrl is <gateway>/graph in emulator mode and https://graph.facebook.com in cloud mode.

import { join } from "node:path";
import {
  type ArtifactStore,
  type Clock,
  type Config,
  createArtifactStore,
  createLogger,
  type Db,
  type Logger,
  loadConfig,
  openDb,
  systemClock,
  varDir,
  type WhatsAppClient,
} from "@dockhand/core";
import { type PortalHandle, startPartnerPortal, startSupplierPortal } from "@dockhand/portals";
import { createEmulator, createWhatsAppClient, type Emulator } from "@dockhand/whatsapp";
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { createGatewayApp, type OnMessages } from "./app.ts";
import { createRecorder } from "./recorder/index.ts";

export const GRAPH_BASE_URL = "https://graph.facebook.com";
const DRAIN_ON_CLOSE_MS = 3_000;

export interface DevProcessOptions {
  config?: Config; // default: loadConfig()
  dbPath?: string; // default: <var>/dockhand.sqlite
  dataDir?: string; // artifacts root, default: <var>
  log?: Logger;
  clock?: Clock;
  /** Initial handler; default: the placeholder (logs; in emulator mode replies "Received <kind>"). */
  onMessages?: OnMessages;
  /** Start the mock portals (default true). */
  portals?: boolean;
  /** How long close() waits for running message handlers (default 3 s). */
  drainTimeoutMs?: number;
  /** Extra local routes mounted on the gateway port before it listens (dev tools such as GET /__dev/crm). */
  routes?: Hono;
}

export interface DevProcess {
  config: Config;
  db: Db;
  log: Logger;
  clock: Clock;
  artifacts: ArtifactStore;
  whatsapp: WhatsAppClient;
  emulator?: Emulator;
  portals?: { partner: PortalHandle; supplier: PortalHandle };
  urls: { gateway: string; webhook: string; graph: string; devChat?: string };
  /** The seam: replaces the message handler (the orchestrator plugs in here). */
  wire(onMessages: OnMessages): void;
  /** Waits until webhook-triggered work (handlers, refusals) has settled. */
  drain(): Promise<void>;
  close(): Promise<void>;
}

export async function startDevProcess(opts: DevProcessOptions = {}): Promise<DevProcess> {
  const config = opts.config ?? loadConfig();
  const log = opts.log ?? createLogger({ level: config.logLevel, fields: { svc: "gateway" } });
  const clock = opts.clock ?? systemClock;
  const cleanup: (() => Promise<void> | void)[] = [];
  const closeAll = async () => {
    for (const step of cleanup.splice(0).reverse()) {
      try {
        await step();
      } catch (err) {
        log.warn("shutdown step failed", { err });
      }
    }
  };

  try {
    const db = openDb(opts.dbPath ?? join(varDir(), "dockhand.sqlite"));
    cleanup.push(() => db.close());
    const artifacts = createArtifactStore(db, opts.dataDir ?? varDir(), clock);

    let portals: DevProcess["portals"];
    if (opts.portals !== false) {
      const partner = await startPartnerPortal({ port: config.ports.partnerPortal });
      cleanup.push(() => partner.close());
      const supplier = await startSupplierPortal({ port: config.ports.supplierPortal });
      cleanup.push(() => supplier.close());
      portals = { partner, supplier };
    }

    // The gateway URL is known only after listen (port 0 in tests); the client is built right after.
    let gatewayUrl = "";
    let whatsapp: WhatsAppClient | undefined;
    const client = () => {
      if (!whatsapp) throw new Error("WhatsApp client used before the gateway was listening");
      return whatsapp;
    };
    let handler: OnMessages = opts.onMessages ?? placeholderHandler(config, log, client);

    const gateway = createGatewayApp({
      config,
      db,
      log,
      clock,
      onMessages: (messages) => handler(messages),
      sendText: (to, body) => client().sendText(to, body),
    });
    const root = new Hono();
    root.route("/", gateway.app);
    root.route(
      "/recorder",
      createRecorder({
        db,
        artifacts,
        cacheDir: join(varDir(), "tmp", "recorder"),
        ffmpegPath: config.ffmpegPath,
      }),
    );
    if (opts.routes) root.route("/", opts.routes);

    let emulator: Emulator | undefined;
    if (config.whatsapp.mode === "emulator") {
      emulator = createEmulator({
        webhookUrl: () => `${gatewayUrl}/webhook/whatsapp`,
        appSecret: required(config.whatsapp.appSecret, "WHATSAPP_APP_SECRET"),
        phoneNumberId: required(config.whatsapp.phoneNumberId, "WHATSAPP_PHONE_NUMBER_ID"),
        graphVersion: config.whatsapp.graphVersion,
        token: config.whatsapp.token,
        defaultFrom: config.reps.allowlist[0],
        clock,
      });
      root.route("/", emulator.app);
    }

    const { server, port } = await listen(root, config.ports.gateway);
    cleanup.push(async () => {
      await closeServer(server);
      // A handler may be waiting on a human (approval gates last minutes); do not let it hold shutdown.
      if (!(await settlesWithin(gateway.drain(), opts.drainTimeoutMs ?? DRAIN_ON_CLOSE_MS))) {
        log.warn("shutdown: message handlers still running; closing anyway");
      }
    });
    if (emulator) cleanup.push(() => emulator?.close()); // first on shutdown: ends open /dev/chat streams

    gatewayUrl = `http://127.0.0.1:${port}`;
    const graph = emulator ? `${gatewayUrl}/graph` : GRAPH_BASE_URL;
    whatsapp = createWhatsAppClient({
      baseUrl: graph,
      graphVersion: config.whatsapp.graphVersion,
      token: required(config.whatsapp.token, "WHATSAPP_TOKEN"),
      phoneNumberId: required(config.whatsapp.phoneNumberId, "WHATSAPP_PHONE_NUMBER_ID"),
      artifacts,
    });

    return {
      config,
      db,
      log,
      clock,
      artifacts,
      whatsapp,
      emulator,
      portals,
      urls: {
        gateway: gatewayUrl,
        webhook: `${gatewayUrl}/webhook/whatsapp`,
        graph,
        devChat: emulator ? `${gatewayUrl}/dev/chat` : undefined,
      },
      wire(onMessages) {
        handler = onMessages;
      },
      drain: () => gateway.drain(),
      close: closeAll,
    };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

/** Until the orchestrator is wired: log every message and, in emulator mode, echo its kind back. */
function placeholderHandler(config: Config, log: Logger, client: () => WhatsAppClient): OnMessages {
  return async (messages) => {
    for (const m of messages) {
      log.info("message received (placeholder handler: orchestrator not wired)", {
        waId: m.waId,
        kind: m.kind,
      });
      if (config.whatsapp.mode === "emulator")
        await client().sendText(m.from, `Received ${m.kind}`, { replyTo: m.waId });
    }
  };
}

function listen(app: Hono, port: number): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    // overrideGlobalObjects: false keeps the process-wide Request/Response untouched (portals share the process).
    const server = serve(
      { fetch: app.fetch, port, hostname: "127.0.0.1", overrideGlobalObjects: false },
      (info) => resolve({ server, port: info.port }),
    );
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(
        err.code === "EADDRINUSE"
          ? new Error(`port ${port} is already in use (another pnpm dev still running?)`)
          : err,
      ),
    );
  });
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    // Keep-alive and event-stream sockets would otherwise hold close() open.
    if ("closeAllConnections" in server) server.closeAllConnections();
  });
}

async function settlesWithin(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
  });
  try {
    return await Promise.race([work.then(() => true), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

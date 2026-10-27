import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
  text: string;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  raw: Buffer;
  /** Parsed body when the request was JSON. */
  json?: unknown;
  /** Parts in wire order when the request was multipart/form-data. */
  parts?: RecordedPart[];
}

export type ReplySpec = {
  status?: number;
  json?: unknown;
  body?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Drop the connection without answering (a network error for the client). */
  destroy?: boolean;
};
export type Reply = ReplySpec | ((req: RecordedRequest) => ReplySpec | Promise<ReplySpec>);

export interface MockServer {
  /** e.g. http://127.0.0.1:53211 */
  url: string;
  requests: RecordedRequest[];
  /** Queues replies for a path; each request consumes one. */
  on(path: string, ...replies: Reply[]): void;
  requestsTo(path: string): RecordedRequest[];
  close(): Promise<void>;
}

/** A local stand-in for api.meta.ai and inference.baseten.co on port 0. */
export async function startMockServer(): Promise<MockServer> {
  const queues = new Map<string, Reply[]>();
  const requests: RecordedRequest[] = [];

  const server = createServer(async (req, res) => {
    try {
      const recorded = await record(req);
      requests.push(recorded);
      const next = queues.get(recorded.path)?.shift();
      if (!next) {
        send(res, {
          status: 404,
          json: {
            error: { message: `mock: no reply queued for ${recorded.path}`, type: "invalid_request_error" },
          },
        });
        return;
      }
      const spec = typeof next === "function" ? await next(recorded) : next;
      if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
      if (spec.destroy) {
        req.socket.destroy();
        return;
      }
      send(res, spec);
    } catch (err) {
      send(res, { status: 500, json: { error: { message: `mock crashed: ${(err as Error).message}` } } });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    on(path, ...replies) {
      queues.set(path, [...(queues.get(path) ?? []), ...replies]);
    },
    requestsTo: (path) => requests.filter((r) => r.path === path),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function send(res: ServerResponse, spec: ReplySpec): void {
  if (res.destroyed) return;
  const body = spec.json !== undefined ? JSON.stringify(spec.json) : (spec.body ?? "");
  res.on("error", () => undefined);
  res.writeHead(spec.status ?? 200, {
    ...(spec.json !== undefined ? { "content-type": "application/json" } : {}),
    ...spec.headers,
  });
  res.end(body);
}

async function record(req: IncomingMessage): Promise<RecordedRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks);
  const url = new URL(req.url ?? "/", "http://mock");
  const contentType = req.headers["content-type"] ?? "";
  const recorded: RecordedRequest = {
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: req.headers,
    raw,
  };
  if (contentType.startsWith("application/json")) recorded.json = JSON.parse(raw.toString("utf8"));
  const boundary = /boundary=([^;]+)/.exec(contentType)?.[1];
  if (contentType.startsWith("multipart/form-data") && boundary)
    recorded.parts = parseMultipart(raw, boundary);
  return recorded;
}

function parseMultipart(raw: Buffer, boundary: string): RecordedPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: RecordedPart[] = [];
  let start = raw.indexOf(delimiter);
  while (start !== -1) {
    const after = start + delimiter.length;
    if (raw.subarray(after, after + 2).toString() === "--") break;
    const next = raw.indexOf(delimiter, after);
    if (next === -1) break;
    const section = raw.subarray(after + 2, next - 2); // skip CRLF after the delimiter and before the next one
    const split = section.indexOf("\r\n\r\n");
    const head = section.subarray(0, split).toString("utf8");
    const data = Buffer.from(section.subarray(split + 4));
    const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(disposition)?.[1];
    const contentType = /content-type:\s*([^\r\n]*)/i.exec(head)?.[1]?.trim();
    parts.push({
      name: /(?:^|;)\s*name="([^"]*)"/.exec(disposition)?.[1] ?? "",
      ...(filename !== undefined ? { filename } : {}),
      ...(contentType !== undefined ? { contentType } : {}),
      data,
      text: data.toString("utf8"),
    });
    start = next;
  }
  return parts;
}

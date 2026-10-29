// Requests that came from this machine, as opposed to through `pnpm tunnel` (cloudflared connects from
// 127.0.0.1, so the socket address says nothing) or a DNS-rebinding page.

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Added by cloudflared (Cloudflare's edge sets the cf-* ones, a client cannot drop them), ngrok and most proxies. */
const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "x-forwarded-for", "x-forwarded-host", "forwarded"];

/**
 * A request from a browser or process on this machine: a loopback Host (a tunnel forwards the public one, a
 * DNS-rebinding page sends its own) and no header a proxy or tunnel adds. Without a Host header (an in-process
 * app.request) the request URL's host counts.
 */
export function isLocalRequest(req: Request): boolean {
  let hostname: string;
  try {
    hostname = new URL(`http://${req.headers.get("host") ?? new URL(req.url).host}`).hostname;
  } catch {
    return false;
  }
  return LOCAL_HOSTNAMES.has(hostname) && !PROXY_HEADERS.some((h) => req.headers.has(h));
}

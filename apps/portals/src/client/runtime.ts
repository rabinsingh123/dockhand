// Client runtime: boot payload, mutator, class/testid helpers, tiny router, fetch wrapper.

import { useEffect, useSyncExternalStore } from "react";
import { createMutator, type Mutator } from "../shared/mutations.ts";
import { partnerTestidPrefix } from "../shared/partnerSchema.ts";
import type { BootPayload } from "../shared/types.ts";

// Set once by initRuntime() before the first render; components read them at render time.
export let boot: BootPayload;
export let M: Mutator;
let testidPrefix = "";

export function readInlineBoot(): BootPayload | null {
  const el = document.getElementById("__boot");
  if (!el?.textContent) return null;
  return JSON.parse(el.textContent) as BootPayload;
}

/** Fallback when the shell has no inline payload: GET /api/__config. */
export async function fetchBoot(): Promise<BootPayload> {
  const res = await fetch("/api/__config", { credentials: "same-origin" });
  const config = (await res.json()) as Omit<BootPayload, "path" | "user" | "data">;
  return { ...config, path: location.pathname, user: null, data: null };
}

export function initRuntime(payload: BootPayload): void {
  boot = payload;
  M = createMutator(payload.portal, payload.mutation);
  testidPrefix = payload.portal === "partner" ? partnerTestidPrefix(payload.version) : "sg-";
}

/** Maps base class names through class_churn. Accepts space-separated lists and falsy values. */
export function cx(...names: Array<string | false | null | undefined>): string {
  const out: string[] = [];
  for (const n of names) {
    if (!n) continue;
    for (const part of n.split(/\s+/)) if (part) out.push(M.cls(part));
  }
  return out.join(" ");
}

/** Base testid for a non-field element in the current portal/version scheme. */
export function tidBase(name: string): string {
  return `${testidPrefix}${name}`;
}

/** Final data-testid (after testid_churn) for a non-field element. */
export function tid(name: string): string | undefined {
  return M.testid(tidBase(name));
}

/** Rewrites `.class` selectors through class_churn so styling survives the mutation. */
export function mapCss(css: string): string {
  if (!M.has("class_churn")) return css;
  return css.replace(/\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g, (_m, name: string) => `.${M.cls(name)}`);
}

export function injectCss(css: string): void {
  const style = document.createElement("style");
  style.textContent = mapCss(css);
  document.head.appendChild(style);
}

export function useTitle(title: string): void {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

/** Server-provided page data, only valid for the URL the shell was served for. */
export function bootData<T>(key: string, pathname: string): T | undefined {
  if (boot.path !== pathname || !boot.data) return undefined;
  return boot.data[key] as T | undefined;
}

// ---------- router ----------

const listeners = new Set<() => void>();
let popstateBound = false;

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  if (!popstateBound) {
    window.addEventListener("popstate", emit);
    popstateBound = true;
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function snapshot(): string {
  return location.pathname + location.search;
}

export function navigate(to: string, opts: { replace?: boolean } = {}): void {
  if (opts.replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  emit();
}

export function useLocation(): { pathname: string; query: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot);
  const url = new URL(href, location.origin);
  return { pathname: url.pathname, query: url.searchParams };
}

export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = pathname.split("/").filter(Boolean);
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const a = p[i] as string;
    const b = s[i] as string;
    if (a.startsWith(":")) params[a.slice(1)] = decodeURIComponent(b);
    else if (a !== b) return null;
  }
  return params;
}

export function safeNext(next: string | null | undefined, fallback: string): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : fallback;
}

// ---------- fetch ----------

export interface ApiResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export async function api<T>(
  path: string,
  init: { method?: string; json?: unknown; body?: BodyInit } = {},
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { accept: "application/json" };
  let body = init.body;
  if (init.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, {
    method: init.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
  });
  let data: T | null = null;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data };
}

/** Enter in a text field must never submit a long form (keeps the agent's commit gate safe). */
export function preventImplicitSubmit(e: { key: string; target: EventTarget; preventDefault(): void }): void {
  if (e.key !== "Enter") return;
  if (e.target instanceof HTMLInputElement) e.preventDefault();
}

// HubSpot CRM over the v3 REST paths with a Service Key (bearer). docs/research/integration-facts.md §4.
// Every write commits a tool_calls row as 'started' BEFORE its POST and updates it after; a POST is never
// retried automatically. A row left 'started' or 'unknown' means the outcome is unknown: reconcile by
// searching for the deal by the job's short id, which every deal name carries.

import {
  type ArtifactStore,
  type Clock,
  type CrmClient,
  type Db,
  DockhandError,
  type Logger,
  systemClock,
} from "@dockhand/core";
import { createRepos, parseIdemKey } from "../repo.ts";

export interface HubSpotOptions {
  /** Service Key (pat-...). */
  token: string;
  db: Db;
  artifacts: ArtifactStore;
  clock?: Clock;
  log?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
  /** Hub (account) id, for record links. */
  hubId?: string;
  /** App origin for record links; accounts outside na1 live on e.g. https://app-na2.hubspot.com. */
  appUrl?: string;
  /** Read hubId and appUrl from GET /account-info/v3/details once, on the first link (when hubId is unset). */
  lookupAccount?: boolean;
  pipeline?: string;
  /** Internal stage id; ids vary by account (fetch them with GET /crm/v3/pipelines/deals). */
  dealStage?: string;
  /** Send deal_currency_code (only when the currency is enabled in the account). */
  currencyCode?: boolean;
  folderPath?: string;
  timeoutMs?: number;
}

/** HubSpot-defined association type ids (integration-facts §4.4). */
export const ASSOCIATION = { dealToPrimaryCompany: 5, noteToDeal: 214 } as const;

/** The last six characters of the job id: unique per job, short enough to read in a deal name. */
export function jobShortId(jobId: string): string {
  return jobId.slice(-6);
}

export function createHubSpotCrm(o: HubSpotOptions): CrmClient {
  const base = (o.baseUrl ?? "https://api.hubapi.com").replace(/\/+$/, "");
  const doFetch = o.fetch ?? globalThis.fetch;
  const clock = o.clock ?? systemClock;
  const repos = createRepos(o.db, clock);
  const timeoutMs = o.timeoutMs ?? 20_000;
  let account: Promise<{ hubId: string; appUrl: string }> | undefined;
  const accountInfo = () => {
    const fallback = { hubId: o.hubId ?? "_", appUrl: o.appUrl ?? "https://app.hubspot.com" };
    account ??=
      o.hubId || !o.lookupAccount
        ? Promise.resolve(fallback)
        : (
            send("/account-info/v3/details", { method: "GET" }) as Promise<{
              portalId?: number;
              uiDomain?: string;
            }>
          )
            .then((a) => ({
              hubId: a.portalId ? String(a.portalId) : fallback.hubId,
              appUrl: a.uiDomain ? `https://${a.uiDomain}` : fallback.appUrl,
            }))
            .catch(() => fallback); // a link is cosmetic; never fail a write over it
    return account;
  };
  const link = async (objectType: "0-2" | "0-3", id: string) => {
    const a = await accountInfo();
    return `${a.appUrl}/contacts/${a.hubId}/record/${objectType}/${id}`;
  };

  async function send(
    path: string,
    init: { method: string; json?: unknown; form?: FormData },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${o.token}`,
      accept: "application/json",
    };
    if (init.json !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, {
        method: init.method,
        headers,
        body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The request may have reached HubSpot: unknown, never retried.
      throw new DockhandError(
        "UNKNOWN_OUTCOME",
        `HubSpot ${init.method} ${path}: no response (${errText(err)})`,
      );
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = `HubSpot ${init.method} ${path} answered ${res.status}: ${text.slice(0, 300)}`;
      // 5xx may have applied the write; 4xx did not.
      throw new DockhandError(res.status >= 500 ? "UNKNOWN_OUTCOME" : "TOOL_ERROR", detail, {
        status: res.status,
      });
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new DockhandError("TOOL_ERROR", `HubSpot ${init.method} ${path}: response was not JSON`);
    }
  }

  /** One write: tool_calls row first (committed), then the POST, then the row's outcome. */
  async function write<T>(key: string, kind: string, args: unknown, post: () => Promise<T>): Promise<T> {
    const { jobId, idx } = parseIdemKey(key.replace(/:[a-z]+$/, ""));
    const begun = repos.toolCalls.begin({ jobId, idx, kind, idemKey: key, args });
    if (!begun.fresh) {
      if (begun.row.status === "succeeded") return begun.row.result as T;
      throw new DockhandError(
        "UNKNOWN_OUTCOME",
        `${kind} (${key}) was already attempted and its outcome is ${begun.row.status}; not retrying`,
      );
    }
    try {
      const result = await post();
      repos.toolCalls.succeed(begun.row.id, result);
      return result;
    } catch (err) {
      const unknown = err instanceof DockhandError && err.code === "UNKNOWN_OUTCOME";
      repos.toolCalls.fail(begun.row.id, errText(err), unknown ? "unknown" : "failed");
      o.log?.warn("HubSpot write failed", { kind, key, unknown, err });
      throw err;
    }
  }

  return {
    async upsertCompany(c, key) {
      // Search is read-only (POST only carries the query), so it is not a tool call.
      const found = (await send("/crm/v3/objects/companies/search", {
        method: "POST",
        json: {
          filterGroups: [{ filters: [{ propertyName: "name", operator: "EQ", value: c.name }] }],
          properties: ["name", "domain", "city", "country"],
          limit: 1,
        },
      })) as { results?: { id: string }[] };
      const hit = found.results?.[0];
      if (hit) return { id: hit.id, created: false, url: await link("0-2", hit.id) };
      const properties: Record<string, string> = { name: c.name };
      if (c.city) properties.city = c.city;
      if (c.country) properties.country = c.country;
      if (c.domain) properties.domain = c.domain;
      return write(key, "hubspot.company.create", { properties }, async () => {
        const res = (await send("/crm/v3/objects/companies", { method: "POST", json: { properties } })) as {
          id: string;
        };
        return { id: String(res.id), created: true, url: await link("0-2", String(res.id)) };
      });
    },

    async createDeal(d, key) {
      const { jobId } = parseIdemKey(key);
      const properties: Record<string, string> = {
        dealname: `${d.name} [${jobShortId(jobId)}]`,
        amount: (d.amountMinor / 100).toFixed(2),
        closedate: `${d.closeDate}T12:00:00.000Z`,
        pipeline: o.pipeline ?? "default",
        dealstage: o.dealStage ?? "appointmentscheduled",
        description: `Created by Dockhand for job ${jobId}.`,
      };
      if (o.currencyCode) properties.deal_currency_code = d.currency;
      const body = {
        properties,
        associations: [
          {
            to: { id: d.companyId },
            types: [
              { associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOCIATION.dealToPrimaryCompany },
            ],
          },
        ],
      };
      return write(key, "hubspot.deal.create", body, async () => {
        const res = (await send("/crm/v3/objects/deals", { method: "POST", json: body })) as { id: string };
        return { id: String(res.id), url: await link("0-3", String(res.id)) };
      });
    },

    async attachFileNote(n, key) {
      const bytes = await o.artifacts.read(n.file);
      const folderPath = o.folderPath ?? "/dockhand/quotes";
      const file = await write(
        `${key}:file`,
        "hubspot.file.upload",
        { filename: n.filename, folderPath },
        async () => {
          const form = new FormData();
          form.append("file", new Blob([new Uint8Array(bytes)], { type: n.file.mime }), n.filename);
          form.append("options", JSON.stringify({ access: "PRIVATE" }));
          form.append("folderPath", folderPath);
          const res = (await send("/files/v3/files", { method: "POST", form })) as { id: string };
          return { id: String(res.id) };
        },
      );
      const body = {
        properties: {
          hs_timestamp: new Date(clock.now()).toISOString(),
          hs_note_body: n.body,
          hs_attachment_ids: file.id,
        },
        associations: [
          {
            to: { id: n.dealId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: ASSOCIATION.noteToDeal }],
          },
        ],
      };
      return write(key, "hubspot.note.create", body, async () => {
        const res = (await send("/crm/v3/objects/notes", { method: "POST", json: body })) as { id: string };
        return { noteId: String(res.id) };
      });
    },
  };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

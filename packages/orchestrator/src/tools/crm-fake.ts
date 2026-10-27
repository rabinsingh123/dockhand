// In-memory CRM for CRM_MODE=fake and tests. Idempotent on the key "jobId:actionIdx": a repeated call
// with the same key returns the first result and writes nothing.

import type { ArtifactRef, CrmClient } from "@dockhand/core";

export interface FakeCrmState {
  companies: { id: string; name: string; city?: string; country?: string; domain?: string }[];
  deals: {
    id: string;
    name: string;
    amountMinor: number;
    currency: string;
    closeDate: string;
    companyId: string;
  }[];
  notes: { id: string; dealId: string; body: string; file: ArtifactRef; filename: string }[];
}

export interface FakeCrm extends CrmClient {
  state(): FakeCrmState;
  /** Number of calls that actually wrote something (not idempotent replays). */
  writes(): number;
}

export function createFakeCrm(opts: { baseUrl?: string } = {}): FakeCrm {
  const base = (opts.baseUrl ?? "https://crm.fake.test").replace(/\/+$/, "");
  const state: FakeCrmState = { companies: [], deals: [], notes: [] };
  const byKey = new Map<string, unknown>();
  let writes = 0;
  let seq = 1000;

  function once<T>(key: string, kind: string, run: () => T): T {
    const k = `${kind}|${key}`;
    if (byKey.has(k)) return structuredClone(byKey.get(k)) as T;
    const result = run();
    byKey.set(k, structuredClone(result));
    return result;
  }

  return {
    async upsertCompany(c, key) {
      return once(key, "company", () => {
        const existing = state.companies.find(
          (x) => x.name.trim().toLowerCase() === c.name.trim().toLowerCase(),
        );
        if (existing) return { id: existing.id, created: false, url: `${base}/companies/${existing.id}` };
        writes++;
        const id = String(++seq);
        state.companies.push({ id, ...c });
        return { id, created: true, url: `${base}/companies/${id}` };
      });
    },
    async createDeal(d, key) {
      return once(key, "deal", () => {
        if (!state.companies.some((c) => c.id === d.companyId))
          throw new Error(`fake CRM: no company ${d.companyId}`);
        writes++;
        const id = String(++seq);
        state.deals.push({ id, ...d });
        return { id, url: `${base}/deals/${id}` };
      });
    },
    async attachFileNote(n, key) {
      return once(key, "note", () => {
        if (!state.deals.some((d) => d.id === n.dealId)) throw new Error(`fake CRM: no deal ${n.dealId}`);
        writes++;
        const id = String(++seq);
        state.notes.push({ id, ...n });
        return { noteId: id };
      });
    },
    state: () => structuredClone(state),
    writes: () => writes,
  };
}

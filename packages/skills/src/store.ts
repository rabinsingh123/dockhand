// Versioned skill store over the `skills` and `skill_drafts` tables (architect review §4, T4).
// Exactly one active version per skill is also a database guarantee (partial unique index), so the
// deactivate/activate pair always runs inside one transaction.

import {
  type Clock,
  type Db,
  type Id,
  Skill,
  type SkillBody,
  SkillDraft,
  type SkillStore,
  systemClock,
  ulid,
} from "@dockhand/core";

type Source = "compile" | "heal" | "repair" | "ask_rep";

interface JsonRow {
  json: string;
}

export function createSkillStore(db: Db, clock: Clock = systemClock): SkillStore {
  const sql = {
    active: db.raw.prepare("SELECT json FROM skills WHERE name = ? AND active = 1"),
    get: db.raw.prepare("SELECT json FROM skills WHERE name = ? AND version = ?"),
    exists: db.raw.prepare("SELECT 1 AS one FROM skills WHERE name = ? AND version = ?"),
    maxVersion: db.raw.prepare("SELECT MAX(version) AS v FROM skills WHERE name = ?"),
    insert: db.raw.prepare(
      `INSERT INTO skills (name, version, parent_version, json, active, changelog, source, source_run_id, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    ),
    deactivate: db.raw.prepare("UPDATE skills SET active = 0 WHERE name = ? AND active = 1"),
    activate: db.raw.prepare("UPDATE skills SET active = 1 WHERE name = ? AND version = ?"),
    list: db.raw.prepare(
      `SELECT name, version, active, json_extract(json, '$.title') AS title FROM skills ORDER BY name, version`,
    ),
    insertDraft: db.raw.prepare(
      `INSERT INTO skill_drafts (id, name, json, job_id, status, created_at) VALUES (?, ?, ?, ?, 'draft', ?)`,
    ),
    getDraft: db.raw.prepare("SELECT json FROM skill_drafts WHERE id = ?"),
    openDraftForPortal: db.raw.prepare(
      `SELECT id, json FROM skill_drafts
       WHERE status = 'draft' AND json_extract(json, '$.portalId') = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    ),
    markCompiled: db.raw.prepare(
      "UPDATE skill_drafts SET status = 'compiled' WHERE id = ? AND status = 'draft'",
    ),
  };

  const parseSkill = (row: unknown): Skill | undefined =>
    row ? Skill.parse(JSON.parse((row as JsonRow).json)) : undefined;

  return {
    active(name) {
      return parseSkill(sql.active.get(name));
    },

    get(name, version) {
      return parseSkill(sql.get.get(name, version));
    },

    list() {
      const rows = sql.list.all() as {
        name: string;
        version: number;
        active: number;
        title: string | null;
      }[];
      const out = new Map<string, { name: string; title: string; activeVersion: number; versions: number }>();
      for (const r of rows) {
        const e = out.get(r.name) ?? {
          name: r.name,
          title: r.title ?? r.name,
          activeVersion: 0,
          versions: 0,
        };
        e.versions++;
        if (r.active === 1) {
          e.activeVersion = r.version;
          e.title = r.title ?? r.name;
        } else if (e.activeVersion === 0) {
          e.title = r.title ?? r.name; // no active version yet: show the latest title
        }
        out.set(r.name, e);
      }
      return [...out.values()];
    },

    saveVersion(
      body: SkillBody,
      parentVersion: number | null,
      activate: boolean,
      source: Source,
      sourceRunId?: Id,
    ) {
      return db.tx(() => {
        if (parentVersion !== null && !sql.exists.get(body.name, parentVersion)) {
          throw new Error(`skill ${body.name} has no version ${parentVersion} to be the parent`);
        }
        const max = (sql.maxVersion.get(body.name) as { v: number | null } | undefined)?.v ?? 0;
        const skill = Skill.parse({ ...body, version: max + 1, parentVersion });
        sql.insert.run(
          skill.name,
          skill.version,
          parentVersion,
          JSON.stringify(skill),
          skill.changelog,
          source,
          sourceRunId ?? null,
          clock.now(),
        );
        if (activate) {
          sql.deactivate.run(skill.name);
          sql.activate.run(skill.name, skill.version);
        }
        if (source === "compile" && skill.createdFrom.draftId)
          sql.markCompiled.run(skill.createdFrom.draftId);
        return skill;
      });
    },

    activate(name, version) {
      db.tx(() => {
        if (!sql.exists.get(name, version)) throw new Error(`skill ${name} has no version ${version}`);
        sql.deactivate.run(name);
        sql.activate.run(name, version);
      });
    },

    saveDraft(d, jobId) {
      const draft = SkillDraft.parse(d);
      const id = ulid(clock);
      sql.insertDraft.run(id, draft.name, JSON.stringify(draft), jobId, clock.now());
      return id;
    },

    getDraft(id) {
      const row = sql.getDraft.get(id) as JsonRow | undefined;
      return row ? SkillDraft.parse(JSON.parse(row.json)) : undefined;
    },

    draftForPortal(portalId) {
      const row = sql.openDraftForPortal.get(portalId) as { id: string; json: string } | undefined;
      return row ? { id: row.id, draft: SkillDraft.parse(JSON.parse(row.json)) } : undefined;
    },
  };
}

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Db, openDb } from "./db.ts";

const TABLES = [
  "artifacts",
  "gates",
  "job_events",
  "jobs",
  "messages",
  "model_calls",
  "reps",
  "run_steps",
  "runs",
  "skill_drafts",
  "skills",
  "tool_calls",
];

const open: Db[] = [];
const dirs: string[] = [];
function tempDb(name = "test.sqlite"): { db: Db; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "dockhand-db-"));
  dirs.push(dir);
  const path = join(dir, "nested", name);
  const db = openDb(path);
  open.push(db);
  return { db, path };
}
function memoryDb(): Db {
  const db = openDb(":memory:");
  open.push(db);
  return db;
}

afterEach(() => {
  for (const db of open.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const pragma = (db: Db, name: string) => Object.values(db.raw.prepare(`PRAGMA ${name}`).get() ?? {})[0];

function insertJob(db: Db, id: string) {
  db.raw
    .prepare(
      "INSERT INTO jobs (id, rep, status, created_at, updated_at) VALUES (?, '5511999990000', 'received', 1, 1)",
    )
    .run(id);
}

function insertSkill(db: Db, name: string, version: number, active: 0 | 1) {
  db.raw
    .prepare(
      "INSERT INTO skills (name, version, parent_version, json, active, source, created_at) VALUES (?, ?, NULL, '{}', ?, 'compile', 1)",
    )
    .run(name, version, active);
}

describe("openDb", () => {
  it("applies schema.sql to an in-memory database", () => {
    const db = memoryDb();
    expect(pragma(db, "user_version")).toBe(1);
    const tables = db.raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((r) => r.name);
    expect(tables).toEqual(TABLES);
    expect(pragma(db, "foreign_keys")).toBe(1);
    expect(pragma(db, "busy_timeout")).toBe(5000);
  });

  it("uses WAL and NORMAL sync on a file and creates parent directories", () => {
    const { db } = tempDb();
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "synchronous")).toBe(1);
    expect(pragma(db, "foreign_keys")).toBe(1);
  });

  it("does not re-run migrations on reopen and keeps data", () => {
    const { db, path } = tempDb();
    insertJob(db, "J1");
    db.close();
    const again = openDb(path);
    open.push(again);
    expect(pragma(again, "user_version")).toBe(1);
    expect(again.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 1 });
  });

  it("refuses a database from a newer schema", () => {
    const { db, path } = tempDb();
    db.raw.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => openDb(path)).toThrow(/schema version 99 is newer/);
  });
});

describe("tx", () => {
  it("commits and returns the callback's value", () => {
    const db = memoryDb();
    const result = db.tx(() => {
      insertJob(db, "J1");
      return "done";
    });
    expect(result).toBe("done");
    expect(db.raw.prepare("SELECT id FROM jobs").all()).toEqual([{ id: "J1" }]);
  });

  it("rolls back everything when the callback throws", () => {
    const db = memoryDb();
    expect(() =>
      db.tx(() => {
        insertJob(db, "J1");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
    db.tx(() => insertJob(db, "J2")); // the connection is usable afterwards
    expect(db.raw.prepare("SELECT id FROM jobs").all()).toEqual([{ id: "J2" }]);
  });

  it("rolls back on a constraint error raised by SQLite", () => {
    const db = memoryDb();
    insertJob(db, "J1");
    expect(() =>
      db.tx(() => {
        insertJob(db, "J2");
        insertJob(db, "J1");
      }),
    ).toThrow(/UNIQUE constraint failed/);
    expect(db.raw.prepare("SELECT id FROM jobs ORDER BY id").all()).toEqual([{ id: "J1" }]);
  });

  it("nests with savepoints: an inner failure caught by the outer callback undoes only the inner part", () => {
    const db = memoryDb();
    db.tx(() => {
      insertJob(db, "OUTER");
      try {
        db.tx(() => {
          insertJob(db, "INNER");
          throw new Error("inner");
        });
      } catch {
        // handled
      }
      db.tx(() => insertJob(db, "INNER2"));
    });
    expect(
      db.raw
        .prepare("SELECT id FROM jobs ORDER BY id")
        .all()
        .map((r) => r.id),
    ).toEqual(["INNER2", "OUTER"]);
  });

  it("rejects async callbacks and rolls back their synchronous part", () => {
    const db = memoryDb();
    expect(() =>
      db.tx(async () => {
        insertJob(db, "J1");
      }),
    ).toThrow(/must be synchronous/);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });
});

describe("schema guarantees", () => {
  it("allows only one active version per skill (partial unique index)", () => {
    const db = memoryDb();
    insertSkill(db, "register_partner_deal", 1, 1);
    insertSkill(db, "register_partner_deal", 2, 0);
    insertSkill(db, "supplier_onboarding", 1, 1);
    expect(() => insertSkill(db, "register_partner_deal", 3, 1)).toThrow(/UNIQUE constraint failed/);

    // Rollback/activation is the deactivate + activate pair in one transaction.
    db.tx(() => {
      db.raw
        .prepare("UPDATE skills SET active = 0 WHERE name = ? AND active = 1")
        .run("register_partner_deal");
      db.raw
        .prepare("UPDATE skills SET active = 1 WHERE name = ? AND version = ?")
        .run("register_partner_deal", 2);
    });
    expect(
      db.raw.prepare("SELECT version FROM skills WHERE name = ? AND active = 1").all("register_partner_deal"),
    ).toEqual([{ version: 2 }]);
    expect(() =>
      db.raw
        .prepare("UPDATE skills SET active = 1 WHERE name = ? AND version = 1")
        .run("register_partner_deal"),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("dedupes inbound messages by wa_id with ON CONFLICT DO NOTHING", () => {
    const db = memoryDb();
    const insert = db.raw.prepare(
      `INSERT INTO messages (wa_id, direction, rep, kind, text, raw_json, created_at)
       VALUES (?, 'in', '5511999990000', 'text', 'oi', '{}', 1) ON CONFLICT(wa_id) DO NOTHING`,
    );
    expect(insert.run("wamid.A").changes).toBe(1);
    expect(insert.run("wamid.A").changes).toBe(0);
    expect(insert.run("wamid.B").changes).toBe(1);
  });

  it("enforces foreign keys from job rows", () => {
    const db = memoryDb();
    expect(() =>
      db.raw
        .prepare("INSERT INTO job_events (job_id, event_json, accepted, at) VALUES ('missing', '{}', 1, 1)")
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });

  it("checks job status values against the contract", () => {
    const db = memoryDb();
    expect(() =>
      db.raw
        .prepare("INSERT INTO jobs (id, rep, status, created_at, updated_at) VALUES ('J', '1', 'done', 1, 1)")
        .run(),
    ).toThrow(/CHECK constraint failed/);
  });

  it("keeps tool call idempotency keys unique", () => {
    const db = memoryDb();
    insertJob(db, "J1");
    const insert = db.raw.prepare(
      "INSERT INTO tool_calls (id, job_id, idx, kind, idem_key, args_json, status, started_at) VALUES (?, 'J1', 0, 'crm', 'J1:0', '{}', 'started', 1)",
    );
    insert.run("T1");
    expect(() => insert.run("T2")).toThrow(/UNIQUE constraint failed/);
  });
});

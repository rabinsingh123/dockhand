-- Dockhand SQLite schema. openDb() applies each "-- migration: N" block whose N is above
-- PRAGMA user_version, in order, one transaction per block. Never edit an applied block: append a new one.
-- Timestamps are UTC epoch ms (INTEGER). Ids are ULIDs (TEXT). *_json columns hold zod-validated JSON.
-- Artifact id columns carry no foreign key on purpose: tests use an in-memory artifact store with a real db.

-- migration: 1

CREATE TABLE reps (
  phone TEXT PRIMARY KEY,                       -- E.164 digits, no '+'
  name TEXT NOT NULL DEFAULT '',
  tz TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  locale TEXT NOT NULL DEFAULT 'pt-BR',
  language_bias TEXT NOT NULL DEFAULT '[]',     -- JSON array of language names
  allowed INTEGER NOT NULL DEFAULT 0 CHECK (allowed IN (0, 1)),
  refused_at INTEGER                            -- last polite refusal sent to a non-allow-listed sender
);

CREATE TABLE messages (
  wa_id TEXT PRIMARY KEY,                       -- inbound dedupe key (INSERT ... ON CONFLICT(wa_id) DO NOTHING)
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  rep TEXT NOT NULL,
  job_id TEXT REFERENCES jobs (id),
  kind TEXT NOT NULL,
  text TEXT,
  media_artifact_id TEXT,
  button_id TEXT,
  reply_to TEXT,
  raw_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX messages_rep_created ON messages (rep, created_at);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  rep TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'received', 'understanding', 'awaiting_input', 'awaiting_approval', 'executing',
    'succeeded', 'failed', 'cancelled', 'expired'
  )),
  intent TEXT,
  understanding_json TEXT,
  plan_json TEXT,
  language TEXT,
  error_code TEXT,
  error_message TEXT,
  rev INTEGER NOT NULL DEFAULT 0,               -- compare-and-set on every transition
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX jobs_rep_status ON jobs (rep, status);

CREATE TABLE job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT,
  event_json TEXT NOT NULL,
  accepted INTEGER NOT NULL CHECK (accepted IN (0, 1)),
  at INTEGER NOT NULL
);
CREATE INDEX job_events_job ON job_events (job_id);

CREATE TABLE gates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('plan', 'commit', 'safety', 'skill_confirm', 'skill_patch', 'question')),
  status TEXT NOT NULL DEFAULT 'pending',       -- pending | approved | rejected | edit | expired (question gates may store optN)
  body TEXT NOT NULL,
  image_artifact_id TEXT,
  wa_id TEXT,                                   -- the interactive message carrying the buttons
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by_wa_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX gates_status_expires ON gates (status, expires_at);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  kind TEXT NOT NULL,
  idem_key TEXT NOT NULL UNIQUE,                -- "jobId:actionIdx"; committed as 'started' before the HTTP call
  args_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'unknown')),
  result_json TEXT,
  error TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE skill_drafts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  json TEXT NOT NULL,                           -- SkillDraft
  job_id TEXT,
  video_artifact_id TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'compiled', 'abandoned')),
  created_at INTEGER NOT NULL
);

CREATE TABLE skills (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  json TEXT NOT NULL,                           -- Skill
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  changelog TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('compile', 'heal', 'repair', 'ask_rep')),
  source_run_id TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (name, version)
);
-- Exactly one active version per skill is a database guarantee (rollback cannot leave two active).
CREATE UNIQUE INDEX skills_one_active ON skills (name) WHERE active = 1;

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  eval_suite TEXT,
  eval_case_id TEXT,
  mode TEXT NOT NULL,                           -- agentic | replay | repair
  skill_name TEXT,
  skill_version INTEGER,
  portal_id TEXT,
  portal_session_json TEXT,
  params_json TEXT,
  outcome TEXT,
  error_code TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  ms INTEGER,
  exec_cost_usd REAL,
  model_calls INTEGER,
  trace_artifact_id TEXT,
  final_screenshot_id TEXT,
  extracted_json TEXT
);
CREATE INDEX runs_skill ON runs (skill_name, skill_version, mode);
CREATE INDEX runs_eval_suite ON runs (eval_suite);

CREATE TABLE run_steps (
  run_id TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  step_id TEXT NOT NULL,
  op TEXT NOT NULL,
  status TEXT NOT NULL,                         -- StepStatus
  rung TEXT,                                    -- HealRung when the step healed
  candidate_idx INTEGER,
  ms INTEGER NOT NULL,
  error_code TEXT,
  error TEXT,
  target_json TEXT,
  screenshot_id TEXT,
  PRIMARY KEY (run_id, idx)
);

CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,                       -- meta | baseten | fake | cassette | scripted
  model TEXT NOT NULL,
  job_id TEXT,
  run_id TEXT,
  step_idx INTEGER,
  response_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER,
  images INTEGER NOT NULL DEFAULT 0,
  audio_ms INTEGER,
  latency_ms INTEGER NOT NULL,
  cost_usd REAL NOT NULL,                       -- Standard list price
  status TEXT NOT NULL,                         -- ok | error | timeout | incomplete
  error_code TEXT
);
CREATE INDEX model_calls_job ON model_calls (job_id);
CREATE INDEX model_calls_run ON model_calls (run_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  mime TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  rel_path TEXT NOT NULL,                       -- POSIX, relative to the var dir: artifacts/ab/<sha256>.<ext>
  kind TEXT NOT NULL,
  job_id TEXT,
  run_id TEXT,
  filename TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX artifacts_sha256 ON artifacts (sha256);

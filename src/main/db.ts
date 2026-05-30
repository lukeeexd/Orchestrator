import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import initSqlJs, { type Database } from 'sql.js';

type Migration = { version: number; up: (db: Database) => void };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.exec(`
        CREATE TABLE schema_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO schema_meta (key, value) VALUES ('initialized_at', datetime('now'));
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.exec(`
        CREATE TABLE director_messages (
          id TEXT PRIMARY KEY,
          ordering INTEGER NOT NULL,
          who TEXT NOT NULL,
          name TEXT NOT NULL,
          time TEXT NOT NULL,
          body TEXT NOT NULL,
          plan TEXT,
          plan_accepted INTEGER NOT NULL DEFAULT 0,
          live INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE agents (
          id TEXT PRIMARY KEY,
          ordering INTEGER NOT NULL,
          role TEXT NOT NULL,
          role_label TEXT NOT NULL,
          name TEXT NOT NULL,
          status TEXT NOT NULL,
          status_label TEXT NOT NULL,
          step TEXT NOT NULL,
          task TEXT NOT NULL,
          tokens INTEGER NOT NULL DEFAULT 0,
          cost REAL NOT NULL DEFAULT 0,
          elapsed TEXT NOT NULL,
          model TEXT NOT NULL,
          workspace TEXT NOT NULL,
          budget_usd REAL NOT NULL DEFAULT 0,
          budget_tokens INTEGER NOT NULL DEFAULT 0,
          budget_seconds INTEGER NOT NULL DEFAULT 0,
          spawned_by TEXT NOT NULL,
          started_at INTEGER NOT NULL
        );

        CREATE TABLE log_lines (
          agent_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts TEXT NOT NULL,
          kind TEXT NOT NULL,
          msg TEXT NOT NULL,
          PRIMARY KEY (agent_id, seq)
        );

        CREATE TABLE kv (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.exec(`
        ALTER TABLE director_messages ADD COLUMN attachments TEXT;
      `);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.exec(`
        ALTER TABLE agents ADD COLUMN session_id TEXT;
      `);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.exec(`
        ALTER TABLE director_messages ADD COLUMN redirect TEXT;
        ALTER TABLE director_messages ADD COLUMN redirect_fired INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          workspace TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );

        ALTER TABLE agents ADD COLUMN project_id TEXT;
        ALTER TABLE director_messages ADD COLUMN project_id TEXT;
      `);

      // Migrate existing data into a "Default" project so nothing is lost.
      const hasAnyData = (db.exec(
        `SELECT 1 FROM agents UNION SELECT 1 FROM director_messages LIMIT 1`,
      )[0]?.values.length ?? 0) > 0;
      if (hasAnyData) {
        // Reuse a fixed UUID so the migration is idempotent enough for re-runs.
        const defaultId = '00000000-0000-4000-a000-000000000001';
        db.exec(`
          INSERT INTO projects (id, name, workspace, created_at)
          VALUES ('${defaultId}', 'Default', '', strftime('%s','now') * 1000);
          UPDATE agents SET project_id = '${defaultId}' WHERE project_id IS NULL;
          UPDATE director_messages SET project_id = '${defaultId}' WHERE project_id IS NULL;
          INSERT OR REPLACE INTO kv (key, value)
            VALUES ('active_project_id', '${defaultId}');
          INSERT OR REPLACE INTO kv (key, value)
            SELECT 'project:' || '${defaultId}' || ':director_session_id', value
            FROM kv WHERE key = 'director_session_id';
        `);
      }
    },
  },
  {
    version: 7,
    up: (db) => {
      // Per-project Director model override. NULL means "fall through
      // to settings.defaultModel".
      db.exec(`ALTER TABLE projects ADD COLUMN director_model TEXT;`);
    },
  },
  {
    version: 8,
    up: (db) => {
      // Reasoning effort: per-project Director override + per-agent
      // current effort. NULL on agents.effort means "fall through to
      // settings.defaultEffort" at runtime; we never backfill a fixed
      // value so the global default can keep moving.
      db.exec(`
        ALTER TABLE projects ADD COLUMN director_effort TEXT;
        ALTER TABLE agents ADD COLUMN effort TEXT;
      `);
    },
  },
  {
    version: 9,
    up: (db) => {
      // Fork attribution: which agent (if any) this one was forked from.
      // NULL for normal spawns. Name is denormalised so the Drawer can
      // render "forked from coder-01" without joining back to the agents
      // table (and so the attribution survives the parent being deleted).
      db.exec(`
        ALTER TABLE agents ADD COLUMN forked_from_id TEXT;
        ALTER TABLE agents ADD COLUMN forked_from_name TEXT;
      `);
    },
  },
  {
    version: 10,
    up: (db) => {
      // Per-project role-tool allow-list overrides. JSON-encoded map of
      // `{ role: ["Tool1", "Tool2", ...] }`. Roles not present in the map
      // fall back to the role's default tool set from shared/roles.ts at
      // spawn time. NULL means "no overrides, use defaults for every role".
      db.exec(`ALTER TABLE projects ADD COLUMN role_tools TEXT;`);
    },
  },
  {
    version: 11,
    up: (db) => {
      // Cumulative per-model spend captured from each CLI result event's
      // modelUsage field. JSON-encoded map of
      // `{ <model-id>: { tokens, cost } }`. NULL for agents that ran
      // before v0.5; the runtime falls back to attributing to agent.model
      // for those.
      db.exec(`ALTER TABLE agents ADD COLUMN model_usage TEXT;`);
    },
  },
  {
    version: 12,
    up: (db) => {
      // Which CLI backend a project runs against. NULL → 'claude' at
      // runtime so existing projects stay on the original runtime
      // without manual migration.
      db.exec(`ALTER TABLE projects ADD COLUMN provider TEXT;`);
    },
  },
  {
    version: 13,
    up: (db) => {
      // Per-agent provider override. NULL → fall through to the
      // project's provider at runtime, matching the original
      // project-only behaviour for agents that ran before this column
      // existed.
      db.exec(`ALTER TABLE agents ADD COLUMN provider TEXT;`);
    },
  },
  {
    version: 14,
    up: (db) => {
      // Project-level Director provider override. NULL → Director uses
      // the project's main `provider` column, matching the original
      // single-provider-per-project behaviour. Letting the Director run
      // on a different CLI than the agents (e.g. claude Director
      // orchestrating codex coders) is the whole point of this column.
      db.exec(`ALTER TABLE projects ADD COLUMN director_provider TEXT;`);
    },
  },
  {
    version: 15,
    up: (db) => {
      // Project-level MCP server config — JSON string in the shape
      // claude --mcp-config expects (typically {"mcpServers": {...}}).
      // NULL → no MCP servers; the spawn skips --mcp-config entirely.
      // Codex spawns ignore this column (codex doesn't support
      // --mcp-config). The string is also mirrored to a file in
      // app userData so the CLI can read a real path — passing huge
      // JSON via argv would risk Windows' command-line length cap.
      db.exec(`ALTER TABLE projects ADD COLUMN mcp_config TEXT;`);
    },
  },
  {
    version: 16,
    up: (db) => {
      // Skill marketplace: a set of GitHub repos that publish
      // Claude-Code-compatible plugin bundles, plus per-project
      // subscriptions to specific bundles. The local cache lives in
      // userData/skill-marketplaces/<sourceId>/ — see
      // src/main/marketplace.ts — and on each claude spawn we append
      // --plugin-dir <cache>/<bundle.source> for every subscribed
      // bundle for the project.
      //
      // skill_sources: one row per GitHub-hosted marketplace.
      //   last_sync_sha tracks the last cloned/pulled commit.
      // project_subscribed_bundles: many-to-many between projects and
      //   marketplace bundles. installed_version is the version the
      //   user last acknowledged — when a sync pulls in a newer
      //   marketplace.json version, the diff drives the "update
      //   available" toast + badge.
      db.exec(`
        CREATE TABLE skill_sources (
          id TEXT PRIMARY KEY,
          repo TEXT NOT NULL,
          default_branch TEXT NOT NULL DEFAULT 'main',
          enabled INTEGER NOT NULL DEFAULT 1,
          added_at INTEGER NOT NULL,
          last_sync_at INTEGER,
          last_sync_sha TEXT
        );

        CREATE TABLE project_subscribed_bundles (
          project_id TEXT NOT NULL,
          source_id TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          subscribed_at INTEGER NOT NULL,
          installed_version TEXT,
          PRIMARY KEY (project_id, source_id, bundle_id)
        );

        CREATE INDEX idx_subscribed_bundles_project
          ON project_subscribed_bundles (project_id);
      `);
    },
  },
  {
    version: 17,
    up: (db) => {
      // Per-role bundle enablement. roles is a JSON-encoded array of
      // role keys (AgentRole values plus 'director'). NULL means "all
      // roles" — preserves the v16 behaviour for subscriptions that
      // existed before this column was added.
      db.exec(
        `ALTER TABLE project_subscribed_bundles ADD COLUMN roles TEXT;`,
      );
    },
  },
  {
    version: 18,
    up: (db) => {
      // Skill-level granularity within a bundle. selected_skills is a
      // JSON-encoded array of skill ids (the subdir names inside the
      // bundle that contain SKILL.md). NULL means "all skills" —
      // preserves the v17 behaviour where subscribing loaded the
      // entire bundle. When set, the runner builds a synthetic plugin
      // dir containing only the listed skill subfolders and passes
      // THAT to --plugin-dir.
      db.exec(
        `ALTER TABLE project_subscribed_bundles ADD COLUMN selected_skills TEXT;`,
      );
    },
  },
  {
    version: 19,
    up: (db) => {
      // Skill usage telemetry. Each row is a (project, role, source,
      // bundle, skill) tuple with a fire count + last-fired timestamp.
      // Bumped by the agent runner when a spawned agent's tool_use
      // events touch a known skill's directory. Surfaced in the
      // Agent skills view as "fired Nx" chips so the user can spot
      // skills they've enabled but never use, and prune them.
      db.exec(`
        CREATE TABLE skill_fire_counts (
          project_id TEXT NOT NULL,
          role TEXT NOT NULL,
          source_id TEXT NOT NULL,
          bundle_id TEXT NOT NULL,
          skill_id TEXT NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          last_fired_at INTEGER NOT NULL,
          PRIMARY KEY (project_id, role, source_id, bundle_id, skill_id)
        );
      `);
    },
  },
  {
    version: 20,
    up: (db) => {
      // Workflow templates: named, reusable Director plans. The user
      // picks one in the Templates rail item and the rows land as a
      // synthetic director message — the existing PlanCard then drives
      // edit + spawn the same way a Director-emitted plan does.
      //
      // `mode` records the Director mode the template was authored
      // against ('auto' or 'manual'); the renderer can use it as a
      // hint when injecting the synthesised plan message.
      // `tags` is a JSON array of short strings ("refactor", "tdd",
      // "security") — searchable in the list view.
      // `rows_json` is the JSON-encoded PlanRow[].
      // `builtin = 1` marks the seeded templates; the UI hides the
      // delete affordance for those so the user can't accidentally
      // remove a default.
      db.exec(`
        CREATE TABLE templates (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          mode        TEXT NOT NULL DEFAULT 'auto',
          tags        TEXT NOT NULL DEFAULT '[]',
          rows_json   TEXT NOT NULL,
          builtin     INTEGER NOT NULL DEFAULT 0,
          created_at  INTEGER NOT NULL,
          updated_at  INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 21,
    up: (db) => {
      // P10: optional role flavour. Currently only qa.playwright is
      // surfaced; the column stays generic so other roles can grow
      // flavours later without another migration. Null = default
      // flavour (= same behaviour as pre-v21 agents).
      db.exec(`
        ALTER TABLE agents ADD COLUMN subtype TEXT;
      `);
    },
  },
  {
    version: 22,
    up: (db) => {
      // P15: PRD mode. When the Director runs in `[mode: prd]`, the
      // emitted orchestrator-prd JSON block is parsed into a
      // ProjectPrd and stored here per-message. NULL on existing
      // rows preserves the v21 behaviour (no PRD card rendered for
      // old messages).
      db.exec(`
        ALTER TABLE director_messages ADD COLUMN prd TEXT;
      `);
    },
  },
  {
    version: 23,
    up: (db) => {
      // Agent-proposed memory pins (Option A from the memory design):
      // an agent emits an `orchestrator-memory` fenced block; we land
      // a pending proposal here; the user approves/rejects from the
      // Drawer's Memory tab; approve appends to the per-role skill
      // file (P4 storage), so future spawns of that role see it
      // through the existing effectiveSkill path.
      //
      // status: 'pending' | 'approved' | 'rejected'
      // source_agent_id: which agent emitted this (denormalised so
      //   the row survives the agent being removed).
      db.exec(`
        CREATE TABLE memory_proposals (
          id              TEXT PRIMARY KEY,
          project_id      TEXT NOT NULL,
          role            TEXT NOT NULL,
          body            TEXT NOT NULL,
          source_agent_id TEXT,
          source_agent_name TEXT,
          created_at      INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending'
        );

        CREATE INDEX idx_memory_proposals_project_role
          ON memory_proposals (project_id, role, status);
      `);
    },
  },
  {
    version: 24,
    up: (db) => {
      // F6: per-project secrets vault. The runner injects these into
      // each spawn's child-process env (NOT the prompt), so values
      // never land in agent logs / crash JSON / Director chat
      // history. Storage is plaintext under userData, matching the
      // existing API-key / OAuth-token precedent in settings.json —
      // NTFS ACLs already gate other users on the same machine.
      // DPAPI encryption is a deferred follow-up (would matter most
      // if Orchestrator ever shipped to multi-user shared hosts).
      //
      // Names are env-var shaped (^[A-Z][A-Z0-9_]*$) so they slot
      // straight into the child env without escaping.
      db.exec(`
        CREATE TABLE project_secrets (
          project_id  TEXT NOT NULL,
          name        TEXT NOT NULL,
          value       TEXT NOT NULL,
          updated_at  INTEGER NOT NULL,
          PRIMARY KEY (project_id, name)
        );
      `);
    },
  },
  {
    version: 25,
    up: (db) => {
      // F8: timeline / Gantt view needs an absolute end-of-run
      // timestamp so the renderer can lay out per-agent bars over
      // wall-clock time. We already had `started_at` (absolute) and
      // `elapsed` (formatted string like "1m 23s") — the latter is
      // a display field and not reliably parseable. `ended_at` stays
      // null for in-progress agents; flips on every terminal status
      // transition (done / error / aborted).
      db.exec(`ALTER TABLE agents ADD COLUMN ended_at INTEGER;`);

      // Backfill rows where status is already terminal. The fallback
      // is `started_at` (zero-duration bar) for rows we can't parse;
      // for "Nm Ks" / "Ks" / "Nh Mm" shapes, compute the duration in
      // ms and stamp started_at + duration.
      //
      // SQLite has no regex; we use INSTR + SUBSTR. Three patterns:
      //   - "Nh Mm"     -> hours*3600 + minutes*60
      //   - "Mm Ss"     -> minutes*60 + seconds
      //   - "Ss"        -> seconds
      // Anything that doesn't match collapses to started_at.
      db.exec(`
        UPDATE agents
           SET ended_at = started_at + (
             CASE
               WHEN elapsed LIKE '%h %m' THEN
                 CAST(SUBSTR(elapsed, 1, INSTR(elapsed, 'h') - 1) AS INTEGER) * 3600000 +
                 CAST(SUBSTR(elapsed, INSTR(elapsed, 'h') + 2,
                             INSTR(elapsed, 'm') - INSTR(elapsed, 'h') - 2) AS INTEGER) * 60000
               WHEN elapsed LIKE '%m %s' THEN
                 CAST(SUBSTR(elapsed, 1, INSTR(elapsed, 'm') - 1) AS INTEGER) * 60000 +
                 CAST(SUBSTR(elapsed, INSTR(elapsed, 'm') + 2,
                             INSTR(elapsed, 's') - INSTR(elapsed, 'm') - 2) AS INTEGER) * 1000
               WHEN elapsed LIKE '%s' THEN
                 CAST(SUBSTR(elapsed, 1, INSTR(elapsed, 's') - 1) AS INTEGER) * 1000
               ELSE 0
             END
           )
         WHERE ended_at IS NULL
           AND status IN ('done', 'error', 'paused');
      `);
    },
  },
  {
    version: 26,
    up: (db) => {
      // F12: per-line notes pinned to an agent's log. Key is a stable
      // hash of (ts + kind + msg) — see src/shared/logNotes.ts for the
      // hash function. The composite PK on (agent_id, line_key) means
      // one note per line per agent; updates re-use the row via
      // ON CONFLICT.
      //
      // Hashing (rather than using log_lines.seq) survives any future
      // reorder / replay; the same log content always maps to the same
      // key. Editing a log line (which doesn't currently happen)
      // would orphan its note — acceptable, simpler than tracking
      // per-line identity through edits.
      db.exec(`
        CREATE TABLE log_notes (
          agent_id   TEXT NOT NULL,
          line_key   TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (agent_id, line_key)
        );

        CREATE INDEX idx_log_notes_agent
          ON log_notes (agent_id);
      `);
    },
  },
  {
    version: 27,
    up: (db) => {
      // A1 (dual-write Lite): canonical event log. Every state-
      // changing persistence operation appends a row here alongside
      // its existing INSERT/UPDATE on the projection tables
      // (agents / log_lines / director_messages / log_notes / etc.).
      //
      // The existing per-feature tables stay PRIMARY — reads still
      // go through them. The events table is an additive audit
      // trail; consumers that want a stream (F11 run-bundle export,
      // F5 rewind, future workflow integrations) read here.
      //
      // INTEGER PRIMARY KEY gives monotonic rowid ordering without
      // AUTOINCREMENT's reuse-prevention overhead — we never DELETE
      // from events, so rowid recycle isn't a concern. ts is
      // wall-clock ms; seq is the ordering key for reads. schema_v
      // is per-row so future kind-shape evolutions can be migrated
      // forward without rewriting old bodies.
      db.exec(`
        CREATE TABLE events (
          seq        INTEGER PRIMARY KEY,
          project_id TEXT,
          agent_id   TEXT,
          ts         INTEGER NOT NULL,
          kind       TEXT NOT NULL,
          body       TEXT,
          schema_v   INTEGER NOT NULL DEFAULT 1
        );

        CREATE INDEX idx_events_project ON events (project_id, seq);
        CREATE INDEX idx_events_agent ON events (agent_id, seq);
        CREATE INDEX idx_events_kind ON events (kind, seq);
      `);
    },
  },
  {
    version: 28,
    up: (db) => {
      // F14: opt-in per-project auto-branch on plan accept. When
      // enabled AND the workspace is a git repo, accepting a plan
      // creates/checks out `orchestrator/<planId:8>-<slug>` so the
      // agents' changes land on a scratch branch instead of whatever
      // the user happened to be on. Stored as 0/1 because sql.js
      // doesn't have a real BOOLEAN type; null is treated as 0.
      db.exec(
        `ALTER TABLE projects ADD COLUMN auto_branch INTEGER NOT NULL DEFAULT 0;`,
      );
    },
  },
  {
    version: 29,
    up: (db) => {
      // N7 Plan Critic: advisory pre-spawn critique, stored as JSON on the
      // plan's director message. NULL on older rows (no critique) — the
      // renderer simply shows no annotations.
      db.exec(`ALTER TABLE director_messages ADD COLUMN critique TEXT;`);
    },
  },
  {
    version: 30,
    up: (db) => {
      // N8 clarifying questions: the Director's pre-plan questions stored as
      // JSON on its message. NULL on older rows (no card).
      db.exec(`ALTER TABLE director_messages ADD COLUMN questions TEXT;`);
    },
  },
  {
    version: 31,
    up: (db) => {
      // N9 plan confidence: the Director's self-reported confidence + driving
      // ambiguities, stored as JSON on the plan's message. NULL on older rows
      // (no pill).
      db.exec(`ALTER TABLE director_messages ADD COLUMN confidence TEXT;`);
    },
  },
  {
    version: 32,
    up: (db) => {
      // N3 verification gate: per-project shell command run once after an
      // auto-mode plan finishes. NULL/empty on older rows = gate off.
      db.exec(`ALTER TABLE projects ADD COLUMN gate_command TEXT;`);
    },
  },
];

let dbInstance: Database | null = null;
let dbPath: string | null = null;
let saveTimer: NodeJS.Timeout | null = null;

export async function openDb(): Promise<Database> {
  if (dbInstance) return dbInstance;

  const wasmBuf = fs.readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
  const wasmBinary = wasmBuf.buffer.slice(
    wasmBuf.byteOffset,
    wasmBuf.byteOffset + wasmBuf.byteLength,
  ) as ArrayBuffer;
  const SQL = await initSqlJs({ wasmBinary });

  dbPath = path.join(app.getPath('userData'), 'orchestrator.db');
  let existing: Buffer | undefined;
  try {
    existing = fs.readFileSync(dbPath);
  } catch {
    existing = undefined;
  }

  const db = existing ? new SQL.Database(existing) : new SQL.Database();
  runMigrations(db);
  dbInstance = db;
  return db;
}

function runMigrations(db: Database): void {
  const result = db.exec('PRAGMA user_version;');
  const raw = result[0]?.values[0]?.[0];
  const current = typeof raw === 'number' ? raw : 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec('BEGIN TRANSACTION;');
    try {
      m.up(db);
      db.exec(`PRAGMA user_version = ${m.version};`);
      db.exec('COMMIT;');
    } catch (e) {
      db.exec('ROLLBACK;');
      throw e;
    }
  }
}

export function getDb(): Database {
  if (!dbInstance) throw new Error('db not opened');
  return dbInstance;
}

/**
 * True iff `openDb()` has completed and `closeDb()` hasn't been called.
 * Used by best-effort callers (e.g. skill-fire telemetry) that race
 * with `before-quit` and want to no-op instead of throw when the DB
 * is gone.
 */
export function isDbOpen(): boolean {
  return dbInstance !== null;
}

/**
 * Debounced disk flush. sql.js mutates an in-memory DB; export+writeFile
 * serialises everything. 1s window batches bursts of writes (e.g. log
 * lines arriving rapidly during a run).
 *
 * H6: the write side is now async (fs.promises.writeFile) so a 50–100
 * MB DB write doesn't block the main thread while N agents are
 * streaming. `dbInstance.export()` is still a synchronous big-buffer
 * copy — eliminating that would require moving the DB into a
 * worker_threads worker, which is a much bigger refactor (every
 * persistence call would need to round-trip via postMessage). Async
 * write closes most of the renderer-jank surface.
 *
 * Save coalescing: if a flush lands while a previous one is still
 * in flight, mark pending and re-schedule when the current one
 * settles. Avoids overlapping export+write pairs.
 */
let savePromise: Promise<void> | null = null;
let pendingFlush = false;

export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveDb();
  }, 1000);
}

export async function saveDb(): Promise<void> {
  if (!dbInstance || !dbPath) return;
  if (savePromise) {
    // A flush is already in flight. Defer our work to after it
    // settles by setting the pending flag — the in-flight chain
    // will requeue itself when it sees the flag.
    pendingFlush = true;
    return savePromise;
  }
  const run = async (): Promise<void> => {
    try {
      do {
        pendingFlush = false;
        if (!dbInstance || !dbPath) return;
        const data = dbInstance.export();
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        await fs.promises.writeFile(dbPath, data);
      } while (pendingFlush);
    } finally {
      savePromise = null;
    }
  };
  savePromise = run();
  return savePromise;
}

/**
 * Synchronous final flush + close. Called from Electron's
 * before-quit handler, which doesn't await — so we go back to
 * writeFileSync here to make sure the bytes hit disk before the
 * process exits. The async saveDb path is only for the runtime
 * debounced flushes during the session.
 */
export function closeDb(): void {
  if (!dbInstance) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dbPath) {
    try {
      const data = dbInstance.export();
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      fs.writeFileSync(dbPath, data);
    } catch {
      // best-effort on quit — surface only if it bites in practice
    }
  }
  dbInstance.close();
  dbInstance = null;
}

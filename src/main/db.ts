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
 * Debounced disk flush. sql.js mutates an in-memory DB; export+writeFile
 * serialises everything. 1s window batches bursts of writes (e.g. log
 * lines arriving rapidly during a run).
 */
export function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveDb();
  }, 1000);
}

export function saveDb(): void {
  if (!dbInstance || !dbPath) return;
  const data = dbInstance.export();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, data);
}

export function closeDb(): void {
  if (!dbInstance) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  saveDb();
  dbInstance.close();
  dbInstance = null;
}

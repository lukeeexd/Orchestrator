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
];

let dbInstance: Database | null = null;
let dbPath: string | null = null;

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

export function saveDb(): void {
  if (!dbInstance || !dbPath) return;
  const data = dbInstance.export();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, data);
}

export function closeDb(): void {
  if (!dbInstance) return;
  saveDb();
  dbInstance.close();
  dbInstance = null;
}

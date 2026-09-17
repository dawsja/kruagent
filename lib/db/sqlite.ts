import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Where Kru keeps its database and secret key: `KRU_DATA_DIR`, else ./data. */
export function dataDir() {
  // The data folder is chosen at runtime, so keep the bundler from tracing it.
  return path.resolve(
    /*turbopackIgnore: true*/ process.env.KRU_DATA_DIR ?? path.join(process.cwd(), "data"),
  );
}

export function dbPath() {
  return path.join(dataDir(), "kru.db");
}

type DbCache = { path: string; db: DatabaseSync };
const holder = globalThis as typeof globalThis & { __kruSqlite?: DbCache };

/** Creates the data directory if needed and keeps it owner-only. */
export function ensureDataDir() {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return dir;
}

/**
 * Opens the database once per process. The file is created owner-only before
 * WAL mode is turned on, so the -wal and -shm files SQLite adds get the same
 * 0600 permissions. Nothing calls this at import time, so `next build` never
 * creates a database.
 */
export function getDb(): DatabaseSync {
  const file = dbPath();
  const cached = holder.__kruSqlite;
  if (cached && cached.path === file) return cached.db;

  ensureDataDir();
  if (!existsSync(file)) closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);

  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  holder.__kruSqlite = { path: file, db };
  return db;
}

/** Closes the cached handle. Tests use this between data directories. */
export function closeDb() {
  holder.__kruSqlite?.db.close();
  holder.__kruSqlite = undefined;
}

/**
 * Runs `fn` inside an immediate write transaction. `fn` must be synchronous,
 * so no network call can happen while the transaction is open. A call made
 * while a transaction is already open joins it.
 */
export function tx<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  if (db.isTransaction) return fn(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    if (result instanceof Promise) {
      throw new Error("Database transactions must be synchronous");
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

import type { DatabaseSync } from "node:sqlite";
import { importLegacyJson } from "./import-json.ts";
import { runKruMigrations } from "./migrations.ts";
import { dataDir, getDb } from "./sqlite.ts";

const holder = globalThis as typeof globalThis & { __kruDbReady?: string };

/**
 * Work cut short by a restart can't resume, so mark it as an error and say
 * why. A run that was opening its pull request names the branch to check.
 */
function recoverInterruptedRuns(db: DatabaseSync) {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const stuck = db
      .prepare(
        "SELECT id, card_id, status, head_branch FROM kru_runs WHERE status IN ('running', 'applying')",
      )
      .all() as { id: string; card_id: string; status: string; head_branch: string | null }[];
    for (const run of stuck) {
      const message =
        run.status === "applying"
          ? `Interrupted by server restart while opening the pull request${run.head_branch ? `. Check branch ${run.head_branch} on GitHub.` : "."}`
          : "Interrupted by server restart";
      db.prepare("UPDATE kru_runs SET status = 'error', error = ?, updated_at = ? WHERE id = ?")
        .run(message, now, run.id);
      db.prepare(
        "UPDATE kru_cards SET status = 'error', column_id = 'run', updated_at = ? WHERE id = ?",
      ).run(now, run.card_id);
    }
    db.exec("COMMIT");
    return stuck.length;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * A job whose agent run was cut short can't continue: the run has just been
 * marked an error, so the job fails with it. Every other job only loses its
 * owner, and the dispatcher picks it up again. Chat claims are dropped too.
 */
function recoverInterruptedBotJobs(db: DatabaseSync) {
  const now = new Date().toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const failed = db
      .prepare(
        `UPDATE kru_bot_jobs SET stage = 'failed', error = 'Interrupted by server restart', claimed_by = NULL, updated_at = ?
         WHERE stage = 'build' AND run_id IN (SELECT id FROM kru_runs WHERE status = 'error')`,
      )
      .run(now).changes;
    db.prepare("UPDATE kru_bot_jobs SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
    db.prepare("UPDATE kru_chat_messages SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
    db.exec("COMMIT");
    return Number(failed);
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Opens the database and brings it up to date once per process: Kru
 * migrations, the one-time JSON import, then recovery of runs a restart
 * interrupted. Cheap after the first call, so every data access calls it.
 */
export function ensureKruDatabase(): DatabaseSync {
  const db = getDb();
  const dir = dataDir();
  if (holder.__kruDbReady === dir) return db;

  runKruMigrations(db);
  const summary = importLegacyJson(db, dir);
  if (summary.imported) {
    console.info(
      `[kru] Imported data/kru.json into SQLite: ${summary.connections} connections` +
        ` (${summary.droppedConnections} unsupported sign-ins dropped), ${summary.cards} cards,` +
        ` ${summary.runs} runs (${summary.droppedRuns} without a card dropped).` +
        " The original is now kru.json.imported. Delete it once you're satisfied, because it holds plaintext secrets.",
    );
  }
  const recovered = recoverInterruptedRuns(db);
  if (recovered) console.info(`[kru] Marked ${recovered} interrupted run(s) as errors.`);
  const failedJobs = recoverInterruptedBotJobs(db);
  if (failedJobs) console.info(`[kru] Marked ${failedJobs} interrupted bot job(s) as failed.`);

  holder.__kruDbReady = dir;
  return db;
}

/** Forgets the ready flag. Tests use this between data directories. */
export function resetDatabaseReady() {
  holder.__kruDbReady = undefined;
}

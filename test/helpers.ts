import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDatabaseReady } from "../lib/db/init.ts";
import { closeDb } from "../lib/db/sqlite.ts";
import { resetSecretKeyCache } from "../lib/hq/secrets.ts";

/** Points Kru at a fresh temporary data directory and returns a cleanup. */
export function useTempDataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kru-test-"));
  process.env.KRU_DATA_DIR = dir;
  delete process.env.KRU_SECRET_KEY;
  closeDb();
  resetDatabaseReady();
  resetSecretKeyCache();
  return {
    dir,
    cleanup() {
      closeDb();
      resetDatabaseReady();
      resetSecretKeyCache();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

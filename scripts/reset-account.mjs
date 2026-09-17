// Removes Kru's account so a new one can be registered. Cards, runs,
// connections and API keys stay. Restart Kru afterwards; it prints a new
// setup token in its logs.
//
//   node scripts/reset-account.mjs
//   docker compose exec kru node scripts/reset-account.mjs
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = path.resolve(process.env.KRU_DATA_DIR ?? path.join(process.cwd(), "data"));
const file = path.join(dir, "kru.db");
if (!existsSync(file)) {
  console.error(`No Kru database at ${file}. Set KRU_DATA_DIR if it lives elsewhere.`);
  process.exit(1);
}

const db = new DatabaseSync(file);
const tables = new Set(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name),
);
db.exec("BEGIN IMMEDIATE");
try {
  for (const table of ["session", "account", "verification", "user"]) {
    if (tables.has(table)) db.exec(`DELETE FROM "${table}"`);
  }
  db.exec("COMMIT");
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
}
db.close();
console.log("Kru account removed. Restart Kru, then register again with the new setup token from its logs.");

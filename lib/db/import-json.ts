import { chmodSync, existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { encryptOptional, encryptSecret } from "../hq/secrets.ts";
import type { Card, Connection, GithubApp, Onboarding, Run } from "../hq/types";

type LegacyState = {
  cards?: Card[];
  connections?: Connection[];
  runs?: Run[];
  onboarding?: Onboarding | null;
  githubApp?: GithubApp | null;
};

const SUPPORTED_PROVIDERS = new Set(["github", "openai", "anthropic", "xai"]);

/** Raised when an old data/kru.json exists but can't be parsed. */
export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegacyImportError";
  }
}

/**
 * Connections saved before ids existed use their provider as the id, which
 * keeps cards that point at them working. Ids are kept unique.
 */
export function normalizeConnections(connections: Connection[]): Connection[] {
  const seen = new Set<string>();
  return connections.map((connection) => {
    let id = connection.id || connection.provider;
    let suffix = 2;
    while (seen.has(id)) id = `${connection.provider}-${suffix++}`;
    seen.add(id);
    return id === connection.id ? connection : { ...connection, id };
  });
}

export type ImportSummary = {
  imported: boolean;
  connections: number;
  droppedConnections: number;
  cards: number;
  runs: number;
  droppedRuns: number;
};

function connectionIdOf(ref: string | null | undefined) {
  const raw = ref ?? "";
  const colon = raw.indexOf(":");
  return colon > 0 ? raw.slice(0, colon) : "";
}

/**
 * Moves an old `kru.json` store into SQLite once, in a single transaction,
 * then renames the file to `kru.json.imported`. A file that can't be parsed
 * stops startup instead of silently starting with an empty database.
 */
export function importLegacyJson(db: DatabaseSync, dir: string): ImportSummary {
  const nothing: ImportSummary = {
    imported: false,
    connections: 0,
    droppedConnections: 0,
    cards: 0,
    runs: 0,
    droppedRuns: 0,
  };
  const file = path.join(dir, "kru.json");
  if (!existsSync(file)) return nothing;
  if (db.prepare("SELECT 1 FROM kru_meta WHERE key = 'imported_json'").get()) {
    return nothing;
  }

  let state: LegacyState;
  try {
    state = JSON.parse(readFileSync(file, "utf8")) as LegacyState;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LegacyImportError(
      `${file} could not be read (${detail}). Kru stopped instead of starting with an empty database. Fix or move the file, then start Kru again.`,
    );
  }

  const now = new Date().toISOString();
  const allConnections = normalizeConnections(state.connections ?? []);
  const connections = allConnections.filter((item) =>
    SUPPORTED_PROVIDERS.has(item.provider),
  );
  const keptIds = new Set(connections.map((item) => item.id));
  const cards = state.cards ?? [];
  const cardIds = new Set(cards.map((item) => item.id));
  const allRuns = state.runs ?? [];
  const runs = allRuns.filter((item) => cardIds.has(item.cardId));

  db.exec("BEGIN IMMEDIATE");
  try {
    const insertConnection = db.prepare(
      `INSERT INTO kru_connections
        (id, provider, label, meta, access_token_enc, refresh_token_enc, expires_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    connections.forEach((item, index) => {
      insertConnection.run(
        item.id,
        item.provider,
        item.label ?? "",
        JSON.stringify(item.meta ?? {}),
        encryptSecret(item.accessToken ?? ""),
        encryptOptional(item.refreshToken),
        item.expiresAt ?? null,
        index,
        now,
        now,
      );
    });

    const insertCard = db.prepare(
      `INSERT INTO kru_cards
        (id, title, body, column_id, repo, model, status, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const card of cards) {
      const model = keptIds.has(connectionIdOf(card.model)) ? card.model : null;
      insertCard.run(
        card.id,
        card.title,
        card.body ?? "",
        card.column,
        card.repo ?? null,
        model ?? null,
        card.status,
        card.runId ?? null,
        card.createdAt ?? now,
        card.updatedAt ?? now,
      );
    }

    const insertRun = db.prepare(
      `INSERT INTO kru_runs
        (id, card_id, status, proposed_writes, pr_url, error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertLog = db.prepare(
      "INSERT INTO kru_run_logs (run_id, seq, line, at) VALUES (?, ?, ?, ?)",
    );
    // Runs keep their saved status. A run that was still going is marked as
    // interrupted, together with its card, by the startup recovery step.
    for (const run of runs) {
      insertRun.run(
        run.id,
        run.cardId,
        run.status,
        JSON.stringify(run.proposedWrites ?? []),
        run.prUrl ?? null,
        run.error ?? null,
        run.createdAt ?? now,
        run.updatedAt ?? now,
      );
      (run.log ?? []).forEach((line, seq) => {
        insertLog.run(run.id, seq, String(line), run.updatedAt ?? now);
      });
    }

    const app = state.githubApp ?? null;
    const onboarding = state.onboarding ?? null;
    if (app || onboarding) {
      db.prepare(
        `INSERT INTO kru_settings
          (id, onboarding, github_app_id, github_app_slug, github_client_id,
           github_client_secret_enc, github_pem_enc, github_installation_id, updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        onboarding ? JSON.stringify(onboarding) : null,
        app?.appId ?? null,
        app?.slug ?? null,
        app?.clientId ?? null,
        encryptOptional(app?.clientSecret),
        encryptOptional(app?.pem),
        app?.installationId ?? null,
        now,
      );
    }

    db.prepare("INSERT INTO kru_meta (key, value) VALUES ('imported_json', ?)").run(now);
    db.exec("COMMIT");
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }

  const target = `${file}.imported`;
  renameSync(file, target);
  chmodSync(target, 0o600);

  return {
    imported: true,
    connections: connections.length,
    droppedConnections: allConnections.length - connections.length,
    cards: cards.length,
    runs: runs.length,
    droppedRuns: allRuns.length - runs.length,
  };
}

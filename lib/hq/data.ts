import type { DatabaseSync } from "node:sqlite";
import { ensureKruDatabase } from "../db/init.ts";
import { tx } from "../db/sqlite.ts";
import { emit, type LiveEvent } from "./events.ts";
import {
  decryptOptional,
  decryptSecret,
  encryptOptional,
  encryptSecret,
} from "./secrets.ts";
import {
  isActiveStage,
  type BotId,
  type BotJob,
  type BotStage,
  type Card,
  type ChatAttachment,
  type ChatMessage,
  type ColumnId,
  type Connection,
  type ConnectionProvider,
  type GithubApp,
  type Onboarding,
  type PrEtags,
  type PrFeedback,
  type PrFeedbackKind,
  type ProposedWrite,
  type Run,
} from "./types.ts";

/*
 * Kru's data access. Every function is synchronous: SQLite calls are fast
 * and local, and keeping them synchronous means no network call can run
 * inside a transaction. Secrets are encrypted on write and decrypted on read
 * here, so the rest of the app only sees plain `Connection` values.
 */

type Row = Record<string, unknown>;

function db(): DatabaseSync {
  return ensureKruDatabase();
}

// Events a write announces, held until its transaction commits: a rolled
// back write tells nobody, and nested writes announce once.
const pendingEvents = new Map<string, LiveEvent>();

function announce(event: LiveEvent) {
  const key =
    event.topic === "run" ? `run:${event.runId}` : event.topic === "chat" && event.cleared ? "chat:cleared" : event.topic;
  pendingEvents.set(key, event);
}

function write<T>(fn: (d: DatabaseSync) => T): T {
  const d = ensureKruDatabase();
  const outermost = !d.isTransaction;
  try {
    const result = tx(fn);
    if (outermost) {
      const events = [...pendingEvents.values()];
      pendingEvents.clear();
      for (const event of events) emit(event);
    }
    return result;
  } catch (error) {
    if (outermost) pendingEvents.clear();
    throw error;
  }
}

function now() {
  return new Date().toISOString();
}

function text(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function integer(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

// ---------- connections ----------

function toConnection(row: Row): Connection {
  return {
    id: String(row.id),
    provider: String(row.provider) as ConnectionProvider,
    label: String(row.label),
    meta: JSON.parse(String(row.meta ?? "{}")) as Record<string, string>,
    accessToken: decryptSecret(String(row.access_token_enc)),
    refreshToken: decryptOptional(text(row.refresh_token_enc)),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
  };
}

export function listConnections(): Connection[] {
  const rows = db()
    .prepare("SELECT * FROM kru_connections ORDER BY position, created_at")
    .all() as Row[];
  return rows.map(toConnection);
}

export function getConnection(id: string): Connection | null {
  const row = db().prepare("SELECT * FROM kru_connections WHERE id = ?").get(id) as Row | undefined;
  return row ? toConnection(row) : null;
}

export function getGithubConnection(): Connection | null {
  const row = db()
    .prepare("SELECT * FROM kru_connections WHERE provider = 'github' ORDER BY position LIMIT 1")
    .get() as Row | undefined;
  return row ? toConnection(row) : null;
}

/** Inserts a connection, or updates it in place keeping its position. */
export function upsertConnection(connection: Connection) {
  const at = now();
  write((d) => {
    const existing = d
      .prepare("SELECT position, created_at FROM kru_connections WHERE id = ?")
      .get(connection.id) as Row | undefined;
    const position = existing
      ? Number(existing.position)
      : Number(
          (d.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next FROM kru_connections").get() as Row)
            .next,
        );
    d.prepare(
      `INSERT INTO kru_connections
        (id, provider, label, meta, access_token_enc, refresh_token_enc, expires_at, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         provider = excluded.provider, label = excluded.label, meta = excluded.meta,
         access_token_enc = excluded.access_token_enc, refresh_token_enc = excluded.refresh_token_enc,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).run(
      connection.id,
      connection.provider,
      connection.label,
      JSON.stringify(connection.meta ?? {}),
      encryptSecret(connection.accessToken),
      encryptOptional(connection.refreshToken),
      connection.expiresAt ?? null,
      position,
      existing ? String(existing.created_at) : at,
      at,
    );
    announce({ topic: "board" });
  });
}

/** Saves a connection and removes any other connection of the same provider. */
export function replaceProviderConnection(connection: Connection) {
  write((d) => {
    d.prepare("DELETE FROM kru_connections WHERE provider = ? AND id <> ?").run(
      connection.provider,
      connection.id,
    );
    upsertConnection(connection);
  });
}

export function deleteConnection(id: string): boolean {
  return write((d) => {
    const gone = d.prepare("DELETE FROM kru_connections WHERE id = ?").run(id).changes > 0;
    if (gone) announce({ topic: "board" });
    return gone;
  });
}

export function deleteConnectionsByProvider(provider: ConnectionProvider): number {
  return write((d) => {
    const count = Number(d.prepare("DELETE FROM kru_connections WHERE provider = ?").run(provider).changes);
    if (count) announce({ topic: "board" });
    return count;
  });
}

export function updateTokens(
  id: string,
  accessToken: string,
  refreshToken: string | null,
  expiresAt: number | null,
) {
  write((d) => {
    d.prepare(
      "UPDATE kru_connections SET access_token_enc = ?, refresh_token_enc = ?, expires_at = ?, updated_at = ? WHERE id = ?",
    ).run(encryptSecret(accessToken), encryptOptional(refreshToken), expiresAt, now(), id);
  });
}

// ---------- cards ----------

function toCard(row: Row): Card {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body ?? ""),
    column: String(row.column_id) as ColumnId,
    repo: text(row.repo),
    model: text(row.model),
    status: String(row.status) as Card["status"],
    runId: text(row.run_id),
    issueNumber: integer(row.issue_number),
    issueUrl: text(row.issue_url),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listCards(): Card[] {
  const rows = db().prepare("SELECT * FROM kru_cards ORDER BY created_at DESC").all() as Row[];
  return rows.map(toCard);
}

export function getCard(id: string): Card | null {
  const row = db().prepare("SELECT * FROM kru_cards WHERE id = ?").get(id) as Row | undefined;
  return row ? toCard(row) : null;
}

export function insertCard(card: Card) {
  write((d) => {
    d.prepare(
      `INSERT INTO kru_cards (id, title, body, column_id, repo, model, status, run_id, issue_number, issue_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      card.id,
      card.title,
      card.body,
      card.column,
      card.repo,
      card.model,
      card.status,
      card.runId,
      card.issueNumber ?? null,
      card.issueUrl ?? null,
      card.createdAt,
      card.updatedAt,
    );
    announce({ topic: "board" });
  });
}

/**
 * Inserts a card made from a GitHub issue and records the import, together.
 * Returns false, inserting nothing, when that issue was imported before,
 * even if its card has since been deleted.
 */
export function insertCardForIssue(card: Card, issue: { id: number; repo: string; number: number }): boolean {
  return write((d) => {
    const recorded = d
      .prepare(
        `INSERT INTO kru_issue_imports (issue_id, repo, issue_number, card_id, imported_at)
         VALUES (?, ?, ?, ?, ?) ON CONFLICT (issue_id) DO NOTHING`,
      )
      .run(issue.id, issue.repo, issue.number, card.id, card.createdAt).changes;
    if (recorded === 0) return false;
    insertCard(card);
    return true;
  });
}

/** Issue ids already turned into cards, for one repo or all. */
export function importedIssueIds(repo?: string): Set<number> {
  const rows = (
    repo
      ? db().prepare("SELECT issue_id FROM kru_issue_imports WHERE repo = ?").all(repo)
      : db().prepare("SELECT issue_id FROM kru_issue_imports").all()
  ) as Row[];
  return new Set(rows.map((row) => Number(row.issue_id)));
}

/** The card an issue became, if it was imported and the card still exists. */
export function cardForIssue(repo: string, number: number): Card | null {
  const row = db()
    .prepare(
      `SELECT c.* FROM kru_issue_imports i JOIN kru_cards c ON c.id = i.card_id
       WHERE i.repo = ? AND i.issue_number = ?`,
    )
    .get(repo, number) as Row | undefined;
  return row ? toCard(row) : null;
}

/** Whether an issue was imported at all, card or no card. */
export function wasIssueImported(repo: string, number: number): boolean {
  return Boolean(
    db().prepare("SELECT 1 FROM kru_issue_imports WHERE repo = ? AND issue_number = ?").get(repo, number),
  );
}

export type CardPatch = Partial<
  Pick<Card, "title" | "body" | "column" | "repo" | "model" | "status" | "runId">
>;

const CARD_COLUMNS: Record<keyof CardPatch, string> = {
  title: "title",
  body: "body",
  column: "column_id",
  repo: "repo",
  model: "model",
  status: "status",
  runId: "run_id",
};

function applyCardPatch(d: DatabaseSync, id: string, patch: CardPatch, at: string) {
  const keys = (Object.keys(patch) as (keyof CardPatch)[]).filter((key) => patch[key] !== undefined);
  const sets = keys.map((key) => `${CARD_COLUMNS[key]} = ?`);
  const values = keys.map((key) => patch[key] ?? null);
  const changed =
    d
      .prepare(`UPDATE kru_cards SET ${[...sets, "updated_at = ?"].join(", ")} WHERE id = ?`)
      .run(...(values as (string | null)[]), at, id).changes > 0;
  if (changed) announce({ topic: "board" });
  return changed;
}

/** Updates the given card fields. Returns the card, or null when it doesn't exist. */
export function patchCard(id: string, patch: CardPatch): Card | null {
  const changed = write((d) => applyCardPatch(d, id, patch, now()));
  return changed ? getCard(id) : null;
}

/** Deletes a card; its runs and their logs go with it. */
export function deleteCard(id: string): boolean {
  return write((d) => {
    const gone = d.prepare("DELETE FROM kru_cards WHERE id = ?").run(id).changes > 0;
    if (gone) announce({ topic: "board" });
    return gone;
  });
}

// ---------- runs ----------

function logsByRun(d: DatabaseSync, runId?: string) {
  const rows = (
    runId
      ? d.prepare("SELECT run_id, line FROM kru_run_logs WHERE run_id = ? ORDER BY seq").all(runId)
      : d.prepare("SELECT run_id, line FROM kru_run_logs ORDER BY run_id, seq").all()
  ) as Row[];
  const map = new Map<string, string[]>();
  for (const row of rows) {
    const key = String(row.run_id);
    const list = map.get(key) ?? [];
    list.push(String(row.line));
    map.set(key, list);
  }
  return map;
}

function toRun(row: Row, log: string[]): Run {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    status: String(row.status) as Run["status"],
    log,
    proposedWrites: JSON.parse(String(row.proposed_writes ?? "[]")) as ProposedWrite[],
    baseBranch: text(row.base_branch),
    headBranch: text(row.head_branch),
    prUrl: text(row.pr_url),
    prNumber: integer(row.pr_number),
    prHeadSha: text(row.pr_head_sha),
    prState: text(row.pr_state) as Run["prState"],
    prEtag: text(row.pr_etag),
    prEtags: row.pr_etags ? (JSON.parse(String(row.pr_etags)) as PrEtags) : null,
    followUpReason: text(row.follow_up_reason) as Run["followUpReason"],
    error: text(row.error),
    warning: text(row.warning),
    summary: text(row.summary),
    revisionOf: text(row.revision_of),
    revisionNote: text(row.revision_note),
    bot: text(row.bot) as BotId | null,
    commitMessage: text(row.commit_message),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function listRuns(): Run[] {
  const d = db();
  const logs = logsByRun(d);
  const rows = d.prepare("SELECT * FROM kru_runs ORDER BY created_at DESC").all() as Row[];
  return rows.map((row) => toRun(row, logs.get(String(row.id)) ?? []));
}

export function getRun(id: string): Run | null {
  const d = db();
  const row = d.prepare("SELECT * FROM kru_runs WHERE id = ?").get(id) as Row | undefined;
  return row ? toRun(row, logsByRun(d, id).get(id) ?? []) : null;
}

/** Inserts a run with its first log lines and updates its card, atomically. */
export function createRun(run: Run, cardPatch: CardPatch) {
  write((d) => {
    d.prepare(
      `INSERT INTO kru_runs
        (id, card_id, status, proposed_writes, base_branch, head_branch, pr_url, pr_number,
         pr_head_sha, pr_state, follow_up_reason, error, warning,
         summary, revision_of, revision_note, bot, commit_message, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.cardId,
      run.status,
      JSON.stringify(run.proposedWrites),
      run.baseBranch ?? null,
      run.headBranch ?? null,
      run.prUrl,
      run.prNumber ?? null,
      run.prHeadSha ?? null,
      run.prState ?? null,
      run.followUpReason ?? null,
      run.error,
      run.warning ?? null,
      run.summary ?? null,
      run.revisionOf ?? null,
      run.revisionNote ?? null,
      run.bot ?? null,
      run.commitMessage ?? null,
      run.createdAt,
      run.updatedAt,
    );
    const insertLog = d.prepare("INSERT INTO kru_run_logs (run_id, seq, line, at) VALUES (?, ?, ?, ?)");
    run.log.forEach((line, seq) => insertLog.run(run.id, seq, line, run.createdAt));
    applyCardPatch(d, run.cardId, cardPatch, run.updatedAt);
    announce({ topic: "run", runId: run.id });
    announce({ topic: "board" });
  });
}

export type RunPatch = {
  proposedWrites?: ProposedWrite[];
  baseBranch?: string | null;
  headBranch?: string | null;
  prUrl?: string | null;
  prNumber?: number | null;
  prHeadSha?: string | null;
  prState?: Run["prState"];
  prEtag?: string | null;
  prEtags?: PrEtags | null;
  error?: string | null;
  warning?: string | null;
  summary?: string | null;
  commitMessage?: string | null;
};

/**
 * Moves a run to `to` only if its current status is one of `from`, applying
 * `patch` and an optional card change in the same transaction. Returns false
 * when the run was not in an expected status, e.g. it was cancelled.
 * Pass `to: null` to keep the status and only apply the patch.
 */
export function transitionRun(
  id: string,
  from: Run["status"][],
  to: Run["status"] | null,
  patch: RunPatch = {},
  cardPatch?: CardPatch,
): boolean {
  if (from.length === 0) return false;
  return write((d) => {
    const at = now();
    const sets: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [at];
    if (to) {
      sets.push("status = ?");
      values.push(to);
    }
    if (patch.proposedWrites !== undefined) {
      sets.push("proposed_writes = ?");
      values.push(JSON.stringify(patch.proposedWrites));
    }
    if (patch.prEtags !== undefined) {
      sets.push("pr_etags = ?");
      values.push(patch.prEtags ? JSON.stringify(patch.prEtags) : null);
    }
    if (patch.prNumber !== undefined) {
      sets.push("pr_number = ?");
      values.push(patch.prNumber);
    }
    for (const [key, column] of [
      ["baseBranch", "base_branch"],
      ["headBranch", "head_branch"],
      ["prUrl", "pr_url"],
      ["prHeadSha", "pr_head_sha"],
      ["prState", "pr_state"],
      ["prEtag", "pr_etag"],
      ["error", "error"],
      ["warning", "warning"],
      ["summary", "summary"],
      ["commitMessage", "commit_message"],
    ] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    const placeholders = from.map(() => "?").join(", ");
    const changed =
      d
        .prepare(`UPDATE kru_runs SET ${sets.join(", ")} WHERE id = ? AND status IN (${placeholders})`)
        .run(...values, id, ...from).changes > 0;
    if (changed && cardPatch) {
      const row = d.prepare("SELECT card_id FROM kru_runs WHERE id = ?").get(id) as Row | undefined;
      if (row) applyCardPatch(d, String(row.card_id), cardPatch, at);
    }
    if (changed) {
      announce({ topic: "run", runId: id });
      announce({ topic: "board" });
    }
    return changed;
  });
}

/** Appends a log line unless the run is gone or cancelled. */
export function appendRunLog(runId: string, line: string): boolean {
  return write((d) => {
    const run = d.prepare("SELECT status FROM kru_runs WHERE id = ?").get(runId) as Row | undefined;
    if (!run || run.status === "cancelled") return false;
    const next = d
      .prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM kru_run_logs WHERE run_id = ?")
      .get(runId) as Row;
    d.prepare("INSERT INTO kru_run_logs (run_id, seq, line, at) VALUES (?, ?, ?, ?)").run(
      runId,
      Number(next.seq),
      line,
      now(),
    );
    announce({ topic: "run", runId });
    announce({ topic: "board" });
    return true;
  });
}

export function listBoard() {
  return { cards: listCards(), runs: listRuns(), connections: listConnections() };
}

// ---------- settings: onboarding and the GitHub App ----------

function ensureSettingsRow(d: DatabaseSync) {
  d.prepare("INSERT INTO kru_settings (id, updated_at) VALUES (1, ?) ON CONFLICT (id) DO NOTHING").run(
    now(),
  );
}

export function getOnboarding(): Onboarding | null {
  const row = db().prepare("SELECT onboarding FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return row?.onboarding ? (JSON.parse(String(row.onboarding)) as Onboarding) : null;
}

export function saveOnboarding(onboarding: Onboarding) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET onboarding = ?, updated_at = ? WHERE id = 1").run(
      JSON.stringify(onboarding),
      now(),
    );
  });
}

/** The GitHub App created through the manifest flow, if any. */
export function getStoredGithubApp(): GithubApp | null {
  const row = db().prepare("SELECT * FROM kru_settings WHERE id = 1").get() as Row | undefined;
  if (!row?.github_client_id || !row.github_client_secret_enc) return null;
  return {
    clientId: String(row.github_client_id),
    clientSecret: decryptSecret(String(row.github_client_secret_enc)),
    slug: String(row.github_app_slug ?? ""),
    appId: Number(row.github_app_id ?? 0),
    installationId:
      row.github_installation_id === null || row.github_installation_id === undefined
        ? undefined
        : Number(row.github_installation_id),
    pem: decryptOptional(text(row.github_pem_enc)) ?? undefined,
  };
}

export function saveGithubApp(app: GithubApp) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare(
      `UPDATE kru_settings SET github_app_id = ?, github_app_slug = ?, github_client_id = ?,
         github_client_secret_enc = ?, github_pem_enc = ?, github_installation_id = ?, updated_at = ?
       WHERE id = 1`,
    ).run(
      app.appId,
      app.slug,
      app.clientId,
      encryptSecret(app.clientSecret),
      encryptOptional(app.pem),
      app.installationId ?? null,
      now(),
    );
  });
}

export function setInstallationId(installationId: number) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET github_installation_id = ?, updated_at = ? WHERE id = 1").run(
      installationId,
      now(),
    );
  });
}


// ---------- settings: bots ----------

/** Whether the crew picks up dropped cards and answers in the Team room. */
export function getBotsEnabled(): boolean {
  const row = db().prepare("SELECT bots_enabled FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return Number(row?.bots_enabled ?? 0) === 1;
}

export function setBotsEnabled(enabled: boolean) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET bots_enabled = ?, updated_at = ? WHERE id = 1").run(
      enabled ? 1 : 0,
      now(),
    );
    announce({ topic: "board" });
  });
}

/** The model ref the crew chats with, or null for the default choice. */
export function getBotsModel(): string | null {
  const row = db().prepare("SELECT bots_model FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return text(row?.bots_model);
}

export function setBotsModel(model: string | null) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET bots_model = ?, updated_at = ? WHERE id = 1").run(model, now());
  });
}

/**
 * Whether the crew pushes a follow-up to a pull request the person already
 * approved without asking again. Off, the follow-up waits in Review.
 */
export function getBotsAutoPush(): boolean {
  const row = db().prepare("SELECT bots_auto_push FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return Number(row?.bots_auto_push ?? 0) === 1;
}

export function setBotsAutoPush(enabled: boolean) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET bots_auto_push = ?, updated_at = ? WHERE id = 1").run(
      enabled ? 1 : 0,
      now(),
    );
    announce({ topic: "board" });
  });
}

/**
 * GitHub App permissions a read has been refused for, e.g. "checks" when
 * the app was created before Kru asked for it. Settings shows how to grant
 * them; the sync stops asking until the list is cleared.
 */
export function getMissingGithubPermissions(): string[] {
  const row = db()
    .prepare("SELECT github_missing_permissions FROM kru_settings WHERE id = 1")
    .get() as Row | undefined;
  return row?.github_missing_permissions ? (JSON.parse(String(row.github_missing_permissions)) as string[]) : [];
}

/** Whether the crew turns open issues carrying the label into cards. */
export function getIssuesEnabled(): boolean {
  const row = db().prepare("SELECT issues_enabled FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return Number(row?.issues_enabled ?? 0) === 1;
}

export function setIssuesEnabled(enabled: boolean) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET issues_enabled = ?, updated_at = ? WHERE id = 1").run(enabled ? 1 : 0, now());
  });
}

export const DEFAULT_ISSUE_LABEL = "kru";

export function getIssueLabel(): string {
  const row = db().prepare("SELECT issue_label FROM kru_settings WHERE id = 1").get() as Row | undefined;
  return text(row?.issue_label)?.trim() || DEFAULT_ISSUE_LABEL;
}

/** Changing the label starts every repo's cursor over, so issues already labelled are seen. */
export function setIssueLabel(label: string) {
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET issue_label = ?, updated_at = ? WHERE id = 1").run(label, now());
    d.prepare("DELETE FROM kru_issue_sync").run();
  });
}

export type IssueSync = { repo: string; since: string | null; etag: string | null; checkedAt: string };

export function getIssueSync(repo: string): IssueSync | null {
  const row = db().prepare("SELECT * FROM kru_issue_sync WHERE repo = ?").get(repo) as Row | undefined;
  return row
    ? { repo: String(row.repo), since: text(row.since), etag: text(row.etag), checkedAt: String(row.checked_at) }
    : null;
}

export function setIssueSync(repo: string, patch: { since: string | null; etag: string | null }) {
  write((d) => {
    d.prepare(
      `INSERT INTO kru_issue_sync (repo, since, etag, checked_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET since = excluded.since, etag = excluded.etag, checked_at = excluded.checked_at`,
    ).run(repo, patch.since, patch.etag, now());
  });
}

export function setMissingGithubPermissions(permissions: string[]) {
  const unique = [...new Set(permissions)].sort();
  write((d) => {
    ensureSettingsRow(d);
    d.prepare("UPDATE kru_settings SET github_missing_permissions = ?, updated_at = ? WHERE id = 1").run(
      unique.length ? JSON.stringify(unique) : null,
      now(),
    );
    announce({ topic: "board" });
  });
}

// ---------- bot jobs ----------

function toBotJob(row: Row): BotJob {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    stage: String(row.stage) as BotStage,
    runId: text(row.run_id),
    rounds: Number(row.rounds ?? 0),
    testReport: text(row.test_report),
    reviewVerdict: text(row.review_verdict),
    reviewNotes: text(row.review_notes),
    error: text(row.error),
    attempts: Number(row.attempts ?? 0),
    retryAt: text(row.retry_at),
    claimedBy: text(row.claimed_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

const TERMINAL_STAGES = "('done', 'failed', 'cancelled')";

/**
 * Every job, newest first; `active` keeps only the ones still in flight,
 * `retryDue` only failed jobs whose retry time has come, oldest first.
 */
export function listBotJobs(options: { active?: boolean; retryDue?: string } = {}): BotJob[] {
  const rows = (
    options.retryDue
      ? db()
          .prepare("SELECT * FROM kru_bot_jobs WHERE stage = 'failed' AND retry_at IS NOT NULL AND retry_at <= ? ORDER BY retry_at")
          .all(options.retryDue)
      : options.active
        ? db().prepare(`SELECT * FROM kru_bot_jobs WHERE stage NOT IN ${TERMINAL_STAGES} ORDER BY created_at`).all()
        : db().prepare("SELECT * FROM kru_bot_jobs ORDER BY created_at DESC").all()
  ) as Row[];
  return rows.map(toBotJob);
}

/** Every job the crew ran on one card, oldest first, for its history. */
export function listBotJobsForCard(cardId: string): BotJob[] {
  const rows = db().prepare("SELECT * FROM kru_bot_jobs WHERE card_id = ? ORDER BY created_at").all(cardId) as Row[];
  return rows.map(toBotJob);
}

/**
 * Starts the retry of a failed job: a new job at build with one more
 * attempt, and the old job's retry cleared, in one transaction. Null when
 * the old job was already retried or cancelled, or the card has another
 * job going (the partial unique index refuses it).
 */
export function retryBotJob(oldId: string, newId: string, owner: string | null): BotJob | null {
  try {
    return write((d) => {
      const old = d
        .prepare("SELECT * FROM kru_bot_jobs WHERE id = ? AND stage = 'failed' AND retry_at IS NOT NULL")
        .get(oldId) as Row | undefined;
      if (!old) return null;
      d.prepare("UPDATE kru_bot_jobs SET retry_at = NULL, updated_at = ? WHERE id = ?").run(now(), oldId);
      const job = insertBotJob(d, { id: newId, cardId: String(old.card_id), owner, runId: null });
      d.prepare("UPDATE kru_bot_jobs SET attempts = ? WHERE id = ?").run(Number(old.attempts ?? 0) + 1, newId);
      return { ...job, attempts: Number(old.attempts ?? 0) + 1 };
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return null;
    throw error;
  }
}

/** Calls off a planned retry, e.g. when the person already moved the card on. */
export function cancelBotRetry(id: string) {
  write((d) => {
    if (d.prepare("UPDATE kru_bot_jobs SET retry_at = NULL, updated_at = ? WHERE id = ?").run(now(), id).changes) {
      announce({ topic: "board" });
    }
  });
}

export function getBotJob(id: string): BotJob | null {
  const row = db().prepare("SELECT * FROM kru_bot_jobs WHERE id = ?").get(id) as Row | undefined;
  return row ? toBotJob(row) : null;
}

/** The job still working a card, if the crew has it. */
export function getActiveBotJobForCard(cardId: string): BotJob | null {
  const row = db()
    .prepare(`SELECT * FROM kru_bot_jobs WHERE card_id = ? AND stage NOT IN ${TERMINAL_STAGES} LIMIT 1`)
    .get(cardId) as Row | undefined;
  return row ? toBotJob(row) : null;
}

/** The newest job for each card that ever had one, for the board. */
export function latestBotJobByCard(): Map<string, BotJob> {
  const rows = db().prepare("SELECT * FROM kru_bot_jobs ORDER BY created_at").all() as Row[];
  const map = new Map<string, BotJob>();
  for (const row of rows) {
    const job = toBotJob(row);
    map.set(job.cardId, job);
  }
  return map;
}

/**
 * Claims an open card in Drop for the crew: one job at `build`, owned by
 * `owner`. Returns null when the card isn't there to pick up or another job
 * already has it (the partial unique index refuses a second active job).
 */
export function claimDropCard(cardId: string, owner: string | null, id: string): BotJob | null {
  try {
    return write((d) => {
      const card = d
        .prepare("SELECT status, column_id FROM kru_cards WHERE id = ?")
        .get(cardId) as Row | undefined;
      if (!card || card.status !== "open" || card.column_id !== "drop") return null;
      return insertBotJob(d, { id, cardId, owner, runId: null });
    });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return null;
    throw error;
  }
}

function insertBotJob(
  d: DatabaseSync,
  input: { id: string; cardId: string; owner: string | null; runId: string | null },
): BotJob {
  const at = now();
  d.prepare(
    `INSERT INTO kru_bot_jobs (id, card_id, stage, run_id, rounds, claimed_by, created_at, updated_at)
     VALUES (?, ?, 'build', ?, 0, ?, ?, ?)`,
  ).run(input.id, input.cardId, input.runId, input.owner, at, at);
  announce({ topic: "board" });
  return getBotJob(input.id)!;
}

/**
 * A job at `build` for a run that already exists (a revision a bot asked
 * for). Unowned, so the dispatcher's next tick drives it. Null when the
 * card already has an active job.
 */
export function createBotJobForRun(id: string, cardId: string, runId: string): BotJob | null {
  try {
    return write((d) => insertBotJob(d, { id, cardId, owner: null, runId }));
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return null;
    throw error;
  }
}

export type BotJobPatch = {
  runId?: string | null;
  rounds?: number;
  testReport?: string | null;
  reviewVerdict?: string | null;
  reviewNotes?: string | null;
  error?: string | null;
  retryAt?: string | null;
};

/**
 * Moves a job to `to` only if it is at one of `from`, applying the patch in
 * the same statement. Returns false when it was elsewhere, e.g. cancelled.
 */
export function transitionBotJob(
  id: string,
  from: BotStage[],
  to: BotStage,
  patch: BotJobPatch = {},
): boolean {
  if (from.length === 0) return false;
  return write((d) => {
    const sets: string[] = ["stage = ?", "updated_at = ?"];
    const values: (string | number | null)[] = [to, now()];
    for (const [key, column] of [
      ["runId", "run_id"],
      ["rounds", "rounds"],
      ["testReport", "test_report"],
      ["reviewVerdict", "review_verdict"],
      ["reviewNotes", "review_notes"],
      ["error", "error"],
      ["retryAt", "retry_at"],
    ] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key] ?? null);
      }
    }
    // A finished job belongs to nobody, so a resume can never find it.
    if (!isActiveStage(to)) sets.push("claimed_by = NULL");
    const placeholders = from.map(() => "?").join(", ");
    const changed =
      d
        .prepare(`UPDATE kru_bot_jobs SET ${sets.join(", ")} WHERE id = ? AND stage IN (${placeholders})`)
        .run(...values, id, ...from).changes > 0;
    if (changed) announce({ topic: "board" });
    return changed;
  });
}

/** Takes an unowned, unfinished job so one dispatcher drives it. */
export function claimBotJob(id: string, owner: string): boolean {
  return write(
    (d) =>
      d
        .prepare(
          `UPDATE kru_bot_jobs SET claimed_by = ?, updated_at = ?
           WHERE id = ? AND claimed_by IS NULL AND stage NOT IN ${TERMINAL_STAGES}`,
        )
        .run(owner, now(), id).changes > 0,
  );
}

/** Frees every job and pending message a previous process was driving. */
export function releaseBotClaims() {
  write((d) => {
    d.prepare("UPDATE kru_bot_jobs SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
    d.prepare("UPDATE kru_chat_messages SET claimed_by = NULL WHERE claimed_by IS NOT NULL").run();
  });
}

// ---------- repo instructions ----------

/** Longest standing instructions kept for one repo. */
export const MAX_REPO_INSTRUCTIONS = 8_000;

/** The person's standing instructions for a repo, or null when there are none. */
export function getRepoInstructions(repo: string | null | undefined): string | null {
  if (!repo) return null;
  const row = db().prepare("SELECT instructions FROM kru_repo_settings WHERE repo = ?").get(repo) as Row | undefined;
  return text(row?.instructions)?.trim() || null;
}

/** Saves them; empty text removes the repo's entry. */
export function setRepoInstructions(repo: string, instructions: string) {
  const clean = instructions.trim().slice(0, MAX_REPO_INSTRUCTIONS);
  write((d) => {
    if (!clean) {
      d.prepare("DELETE FROM kru_repo_settings WHERE repo = ?").run(repo);
      return;
    }
    d.prepare(
      `INSERT INTO kru_repo_settings (repo, instructions, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (repo) DO UPDATE SET instructions = excluded.instructions, updated_at = excluded.updated_at`,
    ).run(repo, clean, now());
  });
}

export function listRepoInstructions(): { repo: string; instructions: string; updatedAt: string }[] {
  const rows = db().prepare("SELECT * FROM kru_repo_settings ORDER BY repo").all() as Row[];
  return rows.map((row) => ({ repo: String(row.repo), instructions: String(row.instructions), updatedAt: String(row.updated_at) }));
}

// ---------- pull request feedback ----------

function toPrFeedback(row: Row): PrFeedback {
  return {
    id: String(row.id),
    cardId: String(row.card_id),
    runId: String(row.run_id),
    prUrl: String(row.pr_url),
    kind: String(row.kind) as PrFeedbackKind,
    author: text(row.author),
    body: String(row.body),
    path: text(row.path),
    line: integer(row.line),
    url: text(row.url),
    state: text(row.state),
    githubUpdatedAt: String(row.github_updated_at),
    seenAt: String(row.seen_at),
    handledBy: text(row.handled_by),
  };
}

/**
 * Stores what GitHub said about a pull request. An item already stored is
 * left alone, so polling the same reviews again costs nothing; only the
 * items that were new come back, which is what deserves a line in the room.
 */
export function insertPrFeedback(items: PrFeedback[]): PrFeedback[] {
  if (items.length === 0) return [];
  return write((d) => {
    const insert = d.prepare(
      `INSERT INTO kru_pr_feedback
        (id, card_id, run_id, pr_url, kind, author, body, path, line, url, state, github_updated_at, seen_at, handled_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO NOTHING`,
    );
    const fresh: PrFeedback[] = [];
    for (const item of items) {
      const result = insert.run(
        item.id,
        item.cardId,
        item.runId,
        item.prUrl,
        item.kind,
        item.author,
        item.body,
        item.path,
        item.line,
        item.url,
        item.state,
        item.githubUpdatedAt,
        item.seenAt,
        item.handledBy,
      );
      if (result.changes > 0) fresh.push(item);
    }
    if (fresh.length) announce({ topic: "board" });
    return fresh;
  });
}

/** Feedback newest first; `pending` keeps only what no run has taken yet. */
export function listPrFeedback(options: { cardId?: string; pending?: boolean; limit?: number } = {}): PrFeedback[] {
  const where: string[] = [];
  const values: (string | number)[] = [];
  if (options.cardId) {
    where.push("card_id = ?");
    values.push(options.cardId);
  }
  if (options.pending) where.push("handled_by IS NULL");
  const limit = Math.max(1, Math.min(options.limit ?? 500, 5000));
  const rows = db()
    .prepare(
      `SELECT * FROM kru_pr_feedback${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
       ORDER BY seen_at DESC, github_updated_at DESC LIMIT ?`,
    )
    .all(...values, limit) as Row[];
  return rows.map(toPrFeedback);
}

/** Marks items as taken by the run that will address them. */
export function markPrFeedbackHandled(ids: string[], runId: string) {
  if (ids.length === 0) return;
  write((d) => {
    const mark = d.prepare("UPDATE kru_pr_feedback SET handled_by = ? WHERE id = ? AND handled_by IS NULL");
    let changed = 0;
    for (const id of ids) changed += Number(mark.run(runId, id).changes);
    if (changed) announce({ topic: "board" });
  });
}

/** How many items wait on each card, for the board's badges. */
export function countPendingFeedbackByCard(): Map<string, number> {
  const rows = db()
    .prepare("SELECT card_id, COUNT(*) AS n FROM kru_pr_feedback WHERE handled_by IS NULL GROUP BY card_id")
    .all() as Row[];
  return new Map(rows.map((row) => [String(row.card_id), Number(row.n)]));
}

// ---------- chat ----------

function toChatMessage(row: Row): ChatMessage {
  return {
    id: String(row.id),
    author: String(row.author) as ChatMessage["author"],
    kind: String(row.kind) as ChatMessage["kind"],
    body: String(row.body),
    mentions: JSON.parse(String(row.mentions ?? "[]")) as BotId[],
    cardId: text(row.card_id),
    replyTo: text(row.reply_to),
    depth: Number(row.depth ?? 0),
    createdAt: String(row.created_at),
  };
}

/** A file to store with a new message: its details and its bytes. */
export type NewChatAttachment = Omit<ChatAttachment, "size"> & { data: Uint8Array };

/**
 * Adds a line to the room. `pending` marks it for a bot to answer. `files`
 * are stored with it in the same transaction, in order.
 */
export function insertChatMessage(
  message: ChatMessage,
  options: { pending?: boolean; files?: NewChatAttachment[] } = {},
) {
  write((d) => {
    d.prepare(
      `INSERT INTO kru_chat_messages
        (id, author, kind, body, mentions, card_id, reply_to, depth, answered, claimed_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      message.id,
      message.author,
      message.kind,
      message.body,
      JSON.stringify(message.mentions),
      message.cardId,
      message.replyTo,
      message.depth,
      options.pending ? 0 : 1,
      message.createdAt,
    );
    const attach = d.prepare(
      `INSERT INTO kru_chat_attachments (id, message_id, position, name, media_type, size, data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    (options.files ?? []).forEach((file, position) => {
      attach.run(file.id, message.id, position, file.name, file.mediaType, file.data.byteLength, file.data, message.createdAt);
    });
    announce({ topic: "chat" });
  });
}

/** Fills in each message's attachments (details only) with one query. */
function withAttachments(d: DatabaseSync, messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;
  const rows = d
    .prepare(
      `SELECT id, message_id, name, media_type, size FROM kru_chat_attachments
       WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY message_id, position`,
    )
    .all(JSON.stringify(messages.map((message) => message.id))) as Row[];
  const byMessage = new Map<string, ChatAttachment[]>();
  for (const row of rows) {
    const list = byMessage.get(String(row.message_id)) ?? [];
    list.push({ id: String(row.id), name: String(row.name), mediaType: String(row.media_type), size: Number(row.size) });
    byMessage.set(String(row.message_id), list);
  }
  return messages.map((message) => {
    const attachments = byMessage.get(message.id);
    return attachments ? { ...message, attachments } : message;
  });
}

/** One attachment with its bytes, or null. */
export function getChatAttachment(id: string): (ChatAttachment & { messageId: string; data: Uint8Array }) | null {
  const row = db().prepare("SELECT * FROM kru_chat_attachments WHERE id = ?").get(id) as Row | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    name: String(row.name),
    mediaType: String(row.media_type),
    size: Number(row.size),
    data: row.data as Uint8Array,
  };
}

/** Messages in order, optionally only those after a `createdAt` cursor. */
export function listChatMessages(options: { after?: string | null; limit?: number } = {}): ChatMessage[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 1000));
  const rows = (
    options.after
      ? db()
          .prepare("SELECT * FROM kru_chat_messages WHERE created_at > ? ORDER BY created_at, rowid LIMIT ?")
          .all(options.after, limit)
      : db()
          .prepare(
            "SELECT * FROM (SELECT *, rowid AS rid FROM kru_chat_messages ORDER BY created_at DESC, rowid DESC LIMIT ?) ORDER BY created_at, rid",
          )
          .all(limit)
  ) as Row[];
  return withAttachments(db(), rows.map(toChatMessage));
}

/** The last `limit` lines, oldest first, for a bot's context. */
export function recentChatMessages(limit: number): ChatMessage[] {
  return listChatMessages({ limit });
}

/** Takes up to `limit` unanswered, unowned messages for `owner` to answer. */
export function claimPendingMessages(owner: string, limit: number): ChatMessage[] {
  return write((d) => {
    const rows = d
      .prepare(
        "SELECT * FROM kru_chat_messages WHERE answered = 0 AND claimed_by IS NULL ORDER BY created_at, rowid LIMIT ?",
      )
      .all(limit) as Row[];
    const claim = d.prepare("UPDATE kru_chat_messages SET claimed_by = ? WHERE id = ?");
    for (const row of rows) claim.run(owner, String(row.id));
    return withAttachments(d, rows.map(toChatMessage));
  });
}

/** Deletes every line in the room; open rooms empty themselves. Returns how many went. */
export function clearChatMessages(): number {
  return write((d) => {
    const result = d.prepare("DELETE FROM kru_chat_messages").run();
    announce({ topic: "chat", cleared: true });
    return Number(result.changes);
  });
}

export function markChatAnswered(id: string) {
  write((d) => {
    d.prepare("UPDATE kru_chat_messages SET answered = 1, claimed_by = NULL WHERE id = ?").run(id);
  });
}

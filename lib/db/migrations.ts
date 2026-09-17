import type { DatabaseSync } from "node:sqlite";

/**
 * Kru's schema, one entry per version. Tables use a `kru_` prefix so they
 * never collide with Better Auth's. Never edit a shipped entry; add a new one.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE kru_connections (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('github', 'openai', 'anthropic', 'xai')),
    label TEXT NOT NULL,
    meta TEXT NOT NULL DEFAULT '{}',
    access_token_enc TEXT NOT NULL,
    refresh_token_enc TEXT,
    expires_at INTEGER,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_cards (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    column_id TEXT NOT NULL CHECK (column_id IN ('drop', 'run', 'review')),
    repo TEXT,
    model TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'running', 'needs_approval', 'approved', 'merged', 'error')),
    run_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE kru_runs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES kru_cards (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'needs_approval', 'applying', 'approved', 'merged', 'error', 'cancelled')),
    proposed_writes TEXT NOT NULL DEFAULT '[]',
    base_branch TEXT,
    head_branch TEXT,
    pr_url TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX kru_runs_card ON kru_runs (card_id, created_at DESC);

  CREATE TABLE kru_run_logs (
    run_id TEXT NOT NULL REFERENCES kru_runs (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    line TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (run_id, seq)
  );

  CREATE TABLE kru_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    onboarding TEXT,
    github_app_id INTEGER,
    github_app_slug TEXT,
    github_client_id TEXT,
    github_client_secret_enc TEXT,
    github_pem_enc TEXT,
    github_installation_id INTEGER,
    updated_at TEXT NOT NULL
  );
  `,
  // A run the agent didn't finish cleanly carries a warning for the reviewer.
  `ALTER TABLE kru_runs ADD COLUMN warning TEXT;`,
  // The agent's summary, and for a revision, the run it continues and the
  // reviewer's request.
  `
  ALTER TABLE kru_runs ADD COLUMN summary TEXT;
  ALTER TABLE kru_runs ADD COLUMN revision_of TEXT;
  ALTER TABLE kru_runs ADD COLUMN revision_note TEXT;
  `,
  // What GitHub last said about the pull request, and the ETag that answer
  // carried, so the board can ask again cheaply and stop asking once the
  // pull request can no longer change on its own.
  `
  ALTER TABLE kru_runs ADD COLUMN pr_state TEXT;
  ALTER TABLE kru_runs ADD COLUMN pr_etag TEXT;
  `,
  // A short-lived column: Claude Code was going to be a separate card
  // "engine", then became a model ref (`claude-code:model`) like a
  // subscription's, so the ref alone says what runs the card.
  `ALTER TABLE kru_cards ADD COLUMN engine TEXT NOT NULL DEFAULT 'connection';`,
  `ALTER TABLE kru_cards DROP COLUMN engine;`,
  // Bots: the on/off switch, which bot drove a run, the scribe's commit line,
  // one job per card pickup (the stage the crew is at and the run it is on),
  // and the Team room. A chat `author` is 'you' or a bot id; events are the
  // pipeline's own progress lines, and only messages with mentions get a reply.
  `
  ALTER TABLE kru_settings ADD COLUMN bots_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_runs ADD COLUMN bot TEXT;
  ALTER TABLE kru_runs ADD COLUMN commit_message TEXT;
  CREATE TABLE kru_bot_jobs (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES kru_cards (id) ON DELETE CASCADE,
    stage TEXT NOT NULL CHECK (stage IN ('build', 'test', 'review', 'scribe', 'done', 'failed', 'cancelled')),
    run_id TEXT,
    rounds INTEGER NOT NULL DEFAULT 0,
    test_report TEXT,
    review_verdict TEXT,
    error TEXT,
    claimed_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX kru_bot_jobs_active ON kru_bot_jobs (card_id) WHERE stage NOT IN ('done', 'failed', 'cancelled');
  CREATE INDEX kru_bot_jobs_card ON kru_bot_jobs (card_id, created_at DESC);
  CREATE TABLE kru_chat_messages (
    id TEXT PRIMARY KEY,
    author TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('message', 'event')),
    body TEXT NOT NULL,
    mentions TEXT NOT NULL DEFAULT '[]',
    card_id TEXT,
    reply_to TEXT,
    depth INTEGER NOT NULL DEFAULT 0,
    answered INTEGER NOT NULL DEFAULT 1,
    claimed_by TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX kru_chat_messages_at ON kru_chat_messages (created_at);
  CREATE INDEX kru_chat_messages_pending ON kru_chat_messages (created_at) WHERE answered = 0;
  `,
  // The model the crew chats with: an endpoint's, or Claude Code's. Null
  // means the first endpoint, else Claude Code when the CLI is signed in.
  `ALTER TABLE kru_settings ADD COLUMN bots_model TEXT;`,
  // Owning the pull request after it opens. A run keeps the PR's number and
  // the head commit it last pushed; the ETags let reviews, comments and
  // checks be polled for free while nothing changes. A follow-up run (one
  // that continues an approved run on the PR's own branch) records why it
  // started. Feedback rows are what GitHub said about a PR, one per review,
  // comment or failed check, marked handled once a follow-up run took it.
  `
  ALTER TABLE kru_settings ADD COLUMN bots_auto_push INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_settings ADD COLUMN github_missing_permissions TEXT;
  ALTER TABLE kru_runs ADD COLUMN pr_number INTEGER;
  ALTER TABLE kru_runs ADD COLUMN pr_head_sha TEXT;
  ALTER TABLE kru_runs ADD COLUMN pr_etags TEXT;
  ALTER TABLE kru_runs ADD COLUMN follow_up_reason TEXT CHECK (follow_up_reason IN ('review', 'check', 'manual') OR follow_up_reason IS NULL);
  CREATE TABLE kru_pr_feedback (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL REFERENCES kru_cards (id) ON DELETE CASCADE,
    run_id TEXT NOT NULL,
    pr_url TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('review', 'review_comment', 'issue_comment', 'check')),
    author TEXT,
    body TEXT NOT NULL,
    path TEXT,
    line INTEGER,
    url TEXT,
    state TEXT,
    github_updated_at TEXT NOT NULL,
    seen_at TEXT NOT NULL,
    handled_by TEXT
  );
  CREATE INDEX kru_pr_feedback_pending ON kru_pr_feedback (card_id) WHERE handled_by IS NULL;
  CREATE INDEX kru_pr_feedback_card ON kru_pr_feedback (card_id, seen_at DESC);
  `,
  // GitHub issues as cards. A card made from an issue remembers it, so its
  // pull request can close it and Kru can comment there. Every import is
  // recorded apart from the card, so deleting the card doesn't bring the
  // issue back on the next poll. The sync keeps a cursor per repo.
  `
  ALTER TABLE kru_settings ADD COLUMN issues_enabled INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_settings ADD COLUMN issue_label TEXT NOT NULL DEFAULT 'kru';
  ALTER TABLE kru_cards ADD COLUMN issue_number INTEGER;
  ALTER TABLE kru_cards ADD COLUMN issue_url TEXT;
  CREATE TABLE kru_issue_imports (
    issue_id INTEGER PRIMARY KEY,
    repo TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    card_id TEXT,
    imported_at TEXT NOT NULL
  );
  CREATE TABLE kru_issue_sync (
    repo TEXT PRIMARY KEY,
    since TEXT,
    etag TEXT,
    checked_at TEXT NOT NULL
  );
  `,
  // A smarter crew. A job that failed on the work itself is tried again: the
  // retry is a new job with one more attempt, and the failed job holds when
  // it is due until then. Lulu's notes are kept on the job for the card's
  // history. Standing instructions per repo reach the builder and reviewer.
  `
  ALTER TABLE kru_bot_jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE kru_bot_jobs ADD COLUMN retry_at TEXT;
  ALTER TABLE kru_bot_jobs ADD COLUMN review_notes TEXT;
  CREATE INDEX kru_bot_jobs_retry ON kru_bot_jobs (retry_at) WHERE retry_at IS NOT NULL;
  CREATE TABLE kru_repo_settings (
    repo TEXT PRIMARY KEY,
    instructions TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  `,
  // Reference files attached to a message in the Team room: images, PDFs
  // and text, kept with the message and deleted with it.
  `
  CREATE TABLE kru_chat_attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES kru_chat_messages (id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    data BLOB NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX kru_chat_attachments_message ON kru_chat_attachments (message_id, position);
  `,
];

/** Applies any migrations newer than the stored schema version, one per transaction. */
export function runKruMigrations(db: DatabaseSync) {
  db.exec("CREATE TABLE IF NOT EXISTS kru_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const row = db
    .prepare("SELECT value FROM kru_meta WHERE key = 'schema_version'")
    .get() as { value: string } | undefined;
  let version = row ? Number(row.value) : 0;

  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[version]);
      version += 1;
      db.prepare(
        "INSERT INTO kru_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      ).run(String(version));
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
  return version;
}

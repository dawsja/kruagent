export const COLUMNS = ["drop", "run", "review"] as const;
export type ColumnId = (typeof COLUMNS)[number];

/**
 * API formats that can run a card. Every model connection is an API-key
 * endpoint with a user-supplied URL and key in one of these formats.
 */
export const MODEL_PROVIDERS = ["openai", "anthropic", "xai"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/** Same list as MODEL_PROVIDERS; kept as the name the endpoint code uses. */
export const BYOK_PROVIDERS = MODEL_PROVIDERS;
export type ByokProvider = ModelProvider;

export type ConnectionProvider = "github" | ModelProvider;

/**
 * Formats that can also be connected by signing in with a consumer
 * subscription (ChatGPT, SuperGrok) instead of an API key. Anthropic is
 * absent on purpose: its terms (February 2026) forbid Claude subscription
 * OAuth in third-party tools. A Claude plan is used through Claude Code in
 * the box instead (`claude-code:model` refs): the person signs in to
 * Anthropic's own CLI there, and Kru never holds the credentials.
 */
export const SUBSCRIPTION_PROVIDERS = ["openai", "xai"] as const;
export type SubscriptionProvider = (typeof SUBSCRIPTION_PROVIDERS)[number];

export function isModelProvider(value: string): value is ModelProvider {
  return (MODEL_PROVIDERS as readonly string[]).includes(value);
}

export function isByokProvider(value: string): value is ByokProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(value);
}

export function isConnectionProvider(value: string): value is ConnectionProvider {
  return value === "github" || isModelProvider(value);
}

export function isSubscriptionProvider(value: string): value is SubscriptionProvider {
  return (SUBSCRIPTION_PROVIDERS as readonly string[]).includes(value);
}

/** One subscription per provider per install, so the id is fixed. */
export function subscriptionConnectionId(provider: SubscriptionProvider) {
  return `sub_${provider}`;
}

/** True for a connection signed in with a subscription: OAuth tokens, not a key. */
export function isSubscriptionConnection(connection: { meta?: Record<string, string> | null }) {
  return connection.meta?.auth === "oauth";
}

export type Card = {
  id: string;
  title: string;
  body: string;
  column: ColumnId;
  repo: string | null;
  /**
   * Model ref, `connectionId:modelId`, or null when no model is picked.
   * `claude-code:modelId` names no connection: the card runs on the Claude
   * Code CLI in the box, which is signed in on its own.
   */
  model: string | null;
  status:
    | "open"
    | "running"
    | "needs_approval"
    | "approved"
    | "merged"
    | "error";
  runId: string | null;
  /** For a card made from a GitHub issue: its number, in the card's repo. */
  issueNumber?: number | null;
  issueUrl?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Connection = {
  /**
   * Unique per connection. GitHub uses "github", so there is one. API-key
   * endpoints get their own id, so several can share a format, like MiniMax
   * and Claude both on the Anthropic format.
   */
  id: string;
  provider: ConnectionProvider;
  /**
   * GitHub OAuth access token, the raw API key for an endpoint, or the
   * OAuth access token of a subscription sign-in.
   */
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  label: string;
  /**
   * Public, non-secret details. API-key endpoints keep `name`, `baseUrl`, a
   * masked `keyHint`, `listedModels` from the endpoint, and an optional typed
   * `models` list. GitHub keeps `login`, `avatar` and `installationId`.
   * Subscription sign-ins keep `auth: "oauth"`, `name`, `baseUrl`,
   * `accountId`, `plan`, `email` and `listedModels`.
   */
  meta: Record<string, string>;
};

export type ProposedWrite = {
  path: string;
  /** Empty when the file is deleted. */
  content: string;
  message: string;
  /** The approved pull request removes this file. */
  deleted?: boolean;
  /** Unified diff against the base branch, for review. */
  diff?: string;
};

export type Run = {
  id: string;
  cardId: string;
  status:
    | "running"
    | "needs_approval"
    | "applying"
    | "approved"
    | "merged"
    | "error"
    | "cancelled";
  log: string[];
  proposedWrites: ProposedWrite[];
  /** Branch the pull request targets, resolved when the run starts. */
  baseBranch?: string | null;
  /**
   * Branch Kru pushes the approved changes to. Set on approve for a first
   * run; set at creation for a follow-up, which clones it and pushes to it.
   */
  headBranch?: string | null;
  prUrl: string | null;
  /** The pull request's number, once it exists. */
  prNumber?: number | null;
  /** The commit on the head branch Kru last pushed. Checks are read for it. */
  prHeadSha?: string | null;
  /**
   * What GitHub last said about the pull request. "closed" means it was
   * closed without merging, which is as final as "merged": neither is asked
   * about again.
   */
  prState?: "open" | "closed" | "merged" | null;
  /** The ETag of that answer, so the next check can be a free 304. */
  prEtag?: string | null;
  /** ETags of the last reviews, comments and checks answers, likewise. */
  prEtags?: PrEtags | null;
  /**
   * For a follow-up on an open pull request: what started it. A review, a
   * failed check, or a person asking.
   */
  followUpReason?: FollowUpReason | null;
  error: string | null;
  /** Set when the agent stopped before saying it was done; review carefully. */
  warning?: string | null;
  /** What the agent said it did, from its finish call. */
  summary?: string | null;
  /** For a revision: the run whose changes this one started from. */
  revisionOf?: string | null;
  /** For a revision: what the reviewer asked for. */
  revisionNote?: string | null;
  /** The bot that drove this run, when the crew picked the card up. */
  bot?: BotId | null;
  /** The commit subject the scribe wrote, used when the run is approved. */
  commitMessage?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type PrEtags = {
  reviews?: string | null;
  comments?: string | null;
  issueComments?: string | null;
  checks?: string | null;
};

export const FOLLOW_UP_REASONS = ["review", "check", "manual"] as const;
export type FollowUpReason = (typeof FOLLOW_UP_REASONS)[number];

export const PR_FEEDBACK_KINDS = ["review", "review_comment", "issue_comment", "check"] as const;
export type PrFeedbackKind = (typeof PR_FEEDBACK_KINDS)[number];

/**
 * One thing GitHub said about a pull request Kru opened: a review, a comment
 * on the diff or the conversation, or a check that failed. Pending until a
 * follow-up run takes it; `handledBy` is that run.
 */
export type PrFeedback = {
  /** `<kind>:<GitHub id>`, so the same item is never stored twice. */
  id: string;
  cardId: string;
  /** The run that owned the pull request when the item was seen. */
  runId: string;
  prUrl: string;
  kind: PrFeedbackKind;
  author: string | null;
  body: string;
  /** For a comment on the diff: the file and line it is about. */
  path: string | null;
  line: number | null;
  url: string | null;
  /** A review's state, or a check's conclusion. */
  state: string | null;
  githubUpdatedAt: string;
  seenAt: string;
  handledBy: string | null;
};

// ---------- bots ----------

export const BOT_IDS = ["pip", "momo", "kiko", "lulu", "bibi"] as const;
export type BotId = (typeof BOT_IDS)[number];

export function isBotId(value: string): value is BotId {
  return (BOT_IDS as readonly string[]).includes(value);
}

/**
 * Where the crew is with a card. The four working stages each belong to one
 * bot; the last three are terminal.
 */
export const BOT_STAGES = ["build", "test", "review", "scribe", "done", "failed", "cancelled"] as const;
export type BotStage = (typeof BOT_STAGES)[number];
export const ACTIVE_BOT_STAGES: readonly BotStage[] = ["build", "test", "review", "scribe"];

export function isActiveStage(stage: BotStage) {
  return ACTIVE_BOT_STAGES.includes(stage);
}

/** One pickup of a card by the crew: its stage, its run, and how it went. */
export type BotJob = {
  id: string;
  cardId: string;
  stage: BotStage;
  runId: string | null;
  /** Review rounds so far: how many times Lulu sent it back to Momo. */
  rounds: number;
  testReport: string | null;
  reviewVerdict: string | null;
  /** What Lulu said in her last review, verdict line left out. */
  reviewNotes?: string | null;
  error: string | null;
  /** Earlier tries of this card by the crew that failed and were retried. */
  attempts?: number;
  /** For a failed job the crew will try again: when. Cleared once retried. */
  retryAt?: string | null;
  /** The dispatcher driving it right now, or null when free to resume. */
  claimedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/** A line in the Team room, from you or a bot. */
export type ChatMessage = {
  id: string;
  author: "you" | BotId;
  /** An event is the crew's own progress line; only messages get a reply. */
  kind: "message" | "event";
  body: string;
  mentions: BotId[];
  cardId: string | null;
  replyTo: string | null;
  /** Bot-to-bot hops from the human message that started the thread. */
  depth: number;
  createdAt: string;
  /** Reference files sent with the message; the bytes are fetched by id. */
  attachments?: ChatAttachment[];
};

/** A file attached to a chat message, without its bytes. */
export type ChatAttachment = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
};

/** Setup state. The account itself lives in Better Auth's tables. */
export type Onboarding = {
  complete: boolean;
  model: string | null;
  repo: string | null;
};

export type GithubApp = {
  clientId: string;
  clientSecret: string;
  slug: string;
  appId: number;
  installationId?: number;
  pem?: string;
};


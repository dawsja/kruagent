import { deleteConnection, getConnection, getGithubConnection, updateTokens } from "./data";
import { getKruGithubApp } from "./github-oauth";
import { GithubReconnectError, refreshGithubTokens } from "./github-token";
import { refreshOpenAITokens, SubscriptionReconnectError } from "./openai-oauth";
import { isSubscriptionConnection, type Connection } from "./types";
import { refreshXaiTokens } from "./xai-oauth";

export { GithubReconnectError, SubscriptionReconnectError };

/** Refresh a little early so a token never expires mid-run. */
const REFRESH_EARLY_MS = 5 * 60 * 1000;

const holder = globalThis as typeof globalThis & {
  __kruTokenRefresh?: Map<string, Promise<Connection>>;
};
const inFlight = (holder.__kruTokenRefresh ??= new Map<string, Promise<Connection>>());

function isStale(connection: Connection) {
  return connection.expiresAt !== null && connection.expiresAt - REFRESH_EARLY_MS < Date.now();
}

/** GitHub sign-ins and subscription sign-ins expire; API keys don't. */
function canExpire(connection: Connection) {
  return connection.provider === "github" || isSubscriptionConnection(connection);
}

function reconnectError(connection: Connection, message?: string) {
  return connection.provider === "github"
    ? new GithubReconnectError(message)
    : new SubscriptionReconnectError(message);
}

function isReconnectError(error: unknown) {
  return error instanceof GithubReconnectError || error instanceof SubscriptionReconnectError;
}

async function renew(stored: Connection) {
  if (stored.provider === "github") {
    const app = await getKruGithubApp();
    if (!app) throw new GithubReconnectError("Create your GitHub App in setup first.");
    return refreshGithubTokens({
      refreshToken: stored.refreshToken!,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
    });
  }
  if (stored.provider === "openai") return refreshOpenAITokens({ refreshToken: stored.refreshToken! });
  if (stored.provider === "xai") return refreshXaiTokens({ refreshToken: stored.refreshToken! });
  throw new Error("This connection can't be refreshed");
}

/**
 * Returns a connection whose token is usable. API-key endpoints never
 * expire. A GitHub or subscription token close to expiry (or, with `force`,
 * one a server just rejected) is refreshed once, even when several requests
 * ask at the same moment, because a refresh token may work only once. A
 * dead refresh token removes the connection so the UI asks to sign in again.
 */
export async function ensureFreshConnection(
  connection: Connection,
  options: { force?: boolean } = {},
): Promise<Connection> {
  if (!canExpire(connection)) return connection;
  if (!options.force && !isStale(connection)) return connection;

  const running = inFlight.get(connection.id);
  if (running) return running;

  const task = (async () => {
    // Another request may have refreshed it already; use the saved copy.
    const stored = getConnection(connection.id);
    if (!stored) throw reconnectError(connection, connection.provider === "github" ? "Connect GitHub in Settings." : undefined);
    if (!options.force && !isStale(stored)) return stored;
    if (!stored.refreshToken) {
      deleteConnection(stored.id);
      throw reconnectError(stored);
    }
    try {
      const tokens = await renew(stored);
      const refreshToken = tokens.refreshToken ?? stored.refreshToken;
      updateTokens(stored.id, tokens.accessToken, refreshToken, tokens.expiresAt);
      return { ...stored, accessToken: tokens.accessToken, refreshToken, expiresAt: tokens.expiresAt };
    } catch (error) {
      if (isReconnectError(error)) deleteConnection(stored.id);
      throw error;
    }
  })();

  inFlight.set(connection.id, task);
  try {
    return await task;
  } finally {
    inFlight.delete(connection.id);
  }
}

/** The GitHub connection with a usable token, or null when GitHub isn't connected. */
export async function getFreshGithubConnection(): Promise<Connection | null> {
  const github = getGithubConnection();
  return github ? ensureFreshConnection(github) : null;
}

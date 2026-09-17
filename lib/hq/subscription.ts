/**
 * Subscription sign-ins: starting a browser or device-code login, driving
 * it to a saved connection, and reporting progress to the tab that started
 * it. One subscription per provider per install; the connection id is fixed
 * (`sub_openai`, `sub_xai`) and API-key endpoints of the same format stay.
 */
import { pickListedModels, rowsToModels, type ModelRow } from "./byok";
import { deleteConnection, getConnection, upsertConnection } from "./data";
import { XAI_MODEL_ORDER } from "./models";
import { pkceChallenge, pkceVerifier, safeNext } from "./oauth";
import {
  exchangeOpenAICode,
  listCodexModels,
  openaiAuthorizeUrl,
  openaiConnectionFromTokens,
  OPENAI_OAUTH_CALLBACK_PORT,
  parseOpenAIIdToken,
  pollOpenAIDeviceCode,
  requestOpenAIDeviceCode,
  type OAuthTokens,
} from "./openai-oauth";
import {
  createPendingLogin,
  finishPendingLogin,
  getPendingLogin,
  PENDING_LOGIN_TTL_MS,
  takeLoginByState,
  type PendingLogin,
} from "./pending-logins";
import { noRedirectFetch } from "./safe-fetch";
import { subscriptionConnectionId, type Connection, type SubscriptionProvider } from "./types";
import {
  pollXaiDeviceCode,
  requestXaiDeviceCode,
  XAI_OAUTH_BASE_URL,
  xaiConnectionFromTokens,
} from "./xai-oauth";

export type LoginStatus = {
  status: "pending" | "done" | "error";
  provider?: SubscriptionProvider;
  error?: string;
  /** The saved connection's id once done. */
  connectionId?: string;
};

/** The models an X sign-in can run, from api.x.ai when it answers. */
async function listXaiModels(accessToken: string): Promise<string[]> {
  try {
    const res = await noRedirectFetch(`${XAI_OAUTH_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [...XAI_MODEL_ORDER];
    const data = (await res.json()) as { data?: ModelRow[]; models?: ModelRow[] };
    const rows = data.data ?? data.models;
    if (!Array.isArray(rows)) return [...XAI_MODEL_ORDER];
    const listed = pickListedModels("xai", XAI_OAUTH_BASE_URL, rowsToModels(rows));
    return listed.length ? listed : [...XAI_MODEL_ORDER];
  } catch {
    return [...XAI_MODEL_ORDER];
  }
}

async function saveSubscription(provider: SubscriptionProvider, tokens: OAuthTokens): Promise<Connection> {
  let connection: Connection;
  if (provider === "openai") {
    const identity = parseOpenAIIdToken(tokens.idToken);
    if (!identity.accountId) {
      throw new Error("This OpenAI account has no ChatGPT plan Kru can use. Sign in with the account that has the plan.");
    }
    const models = await listCodexModels({ accessToken: tokens.accessToken, accountId: identity.accountId });
    connection = openaiConnectionFromTokens(tokens, identity, models);
  } else {
    connection = xaiConnectionFromTokens(tokens, await listXaiModels(tokens.accessToken));
  }
  upsertConnection(connection);
  return connection;
}

/** Starts a browser sign-in (ChatGPT only): the address to open, and a login to poll. */
export function startBrowserLogin(provider: SubscriptionProvider, next: string | null | undefined) {
  if (provider !== "openai") throw new Error("Only ChatGPT supports the browser sign-in; use a code for X.");
  const verifier = pkceVerifier();
  const login = createPendingLogin({ provider, kind: "browser", next: safeNext(next, "/app/settings"), verifier });
  return {
    loginId: login.id,
    url: openaiAuthorizeUrl({ state: login.state, challenge: pkceChallenge(verifier) }),
    callbackPort: OPENAI_OAUTH_CALLBACK_PORT,
  };
}

/** Starts a device-code sign-in: a code to type at the vendor, and a login to poll. */
export async function startDeviceLogin(provider: SubscriptionProvider, next: string | null | undefined) {
  const device =
    provider === "openai"
      ? await requestOpenAIDeviceCode().then((code) => ({ ...code, deviceCode: code.deviceAuthId }))
      : await requestXaiDeviceCode();
  const login = createPendingLogin({
    provider,
    kind: "device",
    next: safeNext(next, "/app/settings"),
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUrl: device.verificationUrl,
    intervalMs: device.intervalMs,
  });
  return {
    loginId: login.id,
    userCode: device.userCode,
    verificationUrl: device.verificationUrl,
    intervalMs: device.intervalMs,
  };
}

async function pollDeviceOnce(login: PendingLogin) {
  login.lastPollAt = Date.now();
  try {
    if (login.provider === "openai") {
      const result = await pollOpenAIDeviceCode({ deviceAuthId: login.deviceCode!, userCode: login.userCode! });
      if (result.status === "done") {
        await saveSubscription("openai", result.tokens);
        finishPendingLogin(login.id, { status: "done" });
      }
      return;
    }
    const result = await pollXaiDeviceCode({ deviceCode: login.deviceCode! });
    if (result.status === "slow_down") {
      login.intervalMs = (login.intervalMs ?? 5000) + 5000;
    } else if (result.status === "done") {
      await saveSubscription("xai", result.tokens);
      finishPendingLogin(login.id, { status: "done" });
    }
  } catch (reason) {
    finishPendingLogin(login.id, {
      status: "error",
      error: reason instanceof Error ? reason.message : "The sign-in failed",
    });
  }
}

/**
 * Where a login stands. For a device-code login this is also what asks the
 * vendor, once per interval, so nothing polls while no tab is watching.
 */
export async function loginStatus(loginId: string): Promise<LoginStatus> {
  const login = getPendingLogin(loginId);
  if (!login) return { status: "error", error: "The sign-in expired. Start again." };
  if (login.kind === "device" && login.status === "pending") {
    if (Date.now() - login.createdAt > PENDING_LOGIN_TTL_MS - 60_000) {
      finishPendingLogin(login.id, { status: "error", error: "The sign-in code expired. Start again." });
    } else if (login.polling) {
      await login.polling;
    } else if (Date.now() - (login.lastPollAt ?? 0) >= (login.intervalMs ?? 5000)) {
      login.polling = pollDeviceOnce(login).finally(() => {
        login.polling = undefined;
      });
      await login.polling;
    }
  }
  const connectionId = subscriptionConnectionId(login.provider);
  return {
    status: login.status,
    provider: login.provider,
    ...(login.status === "error" ? { error: login.error } : {}),
    ...(login.status === "done" ? { connectionId } : {}),
  };
}

/**
 * Finishes a browser sign-in from the callback's `code` and `state`. The
 * state must match a pending login started from this Kru; that, not a
 * cookie, is what proves the callback belongs here.
 */
export async function completeBrowserLogin(params: {
  code: string | null;
  state: string | null;
  error?: string | null;
}): Promise<{ ok: true; next: string; connectionId: string } | { ok: false; next: string; error: string }> {
  const login = params.state ? takeLoginByState(params.state) : null;
  const next = login?.next ?? "/app/settings";
  if (!login) return { ok: false, next, error: "This sign-in link is stale. Start again from Settings." };
  if (params.error || !params.code) {
    const error = params.error === "access_denied" ? "The sign-in was declined." : "OpenAI didn't return a sign-in code.";
    finishPendingLogin(login.id, { status: "error", error });
    return { ok: false, next, error };
  }
  try {
    const tokens = await exchangeOpenAICode({ code: params.code, verifier: login.verifier });
    const saved = await saveSubscription(login.provider, tokens);
    finishPendingLogin(login.id, { status: "done" });
    return { ok: true, next, connectionId: saved.id };
  } catch (reason) {
    const error = reason instanceof Error ? reason.message : "The sign-in failed";
    finishPendingLogin(login.id, { status: "error", error });
    return { ok: false, next, error };
  }
}

/**
 * The last resort when port 1455 can't reach Kru: the person pastes the
 * address the browser ended on. Only the fixed callback address is accepted.
 */
export async function completePastedUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("Paste the full address, starting with http://localhost:1455/");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (!loopback || url.port !== String(OPENAI_OAUTH_CALLBACK_PORT) || url.pathname !== "/auth/callback") {
    throw new Error("That isn't the sign-in address. It starts with http://localhost:1455/auth/callback");
  }
  const result = await completeBrowserLogin({
    code: url.searchParams.get("code"),
    state: url.searchParams.get("state"),
    error: url.searchParams.get("error"),
  });
  if (!result.ok) throw new Error(result.error);
  return getConnection(result.connectionId);
}

export function removeSubscription(provider: SubscriptionProvider) {
  return deleteConnection(subscriptionConnectionId(provider));
}

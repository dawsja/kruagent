/**
 * Sign in with ChatGPT: the OAuth flow Codex CLI uses, so a ChatGPT Plus,
 * Pro, Business or Enterprise plan can run models through the Codex backend
 * instead of an API key. The client id is Codex CLI's public PKCE client;
 * OpenAI registers its redirect at http://localhost:1455/auth/callback and
 * that address cannot be changed, which is why Kru also answers on port 1455.
 *
 * Endpoints, parameters and error handling follow the reference
 * implementation in openai/codex, codex-rs/login/src (server.rs for the
 * browser flow, device_code_auth.rs for device codes, auth/manager.rs for
 * refreshes). Kru identifies itself honestly as `kru`; it never pretends to
 * be Codex CLI. Kept free of app imports so it can be tested with a fake
 * `fetch`.
 */
import type { Connection } from "./types";

export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
/** Fixed by OpenAI's registration of the client; Kru must answer here. */
export const OPENAI_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback";
export const OPENAI_OAUTH_CALLBACK_PORT = 1455;
export const OPENAI_OAUTH_SCOPE = "openid profile email offline_access";
export const OPENAI_AUTHORIZE_URL = `${OPENAI_OAUTH_ISSUER}/oauth/authorize`;
export const OPENAI_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`;
export const OPENAI_DEVICE_CODE_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
export const OPENAI_DEVICE_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
/** Where the person types the device code. */
export const OPENAI_DEVICE_VERIFY_URL = `${OPENAI_OAUTH_ISSUER}/codex/device`;
/** The redirect a device-code authorization is exchanged against. */
const OPENAI_DEVICE_REDIRECT_URI = `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`;
/** The Responses API a ChatGPT sign-in talks to. */
export const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
/** How Kru names itself to OpenAI, in the authorize URL and on every request. */
export const KRU_ORIGINATOR = "kru";

/**
 * Models a ChatGPT plan can run through the Codex backend, used when the
 * backend's own list can't be read. Newest first.
 */
export const CODEX_SUBSCRIPTION_MODELS: readonly string[] = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.4-mini",
  "gpt-5.2-codex",
];

export type OAuthTokens = {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number | null;
};

/** The saved subscription sign-in can't be renewed; the person must sign in again. */
export class SubscriptionReconnectError extends Error {
  constructor(message = "The subscription sign-in expired. Sign in again in Settings.") {
    super(message);
    this.name = "SubscriptionReconnectError";
  }
}

export function openaiAuthorizeUrl(input: { state: string; challenge: string }) {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: OPENAI_OAUTH_REDIRECT_URI,
    scope: OPENAI_OAUTH_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    state: input.state,
    // As Codex CLI sends them: the id token names the account's workspaces
    // and the consent page is the short one.
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: KRU_ORIGINATOR,
  });
  return `${OPENAI_AUTHORIZE_URL}?${params}`;
}

/** Decodes a JWT's payload without checking its signature. */
export function jwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The `exp` claim of a JWT in milliseconds, or null. */
export function jwtExpiry(token: string | null | undefined): number | null {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

export type OpenAIIdentity = {
  email: string | null;
  accountId: string | null;
  plan: string | null;
};

/**
 * Who signed in, from the id token the token endpoint returned over TLS
 * (so its signature isn't checked here). The ChatGPT account id and plan
 * live under the `https://api.openai.com/auth` claim, as in Codex CLI's
 * token_data.rs.
 */
export function parseOpenAIIdToken(idToken: string | null | undefined): OpenAIIdentity {
  const claims = jwtPayload(idToken);
  const auth = (claims?.["https://api.openai.com/auth"] ?? {}) as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === "string" && value ? value : null);
  return {
    email: text(claims?.email),
    accountId: text(auth.chatgpt_account_id),
    plan: text(auth.chatgpt_plan_type),
  };
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string | { code?: string; message?: string };
  error_description?: string;
};

function errorCode(data: TokenResponse) {
  return typeof data.error === "string" ? data.error : data.error?.code;
}

function toTokens(data: TokenResponse, previous?: { refreshToken: string | null }): OAuthTokens {
  if (!data.access_token) throw new Error("OpenAI returned no access token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
    idToken: data.id_token ?? null,
    expiresAt:
      jwtExpiry(data.access_token) ??
      (data.expires_in ? Date.now() + data.expires_in * 1000 : null),
  };
}

/** Exchanges the code the browser (or device flow) came back with. */
export async function exchangeOpenAICode(
  input: { code: string; verifier: string; redirectUri?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri ?? OPENAI_OAUTH_REDIRECT_URI,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: input.verifier,
    }),
  });
  let data: TokenResponse;
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    throw new Error(`OpenAI token exchange failed (${res.status})`);
  }
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? errorCode(data) ?? `OpenAI token exchange failed (${res.status})`);
  }
  return toTokens(data);
}

/**
 * Renews the access token. As in Codex CLI, the request is JSON, and a 401
 * or a 400 with `invalid_grant` means the refresh token is dead.
 */
export async function refreshOpenAITokens(
  input: { refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: OPENAI_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    /* handled below */
  }
  const code = errorCode(data);
  if (res.status === 401 || (res.status === 400 && code === "invalid_grant")) {
    throw new SubscriptionReconnectError("ChatGPT sign-in expired. Sign in again in Settings.");
  }
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? code ?? `ChatGPT token refresh failed (${res.status})`);
  }
  return toTokens(data, input);
}

export type OpenAIDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
};

/** Starts the device-code flow (the person must allow it in ChatGPT's security settings). */
export async function requestOpenAIDeviceCode(fetchImpl: typeof fetch = fetch): Promise<OpenAIDeviceCode> {
  const res = await fetchImpl(OPENAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: OPENAI_OAUTH_CLIENT_ID }),
  });
  let data: { device_auth_id?: string; user_code?: string; usercode?: string; interval?: number | string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* handled below */
  }
  const userCode = data.user_code ?? data.usercode;
  if (!res.ok || !data.device_auth_id || !userCode) {
    throw new Error(
      res.status === 403 || res.status === 404
        ? "Device code sign-in is off for this ChatGPT account. Turn on “Allow device code login” in ChatGPT's security settings, then try again."
        : `Could not start the ChatGPT device code sign-in (${res.status})`,
    );
  }
  const interval = Number(data.interval) || 5;
  return {
    deviceAuthId: data.device_auth_id,
    userCode,
    verificationUrl: OPENAI_DEVICE_VERIFY_URL,
    intervalMs: Math.max(1, interval) * 1000,
  };
}

export type DevicePoll =
  | { status: "pending" }
  | { status: "done"; tokens: OAuthTokens };

/**
 * One poll of the device-code flow. OpenAI answers 403 or 404 while the
 * code is still unused; on approval it returns an authorization code with
 * the verifier Kru then exchanges, like Codex CLI does.
 */
export async function pollOpenAIDeviceCode(
  input: { deviceAuthId: string; userCode: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DevicePoll> {
  const res = await fetchImpl(OPENAI_DEVICE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ device_auth_id: input.deviceAuthId, user_code: input.userCode }),
  });
  if (res.status === 403 || res.status === 404) return { status: "pending" };
  let data: { authorization_code?: string; code_verifier?: string } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* handled below */
  }
  if (!res.ok || !data.authorization_code || !data.code_verifier) {
    throw new Error(`The ChatGPT device code sign-in failed (${res.status})`);
  }
  const tokens = await exchangeOpenAICode(
    { code: data.authorization_code, verifier: data.code_verifier, redirectUri: OPENAI_DEVICE_REDIRECT_URI },
    fetchImpl,
  );
  return { status: "done", tokens };
}

/** Headers every request to the Codex backend carries besides the bearer token. */
export function codexHeaders(accountId: string): Record<string, string> {
  return {
    "chatgpt-account-id": accountId,
    originator: KRU_ORIGINATOR,
    "OpenAI-Beta": "responses=experimental",
  };
}

/**
 * The models this ChatGPT account can run, from the Codex backend when it
 * answers, else Kru's static list.
 */
export async function listCodexModels(
  input: { accessToken: string; accountId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  try {
    const res = await fetchImpl(`${CODEX_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${input.accessToken}`, ...codexHeaders(input.accountId) },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return [...CODEX_SUBSCRIPTION_MODELS];
    type Row = { id?: string; slug?: string };
    const data = (await res.json()) as { data?: Row[]; models?: Row[] };
    const rows = data.models ?? data.data ?? [];
    const ids = rows
      .map((row) => (row.id ?? row.slug ?? "").trim())
      .filter((id) => /^gpt-|^o[0-9]|^codex/.test(id));
    return ids.length ? [...new Set(ids)] : [...CODEX_SUBSCRIPTION_MODELS];
  } catch {
    return [...CODEX_SUBSCRIPTION_MODELS];
  }
}

/** The connection row for a ChatGPT sign-in. */
export function openaiConnectionFromTokens(
  tokens: OAuthTokens,
  identity: OpenAIIdentity,
  models: readonly string[],
): Connection {
  if (!identity.accountId) {
    throw new Error("This OpenAI account has no ChatGPT plan Kru can use.");
  }
  const plan = identity.plan ? identity.plan.replace(/^\w/, (c) => c.toUpperCase()) : null;
  return {
    id: "sub_openai",
    provider: "openai",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    label: ["ChatGPT", plan, identity.email].filter(Boolean).join(" · "),
    meta: {
      auth: "oauth",
      name: "ChatGPT",
      baseUrl: CODEX_BASE_URL,
      accountId: identity.accountId,
      ...(plan ? { plan } : {}),
      ...(identity.email ? { email: identity.email } : {}),
      listedModels: models.join(","),
    },
  };
}

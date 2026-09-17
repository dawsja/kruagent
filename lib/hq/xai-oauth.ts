/**
 * Sign in with X: xAI's OAuth for SuperGrok and X Premium subscribers, a
 * device-code flow against auth.x.ai with xAI's shared public client (the
 * consent page names it "Grok Build"). The access token is then a plain
 * bearer token for api.x.ai, and xAI decides which accounts get one.
 *
 * Endpoints and the client id match the reference implementation in
 * NousResearch/hermes-agent (hermes_cli/auth_xai.py, auth_constants.py) and
 * auth.x.ai's OpenID discovery document. Kept free of app imports so it can
 * be tested with a fake `fetch`.
 */
import { SubscriptionReconnectError, jwtExpiry, jwtPayload, type DevicePoll, type OAuthTokens } from "./openai-oauth.ts";
import type { Connection } from "./types";

export const XAI_OAUTH_ISSUER = "https://auth.x.ai";
export const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
export const XAI_TOKEN_URL = `${XAI_OAUTH_ISSUER}/oauth2/token`;
/** The API a SuperGrok sign-in talks to; the same one an API key uses. */
export const XAI_OAUTH_BASE_URL = "https://api.x.ai/v1";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const FORM = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };

export type XaiDeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  expiresAt: number;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
};

function toTokens(data: TokenResponse, previous?: { refreshToken: string | null }): OAuthTokens {
  if (!data.access_token) throw new Error("xAI returned no access token");
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? previous?.refreshToken ?? null,
    idToken: data.id_token ?? null,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : jwtExpiry(data.access_token),
  };
}

/** Starts the device-code flow: a code to type at the verification address. */
export async function requestXaiDeviceCode(fetchImpl: typeof fetch = fetch): Promise<XaiDeviceCode> {
  const res = await fetchImpl(XAI_DEVICE_CODE_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
  });
  let data: {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    verification_uri_complete?: string;
    expires_in?: number;
    interval?: number;
    error_description?: string;
    error?: string;
  } = {};
  try {
    data = (await res.json()) as typeof data;
  } catch {
    /* handled below */
  }
  if (!res.ok || !data.device_code || !data.user_code || !data.verification_uri) {
    throw new Error(data.error_description ?? data.error ?? `Could not start the xAI sign-in (${res.status})`);
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUrl: data.verification_uri_complete || data.verification_uri,
    intervalMs: Math.max(1, Number(data.interval) || 5) * 1000,
    expiresAt: Date.now() + (Number(data.expires_in) || 600) * 1000,
  };
}

/**
 * One poll of the device-code flow (RFC 8628): pending until the person
 * approves, `slow_down` asks for a longer interval, and anything else is
 * final.
 */
export async function pollXaiDeviceCode(
  input: { deviceCode: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DevicePoll | { status: "slow_down" }> {
  const res = await fetchImpl(XAI_TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: DEVICE_GRANT,
      client_id: XAI_OAUTH_CLIENT_ID,
      device_code: input.deviceCode,
    }),
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    throw new Error(`The xAI sign-in failed (${res.status})`);
  }
  if (res.ok && data.access_token) return { status: "done", tokens: toTokens(data) };
  if (data.error === "authorization_pending") return { status: "pending" };
  if (data.error === "slow_down") return { status: "slow_down" };
  if (data.error === "expired_token") throw new Error("The xAI sign-in code expired. Start again.");
  if (data.error === "access_denied") throw new Error("The xAI sign-in was declined.");
  throw new Error(data.error_description ?? data.error ?? `The xAI sign-in failed (${res.status})`);
}

/**
 * Renews the access token. A 403 is xAI's tier gate: the account is signed
 * in but not allowed API access through OAuth, so signing in again won't
 * help.
 */
export async function refreshXaiTokens(
  input: { refreshToken: string },
  fetchImpl: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const res = await fetchImpl(XAI_TOKEN_URL, {
    method: "POST",
    headers: FORM,
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: input.refreshToken,
    }),
  });
  let data: TokenResponse = {};
  try {
    data = (await res.json()) as TokenResponse;
  } catch {
    /* handled below */
  }
  if (res.status === 401 || (res.status === 400 && data.error === "invalid_grant")) {
    throw new SubscriptionReconnectError("X sign-in expired. Sign in again in Settings.");
  }
  if (res.status === 403) {
    throw new Error(
      "xAI refused this account: the subscription isn't allowed API access through sign-in. Use an xAI API key instead.",
    );
  }
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? `xAI token refresh failed (${res.status})`);
  }
  return toTokens(data, input);
}

/** The connection row for an X sign-in. */
export function xaiConnectionFromTokens(tokens: OAuthTokens, models: readonly string[]): Connection {
  const claims = jwtPayload(tokens.idToken);
  const email = typeof claims?.email === "string" ? claims.email : null;
  return {
    id: "sub_xai",
    provider: "xai",
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    label: ["SuperGrok", email].filter(Boolean).join(" · "),
    meta: {
      auth: "oauth",
      name: "SuperGrok",
      baseUrl: XAI_OAUTH_BASE_URL,
      ...(email ? { email } : {}),
      listedModels: models.join(","),
    },
  };
}

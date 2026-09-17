/**
 * Refreshes a GitHub App user access token. GitHub's user tokens last 8
 * hours and each refresh token works once. Kept free of app imports so it can
 * be tested with a fake `fetch`.
 */

export type GithubTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
};

/** The saved GitHub sign-in can't be renewed; the user must reconnect. */
export class GithubReconnectError extends Error {
  constructor(message = "GitHub sign-in expired. Reconnect GitHub in Settings.") {
    super(message);
    this.name = "GithubReconnectError";
  }
}

export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";

export async function refreshGithubTokens(
  input: { refreshToken: string; clientId: string; clientSecret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<GithubTokens> {
  const res = await fetchImpl(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });

  let data: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`GitHub token refresh failed (${res.status})`);
  }

  // GitHub answers 200 with an error field when the refresh token is spent or expired.
  if (data.error === "bad_refresh_token") throw new GithubReconnectError();
  if (data.error) throw new Error(`GitHub token refresh failed: ${data.error}`);
  if (!res.ok || !data.access_token) {
    throw new Error(`GitHub token refresh failed (${res.status})`);
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  };
}

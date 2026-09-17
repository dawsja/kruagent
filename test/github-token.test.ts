import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GITHUB_TOKEN_URL,
  GithubReconnectError,
  refreshGithubTokens,
} from "../lib/hq/github-token.ts";

const input = { refreshToken: "ghr_old", clientId: "Iv1.client", clientSecret: "secret" };

function fakeFetch(status: number, body: unknown, seen?: { url?: string; body?: string }) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.body = String(init?.body);
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("sends a refresh_token grant and maps the new tokens", async () => {
  const seen: { url?: string; body?: string } = {};
  const before = Date.now();
  const tokens = await refreshGithubTokens(
    input,
    fakeFetch(200, { access_token: "ghu_new", refresh_token: "ghr_new", expires_in: 28800 }, seen),
  );
  assert.equal(seen.url, GITHUB_TOKEN_URL);
  const params = new URLSearchParams(seen.body);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "ghr_old");
  assert.equal(params.get("client_id"), "Iv1.client");
  assert.equal(params.get("client_secret"), "secret");
  assert.equal(tokens.accessToken, "ghu_new");
  assert.equal(tokens.refreshToken, "ghr_new");
  assert.ok(tokens.expiresAt! >= before + 28800 * 1000);
});

test("a spent refresh token asks the user to reconnect", async () => {
  await assert.rejects(
    refreshGithubTokens(input, fakeFetch(200, { error: "bad_refresh_token" })),
    GithubReconnectError,
  );
});

test("other failures are errors but not reconnects", async () => {
  await assert.rejects(refreshGithubTokens(input, fakeFetch(200, { error: "incorrect_client_credentials" })), (error) => {
    assert.ok(!(error instanceof GithubReconnectError));
    return true;
  });
  await assert.rejects(refreshGithubTokens(input, fakeFetch(502, "<html>bad gateway</html>")), (error) => {
    assert.ok(!(error instanceof GithubReconnectError));
    return true;
  });
});

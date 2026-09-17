import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODEX_SUBSCRIPTION_MODELS,
  exchangeOpenAICode,
  jwtExpiry,
  listCodexModels,
  openaiAuthorizeUrl,
  openaiConnectionFromTokens,
  OPENAI_DEVICE_CODE_URL,
  OPENAI_DEVICE_TOKEN_URL,
  OPENAI_OAUTH_CLIENT_ID,
  OPENAI_OAUTH_REDIRECT_URI,
  OPENAI_TOKEN_URL,
  parseOpenAIIdToken,
  pollOpenAIDeviceCode,
  refreshOpenAITokens,
  requestOpenAIDeviceCode,
  SubscriptionReconnectError,
} from "../lib/hq/openai-oauth.ts";

type Seen = { url?: string; body?: string; headers?: Headers };

function fakeFetch(status: number, body: unknown, seen?: Seen) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.body = String(init?.body);
      seen.headers = new Headers(init?.headers);
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

/** A JWT-shaped string with the given payload; the signature is not checked. */
function fakeJwt(payload: Record<string, unknown>) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.signature`;
}

const exp = Math.floor(Date.now() / 1000) + 3600;
const idToken = fakeJwt({
  email: "dev@example.com",
  "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "plus" },
});
const accessToken = fakeJwt({ exp, "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } });

test("the authorize URL is a PKCE request to OpenAI's fixed redirect, signed as kru", () => {
  const url = new URL(openaiAuthorizeUrl({ state: "st4te", challenge: "ch4llenge" }));
  assert.equal(url.origin + url.pathname, "https://auth.openai.com/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), OPENAI_OAUTH_CLIENT_ID);
  assert.equal(url.searchParams.get("redirect_uri"), OPENAI_OAUTH_REDIRECT_URI);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), "ch4llenge");
  assert.equal(url.searchParams.get("state"), "st4te");
  assert.equal(url.searchParams.get("originator"), "kru");
  assert.ok(url.searchParams.get("scope")?.includes("offline_access"));
});

test("the id token names the ChatGPT account, plan and email", () => {
  assert.deepEqual(parseOpenAIIdToken(idToken), { email: "dev@example.com", accountId: "acct_123", plan: "plus" });
  assert.deepEqual(parseOpenAIIdToken("not-a-jwt"), { email: null, accountId: null, plan: null });
  assert.equal(jwtExpiry(accessToken), exp * 1000);
  assert.equal(jwtExpiry("x.y"), null);
});

test("the code exchange is form-encoded with the verifier and maps the tokens", async () => {
  const seen: Seen = {};
  const tokens = await exchangeOpenAICode(
    { code: "c0de", verifier: "v3rifier" },
    fakeFetch(200, { access_token: accessToken, refresh_token: "rt_1", id_token: idToken }, seen),
  );
  assert.equal(seen.url, OPENAI_TOKEN_URL);
  const params = new URLSearchParams(seen.body);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "c0de");
  assert.equal(params.get("code_verifier"), "v3rifier");
  assert.equal(params.get("redirect_uri"), OPENAI_OAUTH_REDIRECT_URI);
  assert.equal(params.get("client_id"), OPENAI_OAUTH_CLIENT_ID);
  assert.equal(tokens.accessToken, accessToken);
  assert.equal(tokens.refreshToken, "rt_1");
  assert.equal(tokens.idToken, idToken);
  assert.equal(tokens.expiresAt, exp * 1000);
});

test("a failed exchange reports OpenAI's message", async () => {
  await assert.rejects(
    exchangeOpenAICode({ code: "c", verifier: "v" }, fakeFetch(400, { error: "invalid_grant", error_description: "Code expired" })),
    /Code expired/,
  );
});

test("the refresh is JSON, keeps the old refresh token when none is returned, and knows a dead one", async () => {
  const seen: Seen = {};
  const tokens = await refreshOpenAITokens(
    { refreshToken: "rt_old" },
    fakeFetch(200, { access_token: accessToken }, seen),
  );
  assert.equal(seen.url, OPENAI_TOKEN_URL);
  assert.equal(seen.headers?.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(seen.body ?? "{}"), {
    client_id: OPENAI_OAUTH_CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: "rt_old",
  });
  assert.equal(tokens.refreshToken, "rt_old");
  assert.equal(tokens.expiresAt, exp * 1000);

  await assert.rejects(refreshOpenAITokens({ refreshToken: "x" }, fakeFetch(400, { error: "invalid_grant" })), SubscriptionReconnectError);
  await assert.rejects(refreshOpenAITokens({ refreshToken: "x" }, fakeFetch(401, "")), SubscriptionReconnectError);
  await assert.rejects(refreshOpenAITokens({ refreshToken: "x" }, fakeFetch(502, "<html>")), (error) => {
    assert.ok(!(error instanceof SubscriptionReconnectError));
    return true;
  });
});

test("the device flow asks for a code, waits on 403/404, then exchanges the returned code", async () => {
  const seen: Seen = {};
  const device = await requestOpenAIDeviceCode(
    fakeFetch(200, { device_auth_id: "dev_1", user_code: "ABCD-1234", interval: "3" }, seen),
  );
  assert.equal(seen.url, OPENAI_DEVICE_CODE_URL);
  assert.deepEqual(JSON.parse(seen.body ?? "{}"), { client_id: OPENAI_OAUTH_CLIENT_ID });
  assert.equal(device.userCode, "ABCD-1234");
  assert.equal(device.intervalMs, 3000);
  assert.match(device.verificationUrl, /^https:\/\/auth\.openai\.com\//);

  await assert.rejects(requestOpenAIDeviceCode(fakeFetch(403, "")), /Allow device code login/);

  assert.deepEqual(await pollOpenAIDeviceCode({ deviceAuthId: "dev_1", userCode: "ABCD-1234" }, fakeFetch(403, "")), {
    status: "pending",
  });

  // Approval returns a code and verifier; the token endpoint is called next.
  const calls: string[] = [];
  const sequenced = (async (url: string | URL | Request) => {
    calls.push(String(url));
    if (String(url) === OPENAI_DEVICE_TOKEN_URL) {
      return new Response(JSON.stringify({ authorization_code: "ac", code_verifier: "cv" }), { status: 200 });
    }
    return new Response(JSON.stringify({ access_token: accessToken, refresh_token: "rt", id_token: idToken }), {
      status: 200,
    });
  }) as typeof fetch;
  const result = await pollOpenAIDeviceCode({ deviceAuthId: "dev_1", userCode: "ABCD-1234" }, sequenced);
  assert.equal(result.status, "done");
  assert.deepEqual(calls, [OPENAI_DEVICE_TOKEN_URL, OPENAI_TOKEN_URL]);
});

test("the model list comes from the backend when it answers, else the static list", async () => {
  const seen: Seen = {};
  const listed = await listCodexModels(
    { accessToken: "tok", accountId: "acct_123" },
    fakeFetch(200, { models: [{ slug: "gpt-5.4" }, { slug: "gpt-5.3-codex" }, { slug: "text-embedding" }] }, seen),
  );
  assert.deepEqual(listed, ["gpt-5.4", "gpt-5.3-codex"]);
  assert.equal(seen.headers?.get("chatgpt-account-id"), "acct_123");
  assert.equal(seen.headers?.get("originator"), "kru");
  assert.deepEqual(await listCodexModels({ accessToken: "tok", accountId: "a" }, fakeFetch(404, "")), [
    ...CODEX_SUBSCRIPTION_MODELS,
  ]);
});

test("the connection row is a subscription on the Codex backend with a fixed id", () => {
  const tokens = { accessToken: accessToken, refreshToken: "rt", idToken, expiresAt: exp * 1000 };
  const connection = openaiConnectionFromTokens(tokens, parseOpenAIIdToken(idToken), ["gpt-5.4"]);
  assert.equal(connection.id, "sub_openai");
  assert.equal(connection.provider, "openai");
  assert.equal(connection.meta.auth, "oauth");
  assert.equal(connection.meta.accountId, "acct_123");
  assert.equal(connection.meta.baseUrl, "https://chatgpt.com/backend-api/codex");
  assert.equal(connection.meta.listedModels, "gpt-5.4");
  assert.equal(connection.label, "ChatGPT · Plus · dev@example.com");
  assert.throws(() => openaiConnectionFromTokens(tokens, { email: null, accountId: null, plan: null }, []), /no ChatGPT plan/);
});

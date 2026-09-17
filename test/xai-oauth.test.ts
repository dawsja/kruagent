import assert from "node:assert/strict";
import { test } from "node:test";
import { SubscriptionReconnectError } from "../lib/hq/openai-oauth.ts";
import {
  pollXaiDeviceCode,
  refreshXaiTokens,
  requestXaiDeviceCode,
  XAI_DEVICE_CODE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_TOKEN_URL,
  xaiConnectionFromTokens,
} from "../lib/hq/xai-oauth.ts";

type Seen = { url?: string; body?: string };

function fakeFetch(status: number, body: unknown, seen?: Seen) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    if (seen) {
      seen.url = String(url);
      seen.body = String(init?.body);
    }
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

test("the device code request is form-encoded and prefers the complete verification address", async () => {
  const seen: Seen = {};
  const device = await requestXaiDeviceCode(
    fakeFetch(
      200,
      {
        device_code: "dc",
        user_code: "WXYZ-9876",
        verification_uri: "https://auth.x.ai/device",
        verification_uri_complete: "https://auth.x.ai/device?user_code=WXYZ-9876",
        expires_in: 600,
        interval: 5,
      },
      seen,
    ),
  );
  assert.equal(seen.url, XAI_DEVICE_CODE_URL);
  const params = new URLSearchParams(seen.body);
  assert.equal(params.get("client_id"), XAI_OAUTH_CLIENT_ID);
  assert.ok(params.get("scope")?.includes("offline_access"));
  assert.equal(device.verificationUrl, "https://auth.x.ai/device?user_code=WXYZ-9876");
  assert.equal(device.intervalMs, 5000);
});

test("polling follows RFC 8628: pending, slow_down, done, and final errors", async () => {
  const seen: Seen = {};
  assert.deepEqual(await pollXaiDeviceCode({ deviceCode: "dc" }, fakeFetch(400, { error: "authorization_pending" }, seen)), {
    status: "pending",
  });
  assert.equal(seen.url, XAI_TOKEN_URL);
  assert.equal(new URLSearchParams(seen.body).get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code");
  assert.deepEqual(await pollXaiDeviceCode({ deviceCode: "dc" }, fakeFetch(400, { error: "slow_down" })), { status: "slow_down" });
  const done = await pollXaiDeviceCode(
    { deviceCode: "dc" },
    fakeFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 21600 }),
  );
  assert.equal(done.status, "done");
  if (done.status === "done") assert.equal(done.tokens.refreshToken, "rt");
  await assert.rejects(pollXaiDeviceCode({ deviceCode: "dc" }, fakeFetch(400, { error: "expired_token" })), /expired/);
  await assert.rejects(pollXaiDeviceCode({ deviceCode: "dc" }, fakeFetch(400, { error: "access_denied" })), /declined/);
});

test("a refresh keeps the old refresh token, and a dead or gated one is reported clearly", async () => {
  const tokens = await refreshXaiTokens({ refreshToken: "rt_old" }, fakeFetch(200, { access_token: "at2", expires_in: 100 }));
  assert.equal(tokens.refreshToken, "rt_old");
  await assert.rejects(refreshXaiTokens({ refreshToken: "x" }, fakeFetch(400, { error: "invalid_grant" })), SubscriptionReconnectError);
  await assert.rejects(refreshXaiTokens({ refreshToken: "x" }, fakeFetch(403, "")), (error) => {
    assert.ok(!(error instanceof SubscriptionReconnectError));
    assert.match((error as Error).message, /API key/);
    return true;
  });
});

test("the connection row is a subscription on api.x.ai with a fixed id", () => {
  const connection = xaiConnectionFromTokens(
    { accessToken: "at", refreshToken: "rt", idToken: null, expiresAt: null },
    ["grok-4.6"],
  );
  assert.equal(connection.id, "sub_xai");
  assert.equal(connection.meta.auth, "oauth");
  assert.equal(connection.meta.baseUrl, "https://api.x.ai/v1");
  assert.equal(connection.label, "SuperGrok");
});

import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import {
  callbackRedirect,
  configuredCallbackPort,
  startOAuthCallbackListener,
} from "../lib/hq/oauth-listener.ts";

test("the configured port defaults to 1455 and can be turned off", () => {
  assert.equal(configuredCallbackPort({}), 1455);
  assert.equal(configuredCallbackPort({ KRU_OAUTH_CALLBACK_PORT: "0" }), 0);
  assert.equal(configuredCallbackPort({ KRU_OAUTH_CALLBACK_PORT: "off" }), 0);
  assert.equal(configuredCallbackPort({ KRU_OAUTH_CALLBACK_PORT: "1456" }), 1456);
  assert.equal(configuredCallbackPort({ KRU_OAUTH_CALLBACK_PORT: "nope" }), 1455);
});

test("only the callback path is forwarded, with its query intact", () => {
  assert.equal(
    callbackRedirect("http://localhost:3000/", "/auth/callback?code=a&state=b", "GET"),
    "http://localhost:3000/auth/callback?code=a&state=b",
  );
  assert.equal(callbackRedirect("http://localhost:3000", "/other", "GET"), null);
  assert.equal(callbackRedirect("http://localhost:3000", "/auth/callback?code=a", "POST"), null);
});

test("the listener redirects the callback and refuses everything else", async () => {
  const server = await startOAuthCallbackListener({ port: 0, host: "127.0.0.1", appUrl: "http://localhost:3000" });
  assert.ok(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const hit = await fetch(`http://127.0.0.1:${port}/auth/callback?code=a&state=b`, { redirect: "manual" });
    assert.equal(hit.status, 302);
    assert.equal(hit.headers.get("location"), "http://localhost:3000/auth/callback?code=a&state=b");
    const miss = await fetch(`http://127.0.0.1:${port}/anything`);
    assert.equal(miss.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a busy port is reported, not thrown", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
  const address = blocker.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(String(message));
  try {
    const server = await startOAuthCallbackListener({ port, host: "127.0.0.1", appUrl: "http://localhost:3000" });
    assert.equal(server, null);
    assert.ok(warnings.some((line) => line.includes(String(port))));
  } finally {
    console.warn = warn;
    await new Promise((resolve) => blocker.close(resolve));
  }
});

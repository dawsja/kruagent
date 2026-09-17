import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { EndpointRedirectError, noRedirectFetch } from "../lib/hq/safe-fetch.ts";

function listen(server: Server) {
  return new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

test("refuses redirects and never contacts the redirect target", async () => {
  let targetHits = 0;
  const target = createServer((_req, res) => {
    targetHits += 1;
    res.end("{}");
  });
  const targetPort = await listen(target);
  const origin = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetPort}/steal` });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"ok":true}');
  });
  const originPort = await listen(origin);
  try {
    await assert.rejects(
      noRedirectFetch(`http://127.0.0.1:${originPort}/redirect`, { headers: { Authorization: "Bearer secret" } }),
      (error) => error instanceof EndpointRedirectError && error.message.includes("/steal"),
    );
    assert.equal(targetHits, 0);
    const ok = await noRedirectFetch(`http://127.0.0.1:${originPort}/models`);
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true });
  } finally {
    origin.close();
    target.close();
  }
});

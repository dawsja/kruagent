import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { LegacyImportError } from "../lib/db/import-json.ts";
import { ensureKruDatabase } from "../lib/db/init.ts";
import { getStoredGithubApp, listCards, listConnections, listRuns, getOnboarding } from "../lib/hq/data.ts";
import { useTempDataDir } from "./helpers.ts";

const fixture = {
  connections: [
    { provider: "github", accessToken: "ghu_fixturetoken123456", refreshToken: "ghr_fixturerefresh", expiresAt: 1234, label: "octo", meta: { login: "octo" } },
    { provider: "grok", accessToken: "grok-oauth-token", refreshToken: null, expiresAt: null, label: "g", meta: {} },
    { id: "ep_a", provider: "anthropic", accessToken: "sk-ant-fixture-key", refreshToken: null, expiresAt: null, label: "api", meta: { baseUrl: "https://api.anthropic.com/v1" } },
  ],
  cards: [
    { id: "c1", title: "Grok card", body: "", column: "run", repo: "o/r", model: "grok:grok-4.6", status: "running", runId: "r1", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
    { id: "c2", title: "Claude card", body: "b", column: "drop", repo: null, model: "ep_a:claude-opus-5", status: "open", runId: null, createdAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-02T00:00:00Z" },
  ],
  runs: [
    { id: "r1", cardId: "c1", status: "running", log: ["Agent started", "Listing o/r"], proposedWrites: [], prUrl: null, error: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:01Z" },
    { id: "r2", cardId: "gone", status: "merged", log: [], proposedWrites: [], prUrl: "https://github.com/o/r/pull/1", error: null, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
  ],
  onboarding: { complete: true, firstName: "A", lastName: "B", email: "a@b.c", model: "grok", repo: "o/r" },
  githubApp: { clientId: "Iv1.fixture", clientSecret: "fixture-client-secret", slug: "kru-test", appId: 7, installationId: 99 },
};

test("imports kru.json once, drops unsupported data, and encrypts secrets", () => {
  const temp = useTempDataDir();
  try {
    writeFileSync(path.join(temp.dir, "kru.json"), JSON.stringify(fixture));
    ensureKruDatabase();

    const connections = listConnections();
    assert.deepEqual(connections.map((c) => [c.id, c.provider]), [["github", "github"], ["ep_a", "anthropic"]]);
    assert.equal(connections[0].accessToken, "ghu_fixturetoken123456");
    assert.equal(connections[0].refreshToken, "ghr_fixturerefresh");

    const cards = listCards();
    assert.equal(cards.length, 2);
    assert.equal(cards.find((c) => c.id === "c1")?.model, null);
    assert.equal(cards.find((c) => c.id === "c1")?.status, "error");
    assert.equal(cards.find((c) => c.id === "c2")?.model, "ep_a:claude-opus-5");

    const runs = listRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "error");
    assert.equal(runs[0].error, "Interrupted by server restart");
    assert.deepEqual(runs[0].log, ["Agent started", "Listing o/r"]);

    assert.equal(getStoredGithubApp()?.clientSecret, "fixture-client-secret");
    assert.equal(getOnboarding()?.repo, "o/r");

    assert.equal(existsSync(path.join(temp.dir, "kru.json")), false);
    assert.equal(statSync(path.join(temp.dir, "kru.json.imported")).mode & 0o777, 0o600);
    assert.equal(statSync(temp.dir).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(temp.dir, "kru.db")).mode & 0o777, 0o600);

    const raw = ["kru.db", "kru.db-wal"]
      .filter((name) => existsSync(path.join(temp.dir, name)))
      .map((name) => readFileSync(path.join(temp.dir, name)).toString("latin1"))
      .join("");
    for (const secret of ["ghu_fixturetoken123456", "ghr_fixturerefresh", "sk-ant-fixture-key", "fixture-client-secret"]) {
      assert.equal(raw.includes(secret), false, `${secret} found in plaintext`);
    }
  } finally {
    temp.cleanup();
  }
});

test("a corrupt kru.json stops startup and is left untouched", () => {
  const temp = useTempDataDir();
  try {
    const file = path.join(temp.dir, "kru.json");
    writeFileSync(file, "{bad json");
    assert.throws(() => ensureKruDatabase(), LegacyImportError);
    assert.equal(readFileSync(file, "utf8"), "{bad json");
  } finally {
    temp.cleanup();
  }
});

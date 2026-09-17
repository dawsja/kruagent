import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  decryptSecret,
  encryptSecret,
  resetSecretKeyCache,
  SecretKeyError,
} from "../lib/hq/secrets.ts";
import { useTempDataDir } from "./helpers.ts";

test("round trip uses a fresh IV and a 0600 key file", () => {
  const temp = useTempDataDir();
  try {
    const a = encryptSecret("ghu_example-token");
    const b = encryptSecret("ghu_example-token");
    assert.match(a, /^v1\./);
    assert.notEqual(a, b);
    assert.equal(decryptSecret(a), "ghu_example-token");
    assert.equal(decryptSecret(encryptSecret("")), "");
    const mode = statSync(path.join(temp.dir, "secret.key")).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    temp.cleanup();
  }
});

test("tampered ciphertext is rejected", () => {
  const temp = useTempDataDir();
  try {
    const parts = encryptSecret("sk-secret-value").split(".");
    const last = parts[3];
    parts[3] = `${last.slice(0, -1)}${last.endsWith("A") ? "B" : "A"}`;
    assert.throws(() => decryptSecret(parts.join(".")), SecretKeyError);
  } finally {
    temp.cleanup();
  }
});

test("a different key cannot read stored secrets", () => {
  const temp = useTempDataDir();
  try {
    const stored = encryptSecret("sk-ant-value");
    process.env.KRU_SECRET_KEY = randomBytes(32).toString("base64");
    resetSecretKeyCache();
    assert.throws(() => decryptSecret(stored), SecretKeyError);
  } finally {
    delete process.env.KRU_SECRET_KEY;
    temp.cleanup();
  }
});

test("a malformed KRU_SECRET_KEY is refused", () => {
  const temp = useTempDataDir();
  try {
    process.env.KRU_SECRET_KEY = "too-short";
    resetSecretKeyCache();
    assert.throws(() => encryptSecret("x"), SecretKeyError);
  } finally {
    delete process.env.KRU_SECRET_KEY;
    temp.cleanup();
  }
});

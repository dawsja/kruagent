import assert from "node:assert/strict";
import { test } from "node:test";
import { createRedactor, MAX_LOG_LINE } from "../lib/hq/redact.ts";

test("masks known secrets, including inside longer text", () => {
  const redact = createRedactor(["my-custom-endpoint-key-123", null, undefined, "short"]);
  assert.equal(redact("auth failed for my-custom-endpoint-key-123!"), "auth failed for ***!");
  assert.equal(redact("short stays"), "short stays", "values under 8 characters are not treated as secrets");
});

test("masks common token formats Kru doesn't know", () => {
  const redact = createRedactor([]);
  const line = "tokens ghu_abcdefghijklmnopqrstuv1234 sk-ant-api03-abcdefghijklmnop xai-abcdefghijklmnopqrst gsk_abcdefghijklmnopqrst";
  const out = redact(line);
  for (const leaked of ["ghu_", "sk-ant-api03", "xai-abcd", "gsk_abcd"]) assert.equal(out.includes(leaked), false, leaked);
});

test("masks JWT-shaped tokens from subscription sign-ins", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJhY2N0XzEyMyJ9.c2lnbmF0dXJlLXNpZ25hdHVyZQ";
  const out = createRedactor([])(`Authorization: Bearer ${jwt} failed`);
  assert.equal(out, "Authorization: Bearer *** failed");
});

test("caps long lines", () => {
  const out = createRedactor([])("x".repeat(MAX_LOG_LINE + 50));
  assert.equal(out.length, MAX_LOG_LINE + 1);
  assert.ok(out.endsWith("…"));
});

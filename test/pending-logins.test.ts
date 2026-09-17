import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clearPendingLogins,
  createPendingLogin,
  finishPendingLogin,
  getPendingLogin,
  PENDING_LOGIN_TTL_MS,
  sweepExpiredLogins,
  takeLoginByState,
} from "../lib/hq/pending-logins.ts";

test("a browser login's state works once and the entry stays for the polling tab", () => {
  clearPendingLogins();
  const login = createPendingLogin({ provider: "openai", kind: "browser", next: "/app/settings", verifier: "v" });
  assert.ok(login.state.length >= 24);
  assert.equal(takeLoginByState("wrong"), null);
  assert.equal(takeLoginByState("")?.id, undefined);
  const taken = takeLoginByState(login.state);
  assert.equal(taken?.id, login.id);
  assert.equal(taken?.verifier, "v");
  assert.equal(takeLoginByState(login.state), null, "a second callback with the same state is refused");
  assert.equal(getPendingLogin(login.id)?.status, "pending");
  finishPendingLogin(login.id, { status: "done" });
  assert.equal(getPendingLogin(login.id)?.status, "done");
});

test("device logins are not matched by state, and errors are kept", () => {
  clearPendingLogins();
  const login = createPendingLogin({ provider: "xai", kind: "device", next: "/app", deviceCode: "dc", userCode: "AB" });
  assert.equal(takeLoginByState(login.state), null);
  finishPendingLogin(login.id, { status: "error", error: "declined" });
  assert.deepEqual(
    [getPendingLogin(login.id)?.status, getPendingLogin(login.id)?.error],
    ["error", "declined"],
  );
});

test("old entries are swept", () => {
  clearPendingLogins();
  const login = createPendingLogin({ provider: "openai", kind: "browser", next: "/app" });
  sweepExpiredLogins(Date.now() + PENDING_LOGIN_TTL_MS + 1);
  assert.equal(getPendingLogin(login.id), null);
});

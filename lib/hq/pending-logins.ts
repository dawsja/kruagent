/**
 * Subscription sign-ins in progress. A browser sign-in comes back to
 * http://localhost:1455/auth/callback with no cookies (cookies are host
 * scoped, and Kru may be on 127.0.0.1 or another port), so the state and
 * PKCE verifier live here instead of in a cookie. Kru is one Node process,
 * entries live ten minutes, and losing them on restart only means clicking
 * Sign in again, so a map on `globalThis` (like the database handle) is
 * enough.
 */
import { randomBytes } from "node:crypto";
import type { SubscriptionProvider } from "./types";

const randomString = (bytes: number) => randomBytes(bytes).toString("base64url");

export type PendingLogin = {
  id: string;
  provider: SubscriptionProvider;
  kind: "browser" | "device";
  /** Browser flow: the `state` the callback must carry; one use only. */
  state: string;
  /** Browser flow: the PKCE verifier for the code exchange. */
  verifier: string;
  /** Same-site path to return to. */
  next: string;
  createdAt: number;
  status: "pending" | "done" | "error";
  error?: string;
  /** Device flow: OpenAI's device_auth_id or xAI's device_code. */
  deviceCode?: string;
  userCode?: string;
  verificationUrl?: string;
  intervalMs?: number;
  /** Device flow: when the vendor was last asked, to keep to its interval. */
  lastPollAt?: number;
  /** Device flow: a poll in progress, so concurrent status checks wait for it. */
  polling?: Promise<void>;
};

export const PENDING_LOGIN_TTL_MS = 10 * 60 * 1000;

const holder = globalThis as typeof globalThis & { __kruPendingLogins?: Map<string, PendingLogin> };
const logins = (holder.__kruPendingLogins ??= new Map<string, PendingLogin>());

export function sweepExpiredLogins(now = Date.now()) {
  for (const [id, login] of logins) {
    if (now - login.createdAt > PENDING_LOGIN_TTL_MS) logins.delete(id);
  }
}

export function createPendingLogin(
  input: Pick<PendingLogin, "provider" | "kind" | "next"> &
    Partial<Pick<PendingLogin, "deviceCode" | "userCode" | "verificationUrl" | "intervalMs" | "verifier">>,
): PendingLogin {
  sweepExpiredLogins();
  const login: PendingLogin = {
    id: randomString(12),
    state: randomString(24),
    verifier: input.verifier ?? "",
    createdAt: Date.now(),
    status: "pending",
    ...input,
  };
  logins.set(login.id, login);
  return login;
}

export function getPendingLogin(id: string): PendingLogin | null {
  sweepExpiredLogins();
  return logins.get(id) ?? null;
}

/**
 * The pending browser login for this `state`. Its state is cleared so the
 * same callback can't complete twice; the entry stays until it is finished
 * so the tab that started it can read the outcome.
 */
export function takeLoginByState(state: string): PendingLogin | null {
  sweepExpiredLogins();
  if (!state) return null;
  for (const login of logins.values()) {
    if (login.kind === "browser" && login.status === "pending" && login.state === state) {
      login.state = "";
      return login;
    }
  }
  return null;
}

export function updatePendingLogin(id: string, patch: Partial<PendingLogin>): PendingLogin | null {
  const login = logins.get(id);
  if (!login) return null;
  Object.assign(login, patch);
  return login;
}

/** A finished login is reported once to the browser, then forgotten. */
export function finishPendingLogin(id: string, result: { status: "done" } | { status: "error"; error: string }) {
  const login = logins.get(id);
  if (!login) return;
  login.status = result.status;
  login.error = result.status === "error" ? result.error : undefined;
  // Keep it briefly so the polling tab sees the outcome, then drop it.
  login.createdAt = Date.now() - PENDING_LOGIN_TTL_MS + 60_000;
}

export function deletePendingLogin(id: string) {
  logins.delete(id);
}

/** Test helper. */
export function clearPendingLogins() {
  logins.clear();
}

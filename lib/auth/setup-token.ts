import { randomBytes, timingSafeEqual } from "node:crypto";
import { appUrl } from "@/lib/hq/oauth";

type TokenState = { token: string; attempts: number[]; logged: boolean };
const holder = globalThis as typeof globalThis & { __kruSetupToken?: TokenState };

const ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const MAX_WRONG_ATTEMPTS = 10;

/**
 * The one-time token that registering the only account requires. It lives
 * only in server memory (or comes from KRU_SETUP_TOKEN) and is printed once
 * to the server logs, so only whoever runs the server can register.
 */
export function ensureSetupToken(): string {
  let state = holder.__kruSetupToken;
  if (!state) {
    state = {
      token: process.env.KRU_SETUP_TOKEN?.trim() || randomBytes(18).toString("base64url"),
      attempts: [],
      logged: false,
    };
    holder.__kruSetupToken = state;
  }
  if (!state.logged) {
    state.logged = true;
    if (process.env.KRU_SETUP_TOKEN) {
      console.info(
        `[kru] No account yet. Open ${appUrl()}/register and enter the KRU_SETUP_TOKEN you set.`,
      );
    } else {
      console.info(
        `[kru] Kru setup token: ${state.token}. Open ${appUrl()}/register and enter it to create the only account.`,
      );
    }
  }
  return state.token;
}

/** Compares in constant time and locks out after repeated wrong tokens. */
export function checkSetupToken(input: string): "ok" | "wrong" | "locked" {
  const state = holder.__kruSetupToken;
  if (!state) return "wrong";
  const now = Date.now();
  state.attempts = state.attempts.filter((at) => now - at < ATTEMPT_WINDOW_MS);
  if (state.attempts.length >= MAX_WRONG_ATTEMPTS) return "locked";
  const given = Buffer.from(input.trim());
  const expected = Buffer.from(state.token);
  const ok = given.length === expected.length && timingSafeEqual(given, expected);
  if (!ok) state.attempts.push(now);
  return ok ? "ok" : "wrong";
}

/** Forgets the token once the account exists. */
export function clearSetupToken() {
  holder.__kruSetupToken = undefined;
}

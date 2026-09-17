import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";

export function appUrl() {
  return (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** OAuth state cookies are only marked Secure when Kru is served over HTTPS. */
export function cookieSecure() {
  return appUrl().startsWith("https://");
}

/**
 * A same-site path to continue to after a redirect, or `fallback`. Rejects
 * absolute URLs and protocol-relative values like "//evil.example".
 */
export function safeNext(value: string | null | undefined, fallback = "/app") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) {
    return fallback;
  }
  try {
    const base = "http://kru.invalid";
    const url = new URL(value, base);
    if (url.origin !== base) return fallback;
    return `${url.pathname}${url.search}`;
  } catch {
    return fallback;
  }
}

export function randomString(bytes = 24) {
  return randomBytes(bytes).toString("base64url");
}

export function pkceVerifier() {
  return randomString(32);
}

export function pkceChallenge(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

export async function setOAuthCookie(payload: {
  provider: string;
  state: string;
  verifier?: string;
  next?: string;
}) {
  const jar = await cookies();
  jar.set("kru_oauth", JSON.stringify(payload), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 600,
    secure: cookieSecure(),
  });
}

export async function takeOAuthCookie(): Promise<{
  provider: string;
  state: string;
  verifier?: string;
  next?: string;
} | null> {
  const jar = await cookies();
  const raw = jar.get("kru_oauth")?.value;
  jar.delete("kru_oauth");
  if (!raw) return null;
  try {
    return JSON.parse(raw) as {
      provider: string;
      state: string;
      verifier?: string;
      next?: string;
    };
  } catch {
    return null;
  }
}

/** Remembers the `state` sent with the GitHub App manifest for one hour. */
export async function setManifestState(state: string) {
  const jar = await cookies();
  jar.set("kru_manifest", state, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 3600,
    secure: cookieSecure(),
  });
}

/** Reads and clears the manifest `state`. */
export async function takeManifestState(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get("kru_manifest")?.value ?? null;
  jar.delete("kru_manifest");
  return value;
}

export function publicConnection(connection: {
  id: string;
  provider: string;
  label: string;
  meta: Record<string, string>;
}) {
  return {
    id: connection.id,
    provider: connection.provider,
    label: connection.label,
    meta: connection.meta,
    connected: true,
  };
}

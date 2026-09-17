"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { countAccounts, getAuth } from "@/lib/auth/server";
import { checkSetupToken, clearSetupToken } from "@/lib/auth/setup-token";

export type RegisterState = { error?: string };

// Matches the username plugin's default rules after lowercasing.
const USERNAME = /^[a-z0-9_.]{3,30}$/;

/**
 * Creates the only account. This is the one place accounts are created: the
 * public sign-up route is disabled, and the setup token proves the caller
 * runs the server.
 */
export async function registerAccount(
  _previous: RegisterState,
  form: FormData,
): Promise<RegisterState> {
  const token = String(form.get("token") ?? "");
  const name = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const confirm = String(form.get("confirm") ?? "");

  if ((await countAccounts()) > 0) {
    return { error: "An account already exists. Sign in instead." };
  }
  const tokenCheck = checkSetupToken(token);
  if (tokenCheck === "locked") {
    return { error: "Too many wrong setup tokens. Wait 10 minutes and try again." };
  }
  if (tokenCheck === "wrong") {
    return { error: "That setup token doesn't match. Copy it from the server logs." };
  }
  if (!USERNAME.test(name)) {
    return { error: "Use 3 to 30 letters, numbers, dots or underscores for the username." };
  }
  if (password.length < 12) {
    return { error: "Use a password of at least 12 characters." };
  }
  if (password !== confirm) {
    return { error: "The passwords don't match." };
  }

  try {
    const auth = await getAuth();
    // Better Auth requires an email; Kru never uses it. `.invalid` is a
    // reserved domain, so it can never belong to anyone. The username plugin
    // reads `username` from the body at runtime, but the inferred body type
    // doesn't include plugin fields, hence the cast.
    const body = { email: `${name}@users.kru.invalid`, name, username: name, password };
    await auth.api.signUpEmail({
      body: body as { email: string; name: string; password: string },
      headers: await headers(),
    });
  } catch (error) {
    if (error instanceof Error && /registration (is )?closed/i.test(error.message)) {
      return { error: "An account already exists. Sign in instead." };
    }
    if (error instanceof APIError) {
      return { error: error.message || "Could not create the account." };
    }
    throw error;
  }

  clearSetupToken();
  redirect("/app");
}

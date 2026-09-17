"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { authInputClass, authLabelClass } from "@/components/hq/auth-shell";

/** Change the account password and sign out every other session. */
export function PasswordForm() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (next.length < 12) {
      setMessage({ tone: "error", text: "Use a new password of at least 12 characters." });
      return;
    }
    if (next !== confirm) {
      setMessage({ tone: "error", text: "The new passwords don't match." });
      return;
    }
    setBusy(true);
    setMessage(null);
    const { error } = await authClient.changePassword({
      currentPassword: current,
      newPassword: next,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (error) {
      setMessage({
        tone: "error",
        text:
          error.status === 429
            ? "Too many attempts. Wait a minute and try again."
            : "Could not change the password. Check your current password.",
      });
      return;
    }
    setCurrent("");
    setNext("");
    setConfirm("");
    setMessage({ tone: "ok", text: "Password changed. Other sessions were signed out." });
  }

  return (
    <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 sm:col-span-2">
        <span className={authLabelClass}>Current password</span>
        <input
          type="password"
          value={current}
          onChange={(event) => setCurrent(event.target.value)}
          autoComplete="current-password"
          required
          className={authInputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>New password</span>
        <input
          type="password"
          value={next}
          onChange={(event) => setNext(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
          className={authInputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Confirm new password</span>
        <input
          type="password"
          value={confirm}
          onChange={(event) => setConfirm(event.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
          className={authInputClass}
        />
      </label>
      {message ? (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          className={`text-[13px] sm:col-span-2 ${message.tone === "error" ? "text-ember" : "text-mint"}`}
        >
          {message.text}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={busy}
          className="h-10 rounded-full bg-brand px-4 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
        >
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

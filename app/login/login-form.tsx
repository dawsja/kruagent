"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth/client";
import { authInputClass, authLabelClass } from "@/components/hq/auth-shell";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.username({
      username: username.trim(),
      password,
    });
    if (failure) {
      setBusy(false);
      setError(
        failure.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : "That username and password don't match.",
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Username</span>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          className={authInputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Password</span>
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          className={authInputClass}
        />
      </label>
      {error ? (
        <p role="alert" className="text-[13px] text-ember">
          {error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={busy}
        className="mt-2 h-11 rounded-full bg-brand text-[14px] font-medium text-brand-foreground disabled:opacity-50"
      >
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

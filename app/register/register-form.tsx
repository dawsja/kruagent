"use client";

import { useActionState } from "react";
import { authInputClass, authLabelClass } from "@/components/hq/auth-shell";
import { registerAccount, type RegisterState } from "./actions";

export function RegisterForm({ tokenPreset }: { tokenPreset: boolean }) {
  const [state, action, pending] = useActionState<RegisterState, FormData>(
    registerAccount,
    {},
  );

  return (
    <form action={action} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Setup token</span>
        <input
          name="token"
          autoComplete="off"
          spellCheck={false}
          required
          className={`${authInputClass} font-mono`}
        />
        <span className="text-[12px] text-ash">
          {tokenPreset
            ? "Use the KRU_SETUP_TOKEN value you set for this server."
            : "Printed in the server logs when Kru starts. With Docker: docker compose logs kru | grep \"setup token\""}
        </span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Username</span>
        <input
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          minLength={3}
          maxLength={30}
          required
          className={authInputClass}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Password</span>
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className={authInputClass}
        />
        <span className="text-[12px] text-ash">At least 12 characters.</span>
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={authLabelClass}>Confirm password</span>
        <input
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
          className={authInputClass}
        />
      </label>
      {state.error ? (
        <p role="alert" className="text-[13px] text-ember">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className="mt-2 h-11 rounded-full bg-brand text-[14px] font-medium text-brand-foreground disabled:opacity-50"
      >
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { getSession } from "@/lib/auth/guard";
import { countAccounts } from "@/lib/auth/server";
import { appUrl, safeNext } from "@/lib/hq/oauth";
import { AuthShell } from "@/components/hq/auth-shell";
import { LoginForm } from "./login-form";

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  await connection();
  const { next } = await searchParams;
  const target = safeNext(typeof next === "string" ? next : null, "/app");

  if ((await countAccounts()) === 0) redirect("/register");
  if (await getSession()) redirect(target);

  const host = (await headers()).get("host");
  const expected = new URL(appUrl()).host;
  const mismatch = host && host !== expected ? { host, expected: appUrl() } : null;

  return (
    <AuthShell
      eyebrow="Sign in"
      title="Welcome back"
      description="Sign in to your Kru board."
    >
      {mismatch ? (
        <p className="mb-4 rounded-xl border border-fog bg-mist px-3 py-2 text-[12px] leading-5 text-graphite">
          You opened Kru at {mismatch.host}, but APP_URL is {mismatch.expected}.
          Set APP_URL to the address you use, or GitHub connections will send
          you to the wrong place.
        </p>
      ) : null}
      <LoginForm next={target} />
    </AuthShell>
  );
}

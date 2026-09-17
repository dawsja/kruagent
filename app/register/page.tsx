import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthShell } from "@/components/hq/auth-shell";
import { countAccounts } from "@/lib/auth/server";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  await connection();
  if ((await countAccounts()) > 0) redirect("/login");

  return (
    <AuthShell
      eyebrow="First run"
      title="Create your account"
      description="Kru has one account: yours. Enter the setup token from the server logs to prove you run this server."
    >
      <RegisterForm tokenPreset={Boolean(process.env.KRU_SETUP_TOKEN)} />
    </AuthShell>
  );
}

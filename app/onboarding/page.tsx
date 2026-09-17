import { redirect } from "next/navigation";
import { connection } from "next/server";
import { requirePageSession } from "@/lib/auth/guard";
import { getOnboarding } from "@/lib/hq/data";
import { KruOnboarding } from "./kru-onboarding";

export default async function OnboardingPage({ searchParams }: PageProps<"/onboarding">) {
  await connection();
  await requirePageSession("/onboarding");
  // Setup runs once. Restart it from Settings, which clears the flag.
  if (getOnboarding()?.complete) {
    redirect("/app");
  }
  const { error } = await searchParams;
  return <KruOnboarding initialError={typeof error === "string" ? error : null} />;
}

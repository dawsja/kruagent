import { redirect } from "next/navigation";
import { connection } from "next/server";
import { requirePageSession } from "@/lib/auth/guard";
import { getOnboarding } from "@/lib/hq/data";
import { HqBoard } from "./hq-board";

export default async function AppPage({ searchParams }: PageProps<"/app">) {
  // Read setup state per request; never at build time.
  await connection();
  await requirePageSession("/app");
  const onboarding = getOnboarding();
  if (!onboarding?.complete) {
    redirect("/onboarding");
  }
  const { error } = await searchParams;
  return (
    <HqBoard
      initialError={typeof error === "string" ? error : null}
      defaultRepo={onboarding.repo}
    />
  );
}

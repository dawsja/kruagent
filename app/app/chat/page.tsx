import type { Metadata } from "next";
import { connection } from "next/server";
import { TeamChatWindow } from "@/components/hq/team-chat";
import { requirePageSession } from "@/lib/auth/guard";

export const metadata: Metadata = {
  title: "Team",
};

/** The Team room alone, for the chat popped out into its own browser window. */
export default async function Page() {
  await connection();
  await requirePageSession("/app/chat");
  return <TeamChatWindow />;
}

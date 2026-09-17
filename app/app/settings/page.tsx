import { connection } from "next/server";
import { requirePageSession } from "@/lib/auth/guard";
import { SettingsPage } from "./settings-page";

export default async function Page() {
  await connection();
  await requirePageSession("/app/settings");
  return <SettingsPage />;
}

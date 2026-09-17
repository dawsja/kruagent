import { redirect } from "next/navigation";

/** Kru is a self-hosted app, so the root goes straight to the board. */
export default function Home() {
  redirect("/app");
}

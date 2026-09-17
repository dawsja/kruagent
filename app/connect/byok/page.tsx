import { connection } from "next/server";
import { Suspense } from "react";
import { requirePageSession } from "@/lib/auth/guard";
import { ByokConnect } from "./byok-connect";

export default async function ByokConnectPage() {
  await connection();
  await requirePageSession("/connect/byok");
  return (
    <Suspense fallback={null}>
      <ByokConnect />
    </Suspense>
  );
}

import { NextResponse } from "next/server";

/** Public liveness check for Docker and uptime monitors. Reveals nothing. */
export function GET() {
  return NextResponse.json({ ok: true });
}

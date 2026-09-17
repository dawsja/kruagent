import { NextResponse } from "next/server";
import { boxConfig, BoxError, openBoxStream, type BoxConfig } from "./box";

/*
 * Shared pieces for the API routes that front the box: the terminal and
 * watch endpoints. They all need a configured box, answer box errors with
 * the box's own status, and stream server-sent events through unchanged.
 */

const TERMINAL_ID = /^[a-f0-9]{16}$/;

export function requireBox(): BoxConfig | NextResponse {
  try {
    const config = boxConfig();
    if (config) return config;
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 503 });
  }
  return NextResponse.json({ error: "No box is configured. Set KRU_BOX_URL." }, { status: 404 });
}

export function isTerminalId(id: string) {
  return TERMINAL_ID.test(id);
}

export function boxErrorResponse(error: unknown) {
  if (error instanceof BoxError) {
    return NextResponse.json({ error: error.message }, { status: error.status || 503 });
  }
  const message = error instanceof Error ? error.message : "Box request failed";
  return NextResponse.json({ error: message }, { status: 502 });
}

/** Passes one of the box's event streams to the browser. */
export async function proxyBoxStream(config: BoxConfig, route: string, request: Request) {
  try {
    const upstream = await openBoxStream(config, route, request.signal);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return boxErrorResponse(error);
  }
}

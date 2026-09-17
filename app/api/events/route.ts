import { withSession } from "@/lib/auth/guard";
import { subscribe, type LiveEvent } from "@/lib/hq/events";

/** A comment line now and then, so proxies don't close a quiet stream. */
const KEEPALIVE_MS = 25_000;
/** How long a browser waits before reconnecting after the stream drops. */
const RETRY_MS = 3_000;

/**
 * What changed, as server-sent events: `{"topic":"board"}`, `{"topic":"chat"}`
 * or `{"topic":"run","runId":…}`, with no data of their own. The board, the
 * Team room and the unread dot fetch again when they hear one. The stream
 * ends when the browser goes; EventSource reconnects on its own.
 */
async function handleGet(request: Request) {
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };
      send(`retry: ${RETRY_MS}\n: connected\n\n`);
      const unsubscribe = subscribe((event: LiveEvent) => send(`data: ${JSON.stringify(event)}\n\n`));
      const keepalive = setInterval(() => send(": ping\n\n"), KEEPALIVE_MS);
      cleanup = () => {
        clearInterval(keepalive);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      };
      request.signal.addEventListener("abort", () => cleanup(), { once: true });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

export const GET = withSession(handleGet);

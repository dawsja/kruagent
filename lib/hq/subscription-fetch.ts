/**
 * `fetch` wrappers for subscription sign-ins. An API key never changes, but
 * an OAuth access token expires within hours, so each request looks up a
 * fresh token and a 401 gets one forced refresh and one retry. The ChatGPT
 * wrapper also shapes requests the way the Codex backend expects, and can
 * stream on the backend's behalf while Kru keeps asking for one JSON reply.
 */
import { SubscriptionReconnectError } from "./openai-oauth.ts";
import { noRedirectFetch } from "./safe-fetch.ts";
import type { Connection } from "./types";

export type SubscriptionFetchOptions = {
  connectionId: string;
  /** Defaults to Kru's redirect-refusing fetch. */
  fetchImpl?: typeof fetch;
  /** Returns a usable connection; `force` renews the token first. */
  fresh?: (force: boolean) => Promise<Connection>;
};

/** Sent when a request somehow reaches the Codex backend without instructions. */
const FALLBACK_INSTRUCTIONS = "You are a careful coding agent working in a cloned repository.";

function defaultFresh(connectionId: string) {
  return async (force: boolean) => {
    // Loaded on use: tests inject `fresh` and never open the database.
    const [{ getConnection }, { ensureFreshConnection }] = await Promise.all([
      import("./data.ts"),
      import("./model-auth.ts"),
    ]);
    const stored = getConnection(connectionId);
    if (!stored) throw new SubscriptionReconnectError("The subscription sign-in was removed. Sign in again in Settings.");
    return ensureFreshConnection(stored, { force });
  };
}

/**
 * Sends with a fresh bearer token. `shape` may rewrite the request first;
 * it runs once, before the first attempt.
 */
function withSubscriptionAuth(
  options: SubscriptionFetchOptions,
  shape?: (init: RequestInit, url: string) => RequestInit,
): typeof fetch {
  const fetchImpl = options.fetchImpl ?? noRedirectFetch;
  const fresh = options.fresh ?? defaultFresh(options.connectionId);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const shaped = shape ? shape(init ?? {}, url) : (init ?? {});
    const attempt = async (force: boolean) => {
      const connection = await fresh(force);
      const headers = new Headers(shaped.headers);
      headers.set("authorization", `Bearer ${connection.accessToken}`);
      return fetchImpl(input, { ...shaped, headers });
    };
    const first = await attempt(false);
    if (first.status !== 401) return first;
    // The token may have been revoked since it was refreshed; renew once.
    const second = await attempt(true);
    if (second.status !== 401) return second;
    throw new SubscriptionReconnectError();
  }) as typeof fetch;
}

/** An X (SuperGrok) sign-in: the plain xAI API with a bearer token. */
export function xaiOAuthFetch(options: SubscriptionFetchOptions): typeof fetch {
  return withSubscriptionAuth(options);
}

type ResponsesBody = Record<string, unknown> & {
  store?: boolean;
  instructions?: string;
  include?: string[];
  stream?: boolean;
};

/** What the Codex backend requires of a Responses request. */
export function shapeCodexBody(body: ResponsesBody, stream: boolean): ResponsesBody {
  const include = new Set(Array.isArray(body.include) ? (body.include as string[]) : []);
  include.add("reasoning.encrypted_content");
  const shaped: ResponsesBody = {
    ...body,
    store: false,
    instructions: typeof body.instructions === "string" && body.instructions.trim() ? body.instructions : FALLBACK_INSTRUCTIONS,
    include: [...include],
  };
  // Nothing is stored server-side, so nothing can be continued by id.
  delete shaped.previous_response_id;
  if (stream) shaped.stream = true;
  return shaped;
}

/** Whether Kru streams from the Codex backend and folds the events into one reply. */
export function codexStreams() {
  return process.env.KRU_CODEX_FORCE_STREAM !== "0";
}

type SseEvent = Record<string, unknown> & { type?: string };

/** The `data:` payloads of a server-sent event stream, in order. */
export function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data) as SseEvent);
    } catch {
      /* not JSON; skip */
    }
  }
  return events;
}

/**
 * Folds a streamed Responses reply into the JSON the non-streaming API
 * returns: every finished output item in order, plus the id, model and
 * usage from the final event. A failure becomes the `error` object the
 * OpenAI SDK reports.
 */
export function collapseResponsesStream(text: string, fallbackModel?: string): Record<string, unknown> {
  const output: unknown[] = [];
  let final: Record<string, unknown> = {};
  let error: { message: string; code?: unknown } | null = null;
  for (const event of parseSse(text)) {
    switch (event.type) {
      case "response.output_item.done": {
        const index = typeof event.output_index === "number" ? event.output_index : output.length;
        output[index] = event.item;
        break;
      }
      case "response.completed":
      case "response.incomplete":
        final = (event.response ?? {}) as Record<string, unknown>;
        break;
      case "response.failed": {
        const response = (event.response ?? {}) as { error?: { message?: string; code?: unknown } };
        error = { message: response.error?.message ?? "The model call failed", code: response.error?.code };
        break;
      }
      case "error": {
        const nested = event.error as { message?: string; code?: unknown } | undefined;
        error = {
          message: (typeof event.message === "string" ? event.message : nested?.message) ?? "The model call failed",
          code: event.code ?? nested?.code,
        };
        break;
      }
      default:
        break;
    }
  }
  if (error) {
    return {
      error: { message: error.message, type: "server_error", param: null, code: String(error.code ?? "stream_error") },
    };
  }
  const items = output.filter((item) => item !== undefined);
  const usage = (final.usage as Record<string, unknown> | undefined) ?? { input_tokens: 0, output_tokens: 0 };
  return {
    id: typeof final.id === "string" ? final.id : `resp_${Date.now()}`,
    object: "response",
    created_at: typeof final.created_at === "number" ? final.created_at : Math.floor(Date.now() / 1000),
    model: typeof final.model === "string" ? final.model : fallbackModel,
    output: items.length ? items : (final.output ?? []),
    usage,
    incomplete_details: final.incomplete_details ?? null,
  };
}

/**
 * A ChatGPT sign-in: the Codex backend's Responses API. Requests get the
 * account header, `store: false`, instructions and encrypted reasoning; when
 * streaming is on, the reply is streamed and folded back into one JSON body
 * so the run loop stays unchanged.
 */
export function codexFetch(options: SubscriptionFetchOptions & { accountHeaders: Record<string, string> }): typeof fetch {
  const stream = codexStreams();
  let model: string | undefined;
  const send = withSubscriptionAuth(options, (init, url) => {
    const headers = new Headers(init.headers);
    for (const [name, value] of Object.entries(options.accountHeaders)) headers.set(name, value);
    if (init.method?.toUpperCase() !== "POST" || !/\/responses(\?|$)/.test(url) || typeof init.body !== "string") {
      return { ...init, headers };
    }
    let body: ResponsesBody;
    try {
      body = JSON.parse(init.body) as ResponsesBody;
    } catch {
      return { ...init, headers };
    }
    model = typeof body.model === "string" ? body.model : undefined;
    if (stream) headers.set("accept", "text/event-stream");
    return { ...init, headers, body: JSON.stringify(shapeCodexBody(body, stream)) };
  });
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await send(input, init);
    if (!stream || !res.ok || !/text\/event-stream/i.test(res.headers.get("content-type") ?? "")) return res;
    const folded = collapseResponsesStream(await res.text(), model);
    const headers = new Headers({ "content-type": "application/json" });
    for (const name of ["x-request-id", "openai-processing-ms"]) {
      const value = res.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(JSON.stringify(folded), { status: 200, headers });
  }) as typeof fetch;
}

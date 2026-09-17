import { withSession } from "@/lib/auth/guard";
import { NextResponse } from "next/server";
import {
  buildByokConnection,
  normalizeBaseUrl,
  verifyByokKey,
} from "@/lib/hq/byok";
import { endpointName, parseModelList } from "@/lib/hq/models";
import { publicConnection, randomString } from "@/lib/hq/oauth";
import { getConnection, listConnections, upsertConnection } from "@/lib/hq/data";
import { isByokProvider, isSubscriptionConnection, type Connection } from "@/lib/hq/types";

/** Scheme, host and port. A saved key is only reused while all three match. */
function originOf(url: string | undefined) {
  try {
    return new URL(url ?? "").origin;
  } catch {
    return "";
  }
}

/** Adds " 2", " 3" when another endpoint already uses the name. */
function uniqueName(name: string, others: Connection[]) {
  const taken = new Set(
    others
      .filter((item) => isByokProvider(item.provider))
      .map((item) => endpointName(item).toLowerCase()),
  );
  let candidate = name;
  let suffix = 2;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} ${suffix++}`;
  return candidate;
}

/**
 * Add or update an API-key endpoint. Body: id (omit to add a new endpoint),
 * provider (the API format: openai, anthropic or xai), name, baseUrl,
 * apiKey, models (optional comma-separated ids).
 *
 * When updating, a blank apiKey keeps the stored key, but only while the
 * endpoint keeps the same scheme, host and port. A saved key is never sent to
 * a different server unless it is typed again.
 */
async function handlePost(request: Request) {
  try {
    const body = (await request.json()) as {
      id?: string;
      provider?: string;
      name?: string;
      baseUrl?: string;
      apiKey?: string;
      models?: string;
    };
    const provider = body.provider ?? "";
    if (!isByokProvider(provider)) {
      return NextResponse.json({ error: "Pick an API format" }, { status: 400 });
    }
    const baseUrl = normalizeBaseUrl(provider, body.baseUrl ?? "");

    const existing = body.id ? getConnection(body.id) : null;
    if (body.id && (!existing || !isByokProvider(existing.provider))) {
      return NextResponse.json(
        { error: "That endpoint no longer exists" },
        { status: 404 },
      );
    }
    if (existing && isSubscriptionConnection(existing)) {
      return NextResponse.json(
        { error: "A subscription sign-in has no key to edit. Sign in again in Settings instead." },
        { status: 400 },
      );
    }

    let apiKey = (body.apiKey ?? "").trim();
    if (!apiKey && existing) {
      if (originOf(existing.meta.baseUrl) !== originOf(baseUrl)) {
        return NextResponse.json(
          {
            error:
              "Enter the API key again when you change the endpoint's scheme, host, or port.",
          },
          { status: 400 },
        );
      }
      apiKey = existing.accessToken;
    }
    if (!apiKey) {
      return NextResponse.json({ error: "API key required" }, { status: 400 });
    }
    if (/\s/.test(apiKey)) {
      return NextResponse.json(
        { error: "API key must not contain spaces" },
        { status: 400 },
      );
    }

    // May come back with "/v1" added when that is where the models route is.
    const found = await verifyByokKey({ provider, baseUrl, apiKey });
    if (found.missing && parseModelList(body.models).length === 0) {
      const tried = /\/v1$/i.test(baseUrl) ? baseUrl : `${baseUrl} or ${baseUrl}/v1`;
      return NextResponse.json(
        {
          error: `No model list found at ${tried}. Check the endpoint URL, or type the model ids to use.`,
        },
        { status: 400 },
      );
    }

    const id = existing?.id ?? `ep_${randomString(6)}`;
    const requestedName =
      body.name?.trim() ||
      existing?.meta.name ||
      endpointName({ provider, meta: { baseUrl: found.baseUrl } });

    const others = listConnections().filter((item) => item.id !== id);
    const connection = buildByokConnection({
      id,
      name: uniqueName(requestedName, others),
      provider,
      baseUrl: found.baseUrl,
      apiKey,
      models: body.models ?? "",
      listed: found.models,
    });
    upsertConnection(connection);

    return NextResponse.json({ connection: publicConnection(connection) });
  } catch (reason) {
    const message =
      reason instanceof Error ? reason.message : "Could not save this endpoint";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export const POST = withSession(handlePost);

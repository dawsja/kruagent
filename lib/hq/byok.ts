import {
  BYOK_DEFAULT_BASE_URL,
  OFFICIAL_HOSTS,
  parseModelList,
  XAI_MODEL_ORDER,
} from "./models";
import { EndpointRedirectError, noRedirectFetch } from "./safe-fetch";
import type { ByokProvider, Connection } from "./types";

export function normalizeBaseUrl(provider: ByokProvider, value: string) {
  const trimmed = value.trim().replace(/\/+$/, "");
  const url = trimmed || BYOK_DEFAULT_BASE_URL[provider];
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Endpoint URL must be a full URL, like https://host/v1");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("Endpoint URL must start with http:// or https://");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Put the API key in the key field, not in the endpoint URL");
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function keyHint(apiKey: string) {
  const tail = apiKey.slice(-4);
  return apiKey.length > 8 ? `…${tail}` : "set";
}

export type ListedModel = { id: string; created: number | null };

export type ModelRow = {
  id?: string;
  name?: string;
  /** OpenAI and xAI: unix seconds. */
  created?: number;
  /** Anthropic: ISO timestamp. */
  created_at?: string;
};

type ModelPage = {
  data?: ModelRow[];
  models?: ModelRow[];
  has_more?: boolean;
  last_id?: string;
};

export function rowsToModels(rows: ModelRow[]): ListedModel[] {
  return rows.flatMap((row) => {
    const id = (row.id ?? row.name ?? "").trim();
    if (!id) return [];
    let created: number | null = null;
    if (typeof row.created === "number") {
      created = row.created * 1000;
    } else if (row.created_at) {
      const time = Date.parse(row.created_at);
      created = Number.isNaN(time) ? null : time;
    }
    return [{ id, created }];
  });
}

export function isOfficialEndpoint(provider: ByokProvider, baseUrl: string) {
  try {
    return new URL(baseUrl).host === OFFICIAL_HOSTS[provider];
  } catch {
    return false;
  }
}

const MAX_MODEL_PAGES = 20;

/** Thrown when the endpoint answers 401 or 403 for the key. */
export class KeyRejectedError extends Error {
  constructor() {
    super("The endpoint rejected this API key");
    this.name = "KeyRejectedError";
  }
}

type ModelsProbe =
  | { kind: "listed"; models: ListedModel[] }
  /** No models route at this URL: a 404, or a reply that isn't a model list. */
  | { kind: "missing" }
  /** The route answered with another error, like a server error. */
  | { kind: "failed" };

function authHeaders(
  provider: ByokProvider,
  apiKey: string,
): Record<string, string> {
  return provider === "anthropic"
    ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" }
    : { Authorization: `Bearer ${apiKey}` };
}

/**
 * Reads `${baseUrl}/models`. Anthropic pages its list (20 per page by
 * default), so follow `has_more`.
 */
async function probeModels(input: {
  provider: ByokProvider;
  baseUrl: string;
  apiKey: string;
}): Promise<ModelsProbe> {
  const headers = authHeaders(input.provider, input.apiKey);
  const models: ListedModel[] = [];
  let afterId: string | null = null;

  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const url = new URL(`${input.baseUrl}/models`);
    if (input.provider === "anthropic") {
      url.searchParams.set("limit", "1000");
      if (afterId) url.searchParams.set("after_id", afterId);
    }

    let res: Response;
    try {
      res = await noRedirectFetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (reason) {
      if (reason instanceof EndpointRedirectError) throw reason;
      if (page > 0) break;
      const detail = reason instanceof Error ? reason.message : "unreachable";
      throw new Error(`Could not reach ${input.baseUrl} (${detail})`);
    }
    if (res.status === 401 || res.status === 403) throw new KeyRejectedError();
    if (!res.ok) {
      if (page > 0) break;
      return res.status === 404 ? { kind: "missing" } : { kind: "failed" };
    }

    let data: ModelPage;
    try {
      data = (await res.json()) as ModelPage;
    } catch {
      if (page > 0) break;
      return { kind: "missing" };
    }
    const rows = data.data ?? data.models;
    if (!Array.isArray(rows)) {
      if (page > 0) break;
      return { kind: "missing" };
    }
    models.push(...rowsToModels(rows));

    // OpenAI and xAI return everything in one page.
    if (!data.has_more || !data.last_id || data.last_id === afterId) break;
    afterId = data.last_id;
  }

  return { kind: "listed", models };
}

/**
 * Checks the key and finds the endpoint's model list. Providers often
 * document base URLs without "/v1", because the official Anthropic and
 * OpenAI SDKs add it, while Kru's SDKs expect it included. So when the URL
 * as given has no models route, retry with "/v1" and keep whichever URL
 * works. `missing` means no models route was found at either URL.
 */
export async function verifyByokKey(input: {
  provider: ByokProvider;
  baseUrl: string;
  apiKey: string;
}): Promise<{ baseUrl: string; models: ListedModel[]; missing: boolean }> {
  const direct = await probeModels(input);
  if (direct.kind === "listed") {
    return { baseUrl: input.baseUrl, models: direct.models, missing: false };
  }

  if (direct.kind === "missing" && !/\/v1$/i.test(input.baseUrl)) {
    const withV1 = `${input.baseUrl}/v1`;
    let retry: ModelsProbe;
    try {
      retry = await probeModels({ ...input, baseUrl: withV1 });
    } catch (reason) {
      if (reason instanceof KeyRejectedError || reason instanceof EndpointRedirectError) {
        throw reason;
      }
      retry = { kind: "missing" };
    }
    if (retry.kind === "listed") {
      return { baseUrl: withV1, models: retry.models, missing: false };
    }
    if (retry.kind === "failed") {
      // The route exists under /v1 even though it errored right now.
      return { baseUrl: withV1, models: [], missing: false };
    }
  }

  // A models route that errors still connects, so a flaky server isn't fatal.
  return {
    baseUrl: input.baseUrl,
    models: [],
    missing: direct.kind === "missing",
  };
}

/**
 * Models on the official OpenAI endpoint that cannot run a text agent:
 * embeddings, speech, image, video, moderation, and legacy completion-only
 * models.
 */
const OPENAI_NON_TEXT =
  /(embed|tts|whisper|transcribe|audio|realtime|dall-e|image|sora|video|moderation|babbage|davinci|instruct)/;

/**
 * Every usable model the endpoint lists, newest first when it reports
 * creation dates. Only the official OpenAI and xAI endpoints are filtered,
 * and only to drop non-text models.
 */
export function pickListedModels(
  provider: ByokProvider,
  baseUrl: string,
  listed: ListedModel[],
): string[] {
  const seen = new Set<string>();
  let models = listed.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });

  if (provider === "xai" && isOfficialEndpoint("xai", baseUrl)) {
    // xAI also lists image and video models the board cannot run on.
    models = models.filter(
      (model) =>
        model.id.startsWith("grok-") &&
        !/(image|imagine|video|vision)/.test(model.id),
    );
    if (!models.every((model) => model.created !== null)) {
      // Without creation dates, keep Kru's curated order (newest first).
      // "4.20" must not outrank "4.6", which a numeric string sort would do.
      const known = XAI_MODEL_ORDER;
      const rank = (id: string) => {
        const index = known.indexOf(id);
        return index === -1 ? known.length : index;
      };
      return models
        .map((model) => model.id)
        .sort((a, b) => rank(a) - rank(b) || b.localeCompare(a));
    }
  }

  if (provider === "openai" && isOfficialEndpoint("openai", baseUrl)) {
    models = models.filter((model) => !OPENAI_NON_TEXT.test(model.id));
  }

  if (models.length && models.every((model) => model.created !== null)) {
    models = [...models].sort(
      (a, b) => b.created! - a.created! || a.id.localeCompare(b.id),
    );
  }
  return models.map((model) => model.id);
}

export function buildByokConnection(input: {
  id: string;
  name: string;
  provider: ByokProvider;
  baseUrl: string;
  apiKey: string;
  models: string;
  listed: ListedModel[];
}): Connection {
  const custom = parseModelList(input.models);
  const listed = pickListedModels(input.provider, input.baseUrl, input.listed);
  let host = input.baseUrl;
  try {
    host = new URL(input.baseUrl).host;
  } catch {
    /* keep raw */
  }
  return {
    id: input.id,
    provider: input.provider,
    accessToken: input.apiKey,
    refreshToken: null,
    expiresAt: null,
    label: `${host} · ${keyHint(input.apiKey)}`,
    meta: {
      name: input.name,
      baseUrl: input.baseUrl,
      keyHint: keyHint(input.apiKey),
      // `listedModels` is what the endpoint offers; `models` is only a list
      // the user typed, which overrides it on the board.
      listedModels: listed.join(","),
      ...(custom.length ? { models: custom.join(",") } : {}),
    },
  };
}

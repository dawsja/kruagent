import type { ModelOption } from "./model-option";
import {
  isByokProvider,
  type ByokProvider,
  type ModelProvider,
} from "./types.ts";

export type ModelRef = { connectionId: string; modelId: string };

export const PROVIDER_NAMES: Record<ModelProvider, string> = {
  openai: "OpenAI API",
  anthropic: "Claude API",
  xai: "xAI API",
};

/** Icon key in `MODEL_PROVIDER_ICONS`. */
export const PROVIDER_ICON_IDS: Record<ModelProvider, string | undefined> = {
  openai: "openai",
  anthropic: "anthropic",
  xai: "xai",
};

export const BYOK_DEFAULT_BASE_URL: Record<ByokProvider, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  xai: "https://api.x.ai/v1",
};

/**
 * xAI text models, newest first. Used as xAI's default list and to order an
 * xAI model list that has no creation dates.
 */
export const XAI_MODEL_ORDER: readonly string[] = [
  "grok-4.6",
  "grok-4.5",
  "grok-4.3",
  "grok-4.20-reasoning",
  "grok-4.20-non-reasoning",
  "grok-latest",
];

export const BYOK_DEFAULT_MODELS: Record<ByokProvider, string[]> = {
  openai: [
    "gpt-5.4",
    "gpt-5.4-mini",
    "gpt-5.3-codex",
    "gpt-5.2",
    "gpt-5.1",
    "gpt-5-mini",
  ],
  anthropic: [
    "claude-fable-5-1",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
  ],
  xai: [...XAI_MODEL_ORDER],
};

/**
 * Claude Code in the box stands in for a connection: its models are picked
 * like any other, as `claude-code:modelId`, and a card with such a ref runs
 * on the CLI instead of the AI SDK. There is no connection row; the CLI is
 * signed in on its own, and the box says whether it is.
 */
export const CLAUDE_CODE_CONNECTION_ID = "claude-code";
export const CLAUDE_CODE_GROUP = "Claude Code";

/** The Claude models the CLI can run, under the person's own plan. */
export const CLAUDE_CODE_MODELS: readonly string[] = BYOK_DEFAULT_MODELS.anthropic;

/** True for a card model ref that runs on Claude Code. */
export function isClaudeCodeRef(ref: string | null | undefined) {
  const { connectionId, modelId } = parseModelRef(ref);
  return connectionId === CLAUDE_CODE_CONNECTION_ID && CLAUDE_CODE_MODELS.includes(modelId);
}

export function claudeCodeModelOptions(): ModelOption[] {
  return CLAUDE_CODE_MODELS.map((id, index) => ({
    id: formatModelRef(CLAUDE_CODE_CONNECTION_ID, id),
    name: prettyModelName(id),
    provider: CLAUDE_CODE_GROUP,
    providerId: PROVIDER_ICON_IDS.anthropic,
    description: id,
    badge: index === 0 ? "Default" : undefined,
    keywords: [id, "claude code", "cli", "anthropic", "subscription"],
  }));
}

/** Hosts of each format's own API. Filters and default lists apply only here. */
export const OFFICIAL_HOSTS: Record<ByokProvider, string> = {
  openai: "api.openai.com",
  anthropic: "api.anthropic.com",
  xai: "api.x.ai",
};

export const BYOK_FORMAT_NAMES: Record<ByokProvider, string> = {
  openai: "OpenAI-compatible",
  anthropic: "Anthropic-compatible",
  xai: "xAI",
};

export type ByokPreset = {
  id: string;
  name: string;
  format: ByokProvider;
  baseUrl: string;
  description: string;
  keyPlaceholder: string;
  /** Custom presets leave the name and URL to the user. */
  custom?: boolean;
};

/** Starting points for the add-endpoint flow. Every field stays editable. */
export const BYOK_PRESETS: readonly ByokPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1",
    description: "GPT and o-series models on a platform key.",
    keyPlaceholder: "sk-…",
  },
  {
    id: "anthropic",
    name: "Claude",
    format: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    description: "Claude models on an Anthropic console key.",
    keyPlaceholder: "sk-ant-…",
  },
  {
    id: "xai",
    name: "xAI",
    format: "xai",
    baseUrl: "https://api.x.ai/v1",
    description: "Grok models billed to an xAI API key.",
    keyPlaceholder: "xai-…",
  },
  {
    id: "minimax",
    name: "MiniMax",
    format: "anthropic",
    baseUrl: "https://api.minimax.io/anthropic",
    description: "MiniMax models through its Anthropic-compatible API.",
    keyPlaceholder: "MiniMax API key",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    description: "Models from many providers behind one key.",
    keyPlaceholder: "sk-or-…",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    format: "openai",
    baseUrl: "https://api.deepseek.com",
    description: "DeepSeek chat and reasoner models.",
    keyPlaceholder: "sk-…",
  },
  {
    id: "groq",
    name: "Groq",
    format: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    description: "Open models served fast on Groq.",
    keyPlaceholder: "gsk_…",
  },
  {
    id: "ollama",
    name: "Ollama",
    format: "openai",
    baseUrl: "http://localhost:11434/v1",
    description: "Models running on this machine.",
    keyPlaceholder: "Any value works",
  },
  {
    id: "custom-openai",
    name: "Custom OpenAI-compatible",
    format: "openai",
    baseUrl: "",
    description: "Any server that speaks the OpenAI chat API.",
    keyPlaceholder: "API key",
    custom: true,
  },
  {
    id: "custom-anthropic",
    name: "Custom Anthropic-compatible",
    format: "anthropic",
    baseUrl: "",
    description: "Any server that speaks the Anthropic Messages API.",
    keyPlaceholder: "API key",
    custom: true,
  },
];

/** A card's model: `connectionId:modelId`, naming the endpoint that runs it. */
export function formatModelRef(connectionId: string, modelId: string) {
  return `${connectionId}:${modelId}`;
}

const CONNECTION_ID = /^[A-Za-z0-9_-]+$/;

/** A ref without a valid connection id resolves to no connection. */
export function parseModelRef(ref: string | null | undefined): ModelRef {
  const raw = (ref ?? "").trim();
  const colon = raw.indexOf(":");
  if (colon > 0) {
    const connectionId = raw.slice(0, colon);
    const modelId = raw.slice(colon + 1);
    if (CONNECTION_ID.test(connectionId) && modelId) {
      return { connectionId, modelId };
    }
  }
  return { connectionId: "", modelId: raw };
}

export function modelLabel(ref: string | null | undefined) {
  return parseModelRef(ref).modelId || "No model";
}

export function prettyModelName(id: string) {
  let name = id.replace(/-\d{8}$/, "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (name.startsWith("claude-")) {
    // claude-opus-4-1 reads as Claude Opus 4.1, claude-3-5-sonnet as 3.5.
    name = name.replace(/(\d+)-(\d{1,2})(?=-|$)/g, "$1.$2");
  }
  return (
    name
      .replace(/-/g, " ")
      .replace(/^gpt /, "GPT-")
      .replace(/^chatgpt /, "ChatGPT ")
      .replace(/^claude /, "Claude ")
      .replace(/^grok /, "Grok ")
      // Capitalize plain words like mini or preview, but not ids like o3 or 4o.
      .replace(
        /\b([a-z])([a-z]{2,})\b/g,
        (_, first: string, rest: string) => first.toUpperCase() + rest,
      )
  );
}

export function parseModelList(value: string | null | undefined) {
  return [
    ...new Set(
      (value ?? "")
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

type ConnectionLike = {
  id?: string;
  provider: string;
  label?: string;
  meta?: Record<string, string>;
};

function hostnameOf(baseUrl: string | undefined) {
  try {
    return new URL(baseUrl ?? "").hostname;
  } catch {
    return "";
  }
}

/**
 * Display name for an API-key endpoint: the name it was given, the format's
 * name on its official host, or a name taken from the host.
 */
export function endpointName(connection: ConnectionLike) {
  const name = connection.meta?.name?.trim();
  if (name) return name;
  const provider = connection.provider;
  const host = hostnameOf(connection.meta?.baseUrl);
  if (isByokProvider(provider) && (!host || host === OFFICIAL_HOSTS[provider])) {
    return PROVIDER_NAMES[provider];
  }
  // api.minimax.io reads as Minimax.
  const label = host.replace(/^(api|www)\./, "").split(".")[0] ?? "";
  return label ? label[0].toUpperCase() + label.slice(1) : "API endpoint";
}

function byokOptions(
  provider: ByokProvider,
  connection: ConnectionLike,
): ModelOption[] {
  const host = hostnameOf(connection.meta?.baseUrl);
  const custom = parseModelList(connection.meta?.models);
  const listed = parseModelList(connection.meta?.listedModels);
  // Kru's default list only fits the format's own API. A custom server with no
  // list shows nothing rather than models it may not have.
  const defaults =
    !host || host === OFFICIAL_HOSTS[provider] ? BYOK_DEFAULT_MODELS[provider] : [];
  const ids = custom.length ? custom : listed.length ? listed : defaults;
  const connectionId = connection.id ?? provider;
  const group = endpointName(connection);
  return ids.map((id, index) => ({
    id: formatModelRef(connectionId, id),
    name: prettyModelName(id),
    provider: group,
    providerId: PROVIDER_ICON_IDS[provider],
    // Names drop snapshot dates, so show the exact id to tell them apart.
    description: id,
    badge: index === 0 ? "Default" : undefined,
    keywords: [id, group, provider, host, "byok", "api key"].filter(Boolean),
  }));
}

/**
 * Every model the board can pick from, across connections, with ids in
 * `connectionId:modelId` form so a run knows which connection to use.
 */
export function modelOptionsFor(
  connections: readonly ConnectionLike[],
): ModelOption[] {
  const options: ModelOption[] = [];
  for (const connection of connections) {
    const provider = connection.provider;
    if (isByokProvider(provider)) {
      options.push(...byokOptions(provider, connection));
    }
  }
  return options;
}

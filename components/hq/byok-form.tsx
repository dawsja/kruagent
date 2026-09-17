"use client";

import { Server } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  ModelPicker,
  type ModelPickerOption,
} from "@/components/hq/model-picker";
import {
  BYOK_FORMAT_NAMES,
  BYOK_PRESETS,
  type ByokPreset,
} from "@/lib/hq/models";
import { BYOK_PROVIDERS, type ByokProvider, type SubscriptionProvider } from "@/lib/hq/types";
import { cn } from "@/lib/utils";
import { SUBSCRIPTION_COPY, SubscriptionSignIn } from "./subscription-sign-in";

export const BYOK_COPY: Record<
  ByokProvider,
  { keyHelp: string; endpointHelp: string }
> = {
  openai: {
    keyHelp: "The key for this server. Ollama accepts any value.",
    endpointHelp:
      "The OpenAI-compatible base URL. Paste it with or without /v1.",
  },
  anthropic: {
    keyHelp: "The key for this server, sent in the x-api-key header.",
    endpointHelp:
      "The Anthropic-compatible base URL. Paste it with or without /v1.",
  },
  xai: {
    keyHelp:
      "A console.x.ai key, billed per token.",
    endpointHelp:
      "The xAI API base URL. Change it only for a proxy or regional endpoint.",
  },
};

/** An API-key endpoint as the browser sees it. The key never leaves Kru. */
export type ByokEndpoint = {
  id: string;
  provider: ByokProvider;
  label: string;
  meta: Record<string, string>;
};

const inputClass =
  "w-full rounded-xl border border-fog bg-paper-white px-3 py-2 text-[14px] text-carbon outline-none placeholder:text-ash focus:border-carbon";
const labelClass = "text-[12px] font-medium text-graphite";
const helpClass = "text-[12px] text-ash";

function hostnameOf(url: string) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Picker rows that sign in with a subscription instead of asking for a key. */
const SUBSCRIPTION_OPTIONS: { id: string; provider: SubscriptionProvider }[] = [
  { id: "chatgpt", provider: "openai" },
  { id: "supergrok", provider: "xai" },
];

/** Providers as picker rows: subscriptions first, then endpoints by API format. */
const PRESET_OPTIONS: ModelPickerOption[] = [
  ...SUBSCRIPTION_OPTIONS.map((item) => ({
    id: item.id,
    name: SUBSCRIPTION_COPY[item.provider].name,
    provider: "Subscriptions",
    providerId: item.provider,
    description: SUBSCRIPTION_COPY[item.provider].plans,
    badge: "Sign in",
    keywords: [item.id, item.provider, "subscription", "sign in", SUBSCRIPTION_COPY[item.provider].name],
  })),
  ...BYOK_PRESETS.map((item) => ({
    id: item.id,
    name: item.name,
    provider: BYOK_FORMAT_NAMES[item.format],
    providerId: item.custom ? undefined : item.id,
    description: item.custom ? "Your own server" : hostnameOf(item.baseUrl),
    badge: item.custom ? "Custom" : undefined,
    keywords: [item.id, item.name, BYOK_FORMAT_NAMES[item.format], item.baseUrl].filter(
      Boolean,
    ),
  })),
];

/**
 * Name, format, URL, key and models for one endpoint. Pass `preset` to add a
 * new endpoint or `endpoint` to edit one. Posts to /api/connect/byok, which
 * checks the key against the endpoint before saving.
 */
export function ByokEndpointForm({
  preset,
  endpoint,
  onSaved,
  onCancel,
}: {
  preset?: ByokPreset;
  endpoint?: ByokEndpoint;
  onSaved: (saved: { id: string }) => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(endpoint);
  const [provider, setProvider] = useState<ByokProvider>(
    endpoint?.provider ?? preset?.format ?? "openai",
  );
  const [name, setName] = useState(
    endpoint?.meta.name ?? (preset && !preset.custom ? preset.name : ""),
  );
  const [baseUrl, setBaseUrl] = useState(
    endpoint?.meta.baseUrl ?? preset?.baseUrl ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  // Older connections stored the endpoint's list in `models`. Prefill only a
  // list the user typed, so saving pulls a fresh list from the endpoint.
  const [models, setModels] = useState(
    endpoint && endpoint.meta.listedModels !== undefined
      ? (endpoint.meta.models?.replace(/,/g, ", ") ?? "")
      : "",
  );
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A named provider's preset fixes the format. Custom presets and edits can change it.
  const formatLocked = Boolean(preset && !preset.custom);
  const copy = BYOK_COPY[provider];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!baseUrl.trim()) {
      setError("Enter the endpoint URL.");
      return;
    }
    if (!apiKey.trim() && !editing) {
      setError("Paste an API key.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/connect/byok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: endpoint?.id,
          provider,
          name,
          baseUrl,
          apiKey,
          models,
        }),
      });
      const data = (await res.json()) as {
        error?: string;
        connection?: { id: string };
      };
      if (!res.ok || !data.connection) {
        setError(data.error ?? "Could not save this endpoint");
        return;
      }
      setApiKey("");
      onSaved(data.connection);
    } catch {
      setError("Could not reach Kru");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Name</span>
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={preset?.custom ? "My gateway" : "Shown in the model picker"}
          autoComplete="off"
          className={inputClass}
        />
      </label>

      {formatLocked ? null : (
        <div className="flex flex-col gap-1.5">
          <span className={labelClass}>API format</span>
          <div
            className="flex flex-wrap gap-2"
            role="radiogroup"
            aria-label="API format"
          >
            {BYOK_PROVIDERS.map((item) => (
              <button
                key={item}
                type="button"
                role="radio"
                aria-checked={provider === item}
                onClick={() => setProvider(item)}
                className={cn(
                  "rounded-full border px-3 py-1.5 text-[12px] font-medium",
                  provider === item
                    ? "border-carbon bg-carbon text-linen"
                    : "border-fog bg-transparent text-graphite hover:text-carbon",
                )}
              >
                {BYOK_FORMAT_NAMES[item]}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>Endpoint URL</span>
        <input
          type="url"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder={preset?.baseUrl || "https://example.com/v1"}
          autoComplete="off"
          spellCheck={false}
          className={inputClass}
        />
        <span className={helpClass}>{copy.endpointHelp}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>
          API key
          {endpoint?.meta.keyHint ? (
            <span className="ml-2 font-mono text-[11px] font-normal text-ash">
              saved {endpoint.meta.keyHint} · leave blank to keep
            </span>
          ) : null}
        </span>
        <div className="flex gap-2">
          <input
            type={showKey ? "text" : "password"}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={preset?.keyPlaceholder ?? "API key"}
            autoComplete="off"
            spellCheck={false}
            className={cn(inputClass, "font-mono")}
          />
          <button
            type="button"
            onClick={() => setShowKey((current) => !current)}
            className="shrink-0 rounded-xl border border-fog px-3 text-[12px] text-graphite"
          >
            {showKey ? "Hide" : "Show"}
          </button>
        </div>
        <span className={helpClass}>{copy.keyHelp}</span>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className={labelClass}>
          Models <span className="font-normal text-ash">(optional)</span>
        </span>
        <input
          type="text"
          value={models}
          onChange={(event) => setModels(event.target.value)}
          placeholder="Blank lists every model the endpoint offers"
          autoComplete="off"
          spellCheck={false}
          className={cn(inputClass, "font-mono text-[13px]")}
        />
        <span className={helpClass}>
          Comma-separated model ids, only if you want fewer than the endpoint
          lists or it has no model list.
        </span>
      </label>

      {error ? <p className="text-[13px] text-ember">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50"
        >
          {busy ? "Checking key…" : editing ? "Save changes" : "Add endpoint"}
        </button>
        {onCancel ? (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/**
 * Adding a connection: pick a subscription, a provider or a custom server
 * from a searchable dropdown, then sign in or fill in the form. Run it again
 * to add another, even on the same format.
 */
export function ByokSetupFlow({
  initialPresetId,
  onSaved,
  onCancel,
}: {
  initialPresetId?: string;
  onSaved: (saved: { id: string }) => void;
  onCancel?: () => void;
}) {
  const [presetId, setPresetId] = useState(
    PRESET_OPTIONS.some((item) => item.id === initialPresetId)
      ? (initialPresetId ?? "")
      : "",
  );
  const preset = BYOK_PRESETS.find((item) => item.id === presetId);
  const subscription = SUBSCRIPTION_OPTIONS.find((item) => item.id === presetId);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className={labelClass}>Provider</span>
        <ModelPicker
          models={PRESET_OPTIONS}
          value={presetId || undefined}
          onValueChange={setPresetId}
          placeholder="Pick a provider or custom server"
          emptyIcon={<Server className="size-4 text-muted-foreground" />}
          emptyTitle="No providers found"
          emptyHint="Try another name, or pick a custom server."
          searchPlaceholder="Search providers…"
          triggerLabel="Select provider"
          matchTriggerWidth
          side="bottom"
          align="start"
          className="w-full"
        />
        {preset ? <span className={helpClass}>{preset.description}</span> : null}
        {subscription ? (
          <span className={helpClass}>
            Runs count against your {SUBSCRIPTION_COPY[subscription.provider].name} plan, on this
            Kru only, under the provider&apos;s terms.
          </span>
        ) : null}
      </div>
      {subscription ? (
        <SubscriptionSignIn
          key={subscription.id}
          provider={subscription.provider}
          next={typeof window === "undefined" ? undefined : `${window.location.pathname}${window.location.search}`}
          onConnected={(id) => onSaved({ id })}
          onCancel={onCancel}
        />
      ) : preset ? (
        <ByokEndpointForm
          key={preset.id}
          preset={preset}
          onSaved={onSaved}
          onCancel={onCancel}
        />
      ) : onCancel ? (
        <div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
          >
            Cancel
          </button>
        </div>
      ) : null}
    </div>
  );
}

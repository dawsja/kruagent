"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ByokEndpointForm,
  ByokSetupFlow,
  type ByokEndpoint,
} from "@/components/hq/byok-form";
import { BotsSettings } from "@/components/hq/bots-settings";
import { HqHeader } from "@/components/hq/hq-header";
import { PasswordForm } from "@/components/hq/password-form";
import { SUBSCRIPTION_COPY, SubscriptionSignIn } from "@/components/hq/subscription-sign-in";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { ClaudeCheck } from "@/lib/hq/box";
import { BYOK_FORMAT_NAMES, endpointName, parseModelList } from "@/lib/hq/models";
import {
  SUBSCRIPTION_PROVIDERS,
  isByokProvider,
  isSubscriptionConnection,
  subscriptionConnectionId,
  type ConnectionProvider,
  type SubscriptionProvider,
} from "@/lib/hq/types";
import { cn } from "@/lib/utils";

type PublicConnection = {
  id: string;
  provider: string;
  label: string;
  connected: boolean;
  meta?: Record<string, string>;
};

/**
 * Where the Claude Code CLI in the box stands. `unreachable` is the box or
 * Kru's route not answering; the rest is what the box found by running it.
 */
type ClaudeState = ClaudeCheck | { status: "checking" | "unreachable"; detail: string };

function claudeHint(state: ClaudeState) {
  switch (state.status) {
    case "ok":
      return "To sign out or switch accounts, run `claude /logout` in the box desktop.";
    case "checking":
      return "Checking the box…";
    case "missing":
      return "The box image has no `claude` CLI. Update the box image and restart it.";
    case "unauthenticated":
      return "Not signed in yet. Open the box desktop, run `claude` in a terminal, and sign in; it's saved for future runs.";
    case "unreachable":
      return state.detail || "The box isn't reachable.";
    default:
      return state.detail ? `The CLI didn't answer cleanly: ${state.detail}` : "The CLI didn't answer cleanly.";
  }
}

export function SettingsPage() {
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [githubApp, setGithubApp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubWait, setGithubWait] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<SubscriptionProvider | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [claude, setClaude] = useState<ClaudeState>({ status: "checking", detail: "" });
  const router = useRouter();

  // One cheap request to the CLI in the box; it costs nothing when signed out.
  const checkClaude = useCallback(
    () =>
      fetch("/api/box/claude")
        .then(async (res) => {
          const data = (await res.json().catch(() => ({}))) as Partial<ClaudeCheck> & { error?: string };
          if (!res.ok || !data.status) {
            setClaude({ status: "unreachable", detail: data.error ?? `The box check failed (${res.status})` });
            return;
          }
          setClaude({ status: data.status, detail: data.detail ?? "" });
        })
        .catch(() => setClaude({ status: "unreachable", detail: "The box isn't reachable." })),
    [],
  );

  useEffect(() => {
    void checkClaude();
  }, [checkClaude]);

  const load = useCallback(
    () =>
      fetch("/api/onboarding")
        .then((res) => res.json())
        .then((data: { connections?: PublicConnection[]; githubApp?: boolean }) => {
          const list = data.connections ?? [];
          setConnections(list);
          setGithubApp(Boolean(data.githubApp));
          if (list.some((item) => item.provider === "github")) {
            setGithubWait(false);
          }
        }),
    [],
  );

  useEffect(() => {
    void load().then(() => {
      // A browser sign-in returns here with ?connected= or ?error=.
      const params = new URLSearchParams(window.location.search);
      const connected = params.get("connected");
      const failed = params.get("error");
      if (connected?.startsWith("sub_")) setNotice("Signed in. Its models are in the picker now.");
      if (failed) setError(failed);
      if (connected || failed) window.history.replaceState(null, "", window.location.pathname);
    });
  }, [load]);

  useEffect(() => {
    if (!githubWait) return;
    const timer = window.setInterval(() => {
      void load();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [githubWait, load]);

  const find = (provider: ConnectionProvider) =>
    connections.find((item) => item.provider === provider);

  const subscriptions = new Map(
    SUBSCRIPTION_PROVIDERS.map((provider) => [
      provider,
      connections.find((item) => item.id === subscriptionConnectionId(provider)),
    ]),
  );

  const endpoints: ByokEndpoint[] = connections.flatMap((item) =>
    isByokProvider(item.provider) && !isSubscriptionConnection(item)
      ? [
          {
            id: item.id,
            provider: item.provider,
            label: item.label,
            meta: item.meta ?? {},
          },
        ]
      : [],
  );

  async function disconnect(provider: ConnectionProvider) {
    setError(null);
    const res = await fetch(`/api/connect/${provider}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not disconnect");
      return;
    }
    await load();
  }

  async function signOut(provider: SubscriptionProvider) {
    setError(null);
    const res = await fetch(`/api/connect/subscription/${provider}`, { method: "DELETE" });
    if (!res.ok) {
      setError("Could not sign out");
      return;
    }
    await load();
  }

  async function removeEndpoint(endpoint: ByokEndpoint) {
    setError(null);
    const res = await fetch(
      `/api/connect/byok/${encodeURIComponent(endpoint.id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) {
      setError(`Could not remove ${endpointName(endpoint)}`);
      return;
    }
    if (editing === endpoint.id) setEditing(null);
    await load();
  }

  async function connectGithub() {
    setError(null);
    if (!githubApp) {
      setError("Create your GitHub App in setup first.");
      return;
    }
    const res = await fetch("/api/connect/github/start?next=/app/settings", {
      method: "POST",
    });
    const data = (await res.json()) as { error?: string; url?: string };
    if (!res.ok || !data.url) {
      setError(data.error ?? "Could not start GitHub login");
      return;
    }
    window.open(data.url, "_blank", "noopener,noreferrer");
    setGithubWait(true);
  }

  async function refreshModels(endpoint: ByokEndpoint) {
    const meta = endpoint.meta;
    setError(null);
    setRefreshing(endpoint.id);
    // A blank key keeps the stored one. Keep a typed model list, but not a
    // legacy auto list, so the endpoint's full list comes back.
    const res = await fetch("/api/connect/byok", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: endpoint.id,
        provider: endpoint.provider,
        name: meta.name ?? "",
        baseUrl: meta.baseUrl ?? "",
        apiKey: "",
        models: meta.listedModels !== undefined ? (meta.models ?? "") : "",
      }),
    });
    const data = (await res.json()) as { error?: string };
    setRefreshing(null);
    if (!res.ok) {
      setError(data.error ?? "Could not refresh models");
      return;
    }
    await load();
  }

  function modelCountLabel(meta: Record<string, string> = {}) {
    const custom = parseModelList(meta.models).length;
    const listed = parseModelList(meta.listedModels).length;
    if (meta.listedModels === undefined) {
      // Saved before Kru kept the endpoint's full list.
      return custom
        ? `${custom} models saved earlier. Refresh to list all.`
        : "Default model list";
    }
    if (custom) return `${custom} models you listed`;
    if (listed) return `${listed} models from the endpoint`;
    return "Endpoint lists no models, using defaults";
  }

  const github = find("github");

  return (
    <div className="flex min-h-dvh flex-col bg-linen text-carbon">
      <HqHeader />
      <main className="mx-auto flex w-full max-w-[720px] flex-1 flex-col gap-6 p-4 sm:p-8">
        <div>
          <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
            Settings
          </p>
          <h1 className="mt-2 text-[32px] font-semibold tracking-[-0.64px]">
            Connections
          </h1>
          <p className="mt-2 text-[15px] leading-6 text-graphite">
            Manage your subscriptions, API endpoints and GitHub. Every
            connection&apos;s models show up in the picker when you drop a card.
          </p>
        </div>
        {error ? <p className="text-[13px] text-ember">{error}</p> : null}
        {notice ? <p className="text-[13px] text-mint">{notice}</p> : null}

        <div>
          <h2 className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
            Subscriptions
          </h2>
          <p className="mt-1 text-[13px] text-graphite">
            Sign in with a plan you already pay for instead of an API key. Runs
            count against that plan and its limits, on this Kru only, under
            the provider&apos;s terms; a provider can change or withdraw this at
            any time.
          </p>
        </div>
        {/* Claude has no sign-in here on purpose: Anthropic's terms (February
            2026) forbid using a Claude subscription outside its own apps. A
            Claude plan is used through Anthropic's own CLI in the box instead;
            see the Claude Code card below. */}
        {SUBSCRIPTION_PROVIDERS.map((provider) => {
          const copy = SUBSCRIPTION_COPY[provider];
          const connection = subscriptions.get(provider);
          const open = signingIn === provider;
          return (
            <ConnectionCard
              key={provider}
              name={copy.name}
              description={copy.plans}
              connected={Boolean(connection)}
              label={connection?.label}
              waiting={false}
              waitHint=""
              connectLabel={open ? "Close" : connection ? "Reconnect" : "Sign in"}
              disconnectLabel="Sign out"
              onConnect={() => setSigningIn(open ? null : provider)}
              onDisconnect={() => void signOut(provider)}
            >
              {open ? (
                <div className="mt-4 border-t border-fog pt-4">
                  <SubscriptionSignIn
                    provider={provider}
                    next="/app/settings"
                    autoStart
                    onConnected={() => {
                      setSigningIn(null);
                      setNotice("Signed in. Its models are in the picker now.");
                      void load();
                    }}
                    onCancel={() => setSigningIn(null)}
                  />
                </div>
              ) : null}
            </ConnectionCard>
          );
        })}
        <ConnectionCard
          name="Claude Code"
          description="Your Claude plan through Anthropic's own `claude` CLI, running in the box. Sign in once from the box desktop and its models join the picker. Kru never sees your credentials, and usage bills to your own Anthropic plan."
          connected={claude.status === "ok"}
          label="Signed in on the box"
          waiting={claude.status !== "ok"}
          waitHint={claudeHint(claude)}
          connectLabel="Open box desktop"
          onConnect={() => router.push("/app?desktop=1")}
        >
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-fog pt-4">
            <button
              type="button"
              onClick={() => {
                setClaude({ status: "checking", detail: "" });
                void checkClaude();
              }}
              disabled={claude.status === "checking"}
              className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon disabled:opacity-50"
            >
              {claude.status === "checking" ? "Checking…" : "Check again"}
            </button>
            {claude.status === "ok" ? (
              <p className="text-[13px] text-graphite">{claudeHint(claude)}</p>
            ) : null}
          </div>
        </ConnectionCard>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
              API endpoints
            </h2>
            <p className="mt-1 text-[13px] text-graphite">
              Bring your own key. Add as many endpoints as you like, even
              several on the same format.
            </p>
          </div>
          {adding ? null : (
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setAdding(true);
              }}
              className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground"
            >
              Add endpoint
            </button>
          )}
        </div>
        {adding ? (
          <section className="rounded-2xl border border-fog bg-paper-white p-5">
            <h3 className="mb-4 text-[16px] font-medium tracking-[-0.32px]">
              Add an API endpoint
            </h3>
            <ByokSetupFlow
              onSaved={() => {
                setAdding(false);
                void load();
              }}
              onCancel={() => setAdding(false)}
            />
          </section>
        ) : null}
        {endpoints.length === 0 && !adding ? (
          <p className="rounded-2xl border border-dashed border-fog p-5 text-[13px] text-ash">
            No API endpoints yet.
          </p>
        ) : null}
        {endpoints.map((endpoint) => {
          const open = editing === endpoint.id;
          return (
            <ConnectionCard
              key={endpoint.id}
              name={endpointName(endpoint)}
              description={`${BYOK_FORMAT_NAMES[endpoint.provider]} · ${endpoint.meta.baseUrl ?? ""}`}
              connected
              label={endpoint.meta.keyHint ? `Key ${endpoint.meta.keyHint}` : undefined}
              waiting={false}
              waitHint=""
              connectLabel={open ? "Close" : "Edit"}
              disconnectLabel="Remove"
              onConnect={() => {
                setAdding(false);
                setEditing(open ? null : endpoint.id);
              }}
              onDisconnect={() => void removeEndpoint(endpoint)}
            >
              {open ? (
                <div className="mt-4 border-t border-fog pt-4">
                  <ByokEndpointForm
                    endpoint={endpoint}
                    onSaved={() => {
                      setEditing(null);
                      void load();
                    }}
                    onCancel={() => setEditing(null)}
                  />
                </div>
              ) : (
                <div className="mt-3 flex flex-wrap items-center gap-3 text-[13px] text-ash">
                  <span>{modelCountLabel(endpoint.meta)}</span>
                  <button
                    type="button"
                    onClick={() => void refreshModels(endpoint)}
                    disabled={refreshing === endpoint.id}
                    className="text-graphite underline-offset-2 hover:text-carbon hover:underline disabled:opacity-50"
                  >
                    {refreshing === endpoint.id ? "Refreshing…" : "Refresh models"}
                  </button>
                </div>
              )}
            </ConnectionCard>
          );
        })}

        <h2 className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
          Code
        </h2>
        <ConnectionCard
          name="GitHub"
          description="Repos Kru can read. Writes still go through a PR."
          connected={Boolean(github)}
          label={github?.label}
          waiting={githubWait}
          waitHint="Authorize Kru in the other tab."
          onConnect={() => void connectGithub()}
          onDisconnect={() => void disconnect("github")}
        />

        <h2 className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
          Bots
        </h2>
        <BotsSettings />
        <ClearTeamChat />

        <h2 className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
          Account
        </h2>
        <section className="rounded-2xl border border-fog bg-paper-white p-5">
          <h2 className="text-[16px] font-medium tracking-[-0.32px]">Change password</h2>
          <p className="mt-1 text-[14px] leading-6 text-graphite">
            Changing it signs out every other browser.
          </p>
          <PasswordForm />
        </section>
      </main>
    </div>
  );
}

/** Deletes every line in the Team room, after asking. */
function ClearTeamChat() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cleared, setCleared] = useState(false);

  async function clear() {
    setClearing(true);
    setError(null);
    const res = await fetch("/api/chat", { method: "DELETE" }).catch(() => null);
    setClearing(false);
    if (!res?.ok) {
      setError("Could not clear the team bot chat");
      return;
    }
    setConfirming(false);
    setCleared(true);
  }

  return (
    <section className="rounded-2xl border border-fog bg-paper-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-[16px] font-medium tracking-[-0.32px]">Clear team bot chat</h2>
          <p className="mt-1 text-[14px] leading-6 text-graphite">
            Deletes every message in the Team room, yours and the crew&apos;s. It can&apos;t be undone.
          </p>
          {cleared ? <p className="mt-2 text-[13px] text-mint">Team bot chat cleared.</p> : null}
          {error && !confirming ? <p className="mt-2 text-[13px] text-ember">{error}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => {
            setError(null);
            setCleared(false);
            setConfirming(true);
          }}
          className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-ember"
        >
          Clear team bot chat
        </button>
      </div>
      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (clearing) return;
          setConfirming(open);
          if (!open) setError(null);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="gap-5 rounded-2xl border border-fog bg-paper-white p-5 ring-0"
        >
          <DialogHeader className="gap-1">
            <DialogTitle className="text-[15px] tracking-[-0.32px] text-carbon">
              Clear team bot chat
            </DialogTitle>
            <DialogDescription className="text-[13px] text-graphite">
              Are you sure you want to clear all team bot chat?
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-[13px] text-ember">{error}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              disabled={clearing}
              className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void clear()}
              disabled={clearing}
              className="rounded-full bg-ember px-4 py-2 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {clearing ? "Clearing…" : "Clear chat"}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ConnectionCard({
  name,
  description,
  connected,
  label,
  waiting,
  waitHint,
  connectLabel,
  disconnectLabel,
  onConnect,
  onDisconnect,
  children,
}: {
  name: string;
  description: string;
  connected: boolean;
  label?: string;
  waiting: boolean;
  waitHint: string;
  connectLabel?: string;
  disconnectLabel?: string;
  onConnect: () => void;
  /** Left out when there is nothing to disconnect from here. */
  onDisconnect?: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-fog bg-paper-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[16px] font-medium tracking-[-0.32px]">
              {name}
            </h2>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 font-mono text-[10px] uppercase",
                connected
                  ? "bg-mint/15 text-mint"
                  : "bg-mist text-ash",
              )}
            >
              {connected ? "Connected" : "Off"}
            </span>
          </div>
          <p className="mt-1 text-[14px] leading-6 text-graphite">
            {description}
          </p>
          {connected && label ? (
            <p className="mt-2 truncate text-[13px] text-ash">{label}</p>
          ) : null}
          {waiting ? (
            <p className="mt-2 text-[13px] text-graphite">{waitHint}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onConnect}
            className="rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground"
          >
            {connectLabel ??
              (connected ? "Reconnect" : waiting ? "Open again" : "Connect")}
          </button>
          {connected && onDisconnect ? (
            <button
              type="button"
              onClick={onDisconnect}
              className="rounded-full border border-fog px-4 py-2 text-[13px] font-medium text-carbon"
            >
              {disconnectLabel ?? "Disconnect"}
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </section>
  );
}

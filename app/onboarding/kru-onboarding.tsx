"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BrandMark } from "@/components/landing/brand-mark";
import { KruBot } from "@/components/hq/kru-bot";
import {
  firstUnfinishedSection,
  SetupWizard,
  type SetupAnswers,
  type SetupField,
  type SetupSection,
} from "@/components/hq/setup-wizard";
import { getBot } from "@/lib/hq/bots/registry";
import { endpointName } from "@/lib/hq/models";
import { isByokProvider } from "@/lib/hq/types";

// Older versions saved setup answers, including "connected" marks, here.
const LEGACY_ANSWERS_KEY = "kru-onboarding-answers";

type PublicConnection = {
  id: string;
  provider: string;
  label: string;
  connected: boolean;
  meta?: Record<string, string>;
};

export function KruOnboarding({ initialError }: { initialError: string | null }) {
  const [connections, setConnections] = useState<PublicConnection[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const [githubAppRegistered, setGithubAppRegistered] = useState(false);

  function refreshConnections() {
    return fetch("/api/onboarding")
      .then((res) => res.json())
      .then((onboarding) => {
        setGithubAppRegistered(Boolean(onboarding.githubApp));
        setConnections((onboarding.connections ?? []) as PublicConnection[]);
      });
  }

  useEffect(() => {
    // Connection state comes only from the server. Saved marks from an older
    // version could outlive the data they described, so remove them.
    try {
      localStorage.removeItem(LEGACY_ANSWERS_KEY);
    } catch {
      /* storage unavailable */
    }
    void refreshConnections().then(() => setReady(true));
  }, []);

  // Every step of setup happens in this tab and comes back to it, so there is
  // nothing to poll for. Someone who opened GitHub in a tab of their own is
  // caught up when they come back to this one.
  useEffect(() => {
    if (!ready) return;
    const onFocus = () => void refreshConnections();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [ready]);

  async function registerKruGithubApp() {
    setError(null);
    const res = await fetch("/api/connect/github/register", { method: "POST" });
    const data = (await res.json()) as {
      error?: string;
      registered?: boolean;
      action?: string;
      manifest?: string;
    };
    if (!res.ok) {
      setError(data.error ?? "Could not register Kru");
      return;
    }
    if (data.registered) {
      // The app already exists, from a run of setup that stopped halfway.
      // There is nothing to create, so carry on to the half that is left.
      setGithubAppRegistered(true);
      await connectGithub();
      return;
    }
    if (data.action && data.manifest) {
      // In this tab: GitHub creates the app, hands the browser back to Kru,
      // and Kru sends it straight on to authorize and install. One trip.
      const form = document.createElement("form");
      form.method = "POST";
      form.action = data.action;
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = data.manifest;
      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
      form.remove();
    }
  }

  async function connectGithub() {
    setError(null);
    const res = await fetch("/api/connect/github/start?next=/onboarding", {
      method: "POST",
    });
    const data = (await res.json()) as { error?: string; url?: string };
    if (!res.ok || !data.url) {
      setError(data.error ?? "Could not start GitHub login");
      return;
    }
    window.location.href = data.url;
  }

  const github = connections.find((item) => item.provider === "github");

  const sections: SetupSection[] = useMemo(() => {
    const endpoints = connections.filter((item) =>
      isByokProvider(item.provider),
    );
    const subscribed = endpoints.filter((item) => item.id.startsWith("sub_"));
    const endpointsField: SetupField = {
      id: "byok",
      label: "Models",
      type: "connect",
      href: "/connect/byok?next=/onboarding",
      connected: endpoints.length > 0,
      connectedLabel:
        endpoints.length === 1
          ? `${subscribed.length ? "Subscription" : "API endpoint"} · ${endpointName(endpoints[0])}`
          : `${endpoints.length} connections`,
      placeholder: "Sign in or add an API endpoint",
      span: "full",
    };

    return [
      {
        id: "models",
        label: "Model",
        title: "Connect a model",
        description:
          "Sign in with a ChatGPT or SuperGrok subscription, or add an API endpoint with your own key: OpenAI, Claude, xAI, MiniMax, OpenRouter, Ollama, or any compatible server. Add one to continue and more later in Settings. Pick the model on the board when you drop a card.",
        fields: [
          endpointsField,
        ],
      },
      {
        id: "github",
        label: "GitHub",
        title: "Which repos can agents touch?",
        description:
          "Kru creates a private GitHub App for this server in your GitHub account. GitHub takes you through it in one pass: name the app, then choose the repos Kru may use — all of them, or just some — and authorize it. You land back here. Cards start on your most recently pushed repo; change it on the board.",
        fields: [
          // One button, because it is one trip. Creating the app carries
          // straight on to authorizing and installing it; the label only
          // changes when the app already exists and just needs connecting.
          {
            id: "github",
            label: githubAppRegistered
              ? "Install and authorize"
              : "Create your GitHub App",
            type: "connect",
            onConnect: githubAppRegistered
              ? () => {
                  void connectGithub();
                }
              : () => {
                  void registerKruGithubApp();
                },
            required: true,
            connected: Boolean(github),
            connectedLabel: github ? `Kru · ${github.label}` : "Kru connected",
            placeholder: githubAppRegistered
              ? "Connect GitHub"
              : "Create GitHub App on GitHub",
            span: "full",
          },
        ],
      },
      {
        id: "bots",
        label: "Bots",
        title: "Want to enable automated bots?",
        description:
          "Meet Pip. With bots on, the crew picks up every card you drop: Momo builds it, Kiko runs the checks, Lulu reviews the diff, Bibi writes it up. You only approve the pull request. Change it any time in Settings.",
        illustration: (
          <KruBot
            color={getBot("pip").color}
            size={120}
            expression="wink"
            label="Pip, the coordinator bot, winking hello"
          />
        ),
        fields: [
          {
            id: "bots",
            label: "Automated bots",
            type: "choice",
            required: true,
            options: [
              { value: "yes", label: "Yes, enable bots" },
              { value: "no", label: "Not now" },
            ],
            span: "full",
          },
        ],
      },
    ];
  }, [github, connections, connectGithub, githubAppRegistered, registerKruGithubApp]);

  async function complete(answers: SetupAnswers): Promise<boolean> {
    setError(null);
    const res = await fetch("/api/onboarding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bots: answers.bots === "yes" }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error ?? "Could not finish setup");
      return false;
    }
    if (!data.onboarding?.complete) {
      setError("Add a model endpoint and connect GitHub to finish setup.");
      return false;
    }
    window.location.href = "/app";
    return true;
  }

  if (!ready) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-linen text-ash">
        Loading setup…
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-linen text-carbon">
      <header className="flex items-center justify-between px-4 py-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2 text-[14px] font-medium">
          <BrandMark />
          Kru
        </Link>
        <span className="text-[13px] text-ash">Setup required</span>
      </header>
      {error ? (
        <p className="mx-auto max-w-3xl px-4 text-[13px] text-ember sm:px-6">
          {error}
        </p>
      ) : null}
      <SetupWizard
        initialStep={firstUnfinishedSection(sections)}
        heading="Set up Kru"
        subheading="Connect a model and GitHub, meet the crew. Then drop a card."
        sections={sections}
        submitLabel="Open the board"
        successTitle="Board is ready."
        successDescription="GitHub and a model are connected. Writes still wait for you."
        successCta={{ label: "Open board", href: "/app" }}
        onComplete={complete}
      />
    </div>
  );
}

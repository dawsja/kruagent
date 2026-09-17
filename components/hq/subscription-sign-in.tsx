"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import type { SubscriptionProvider } from "@/lib/hq/types";

export const SUBSCRIPTION_COPY: Record<
  SubscriptionProvider,
  { name: string; plans: string; signIn: string; codeHint: string }
> = {
  openai: {
    name: "ChatGPT",
    plans: "Plus, Pro, Business or Enterprise",
    signIn: "Sign in with ChatGPT",
    codeHint:
      "Codes must be allowed first: ChatGPT → Settings → Security → “Allow device code login”.",
  },
  xai: {
    name: "SuperGrok",
    plans: "SuperGrok or X Premium",
    signIn: "Sign in with X",
    codeHint: "xAI decides which subscriptions may sign in; a declined sign-in means yours isn't included yet.",
  },
};

type Phase =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "browser"; loginId: string; url: string }
  | { kind: "device"; loginId: string; userCode: string; verificationUrl: string }
  | { kind: "pasting"; loginId: string; url: string }
  | { kind: "done"; connectionId: string };

const inputClass =
  "w-full rounded-xl border border-fog bg-paper-white px-3 py-2 text-[14px] text-carbon outline-none placeholder:text-ash focus:border-carbon";
const linkClass = "text-graphite underline-offset-2 hover:text-carbon hover:underline";
const buttonClass = "rounded-full bg-brand px-4 py-2 text-[13px] font-medium text-brand-foreground disabled:opacity-50";

/**
 * Signs in with a subscription. ChatGPT opens a browser sign-in that returns
 * to Kru on its own; if it can't (Kru on another machine), a device code or
 * the pasted callback address finishes it. X only has the device code.
 * Kru polls the login's status while this is shown; the status call is also
 * what advances a device-code login.
 */
export function SubscriptionSignIn({
  provider,
  next,
  autoStart,
  onConnected,
  onCancel,
}: {
  provider: SubscriptionProvider;
  /** Same-site path the browser sign-in returns to. */
  next?: string;
  /** Begin at once instead of showing the sign-in button. */
  autoStart?: boolean;
  onConnected: (connectionId: string) => void;
  onCancel?: () => void;
}) {
  const copy = SUBSCRIPTION_COPY[provider];
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const query = next ? `?next=${encodeURIComponent(next)}` : "";

  async function start() {
    setError(null);
    setPhase({ kind: "starting" });
    if (provider !== "openai") {
      await startDevice();
      return;
    }
    const res = await fetch(`/api/connect/subscription/${provider}/start${query}`, { method: "POST" });
    const data = (await res.json()) as { error?: string; loginId?: string; url?: string };
    if (!res.ok || !data.loginId || !data.url) {
      setError(data.error ?? "Could not start the sign-in");
      setPhase({ kind: "idle" });
      return;
    }
    window.open(data.url, "_blank", "noopener,noreferrer");
    setPhase({ kind: "browser", loginId: data.loginId, url: data.url });
  }

  async function startDevice() {
    setError(null);
    setPhase({ kind: "starting" });
    const res = await fetch(`/api/connect/subscription/${provider}/device${query}`, { method: "POST" });
    const data = (await res.json()) as {
      error?: string;
      loginId?: string;
      userCode?: string;
      verificationUrl?: string;
    };
    if (!res.ok || !data.loginId || !data.userCode || !data.verificationUrl) {
      setError(data.error ?? "Could not start the sign-in");
      setPhase({ kind: "idle" });
      return;
    }
    setPhase({
      kind: "device",
      loginId: data.loginId,
      userCode: data.userCode,
      verificationUrl: data.verificationUrl,
    });
  }

  async function complete(loginId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/connect/subscription/${provider}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: pasted }),
      });
      const data = (await res.json()) as { error?: string; connection?: { id: string } };
      if (!res.ok || !data.connection) {
        setError(data.error ?? "The sign-in failed");
        return;
      }
      setPhase({ kind: "done", connectionId: data.connection.id });
      onConnected(data.connection.id);
    } catch {
      setError("Could not reach Kru");
    } finally {
      setBusy(false);
      void loginId;
    }
  }

  useEffect(() => {
    if (autoStart && !started.current) {
      started.current = true;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart]);

  // Poll while a sign-in is out with the person.
  const loginId =
    phase.kind === "browser" || phase.kind === "device" || phase.kind === "pasting" ? phase.loginId : null;
  useEffect(() => {
    if (!loginId) return;
    let stopped = false;
    const tick = async () => {
      const res = await fetch(`/api/connect/subscription/${provider}/status?login=${encodeURIComponent(loginId)}`);
      const data = (await res.json()) as { status?: string; error?: string; connectionId?: string };
      if (stopped) return;
      if (data.status === "done" && data.connectionId) {
        setPhase({ kind: "done", connectionId: data.connectionId });
        onConnected(data.connectionId);
      } else if (data.status === "error") {
        setError(data.error ?? "The sign-in failed");
        setPhase({ kind: "idle" });
      }
    };
    const timer = window.setInterval(() => void tick(), 2000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginId, provider]);

  return (
    <div className="flex flex-col gap-3">
      {phase.kind === "idle" || phase.kind === "starting" ? (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void start()} disabled={phase.kind === "starting"} className={buttonClass}>
            {phase.kind === "starting" ? "Starting…" : copy.signIn}
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
      ) : null}

      {phase.kind === "browser" ? (
        <div className="flex flex-col gap-2 text-[13px] text-graphite">
          <p>Finish signing in to {copy.name} in the other tab. This page updates on its own.</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href={phase.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Open the sign-in again
            </a>
            <button type="button" onClick={() => void startDevice()} className={linkClass}>
              Use a code instead
            </button>
            <button
              type="button"
              onClick={() => setPhase({ kind: "pasting", loginId: phase.loginId, url: phase.url })}
              className={linkClass}
            >
              Didn&apos;t come back? Paste the address
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === "pasting" ? (
        <div className="flex flex-col gap-2 text-[13px] text-graphite">
          <p>
            If the sign-in ended on a page that wouldn&apos;t load, copy that page&apos;s address (it starts
            with <span className="font-mono">http://localhost:1455/auth/callback</span>) and paste it here.
          </p>
          <div className="flex gap-2">
            <input
              type="url"
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="http://localhost:1455/auth/callback?code=…"
              autoComplete="off"
              spellCheck={false}
              className={cn(inputClass, "font-mono text-[13px]")}
            />
            <button type="button" onClick={() => void complete(phase.loginId)} disabled={busy || !pasted.trim()} className={cn(buttonClass, "shrink-0")}>
              {busy ? "Finishing…" : "Finish"}
            </button>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <a href={phase.url} target="_blank" rel="noopener noreferrer" className={linkClass}>
              Open the sign-in again
            </a>
            <button type="button" onClick={() => void startDevice()} className={linkClass}>
              Use a code instead
            </button>
          </div>
        </div>
      ) : null}

      {phase.kind === "device" ? (
        <div className="flex flex-col gap-2 text-[13px] text-graphite">
          <p>
            Open{" "}
            <a href={phase.verificationUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {phase.verificationUrl.replace(/^https?:\/\//, "")}
            </a>{" "}
            and enter this code. This page updates on its own once you approve.
          </p>
          <p className="font-mono text-[22px] tracking-[0.2em] text-carbon">{phase.userCode}</p>
          <p className="text-[12px] text-ash">{copy.codeHint}</p>
          {provider === "openai" ? (
            <button type="button" onClick={() => void start()} className={cn(linkClass, "self-start")}>
              Use the browser sign-in instead
            </button>
          ) : null}
        </div>
      ) : null}

      {phase.kind === "done" ? <p className="text-[13px] text-mint">Signed in.</p> : null}
      {error ? <p className="text-[13px] text-ember">{error}</p> : null}
    </div>
  );
}

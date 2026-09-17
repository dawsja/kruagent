"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { BrandMark } from "@/components/landing/brand-mark";
import { ByokSetupFlow } from "@/components/hq/byok-form";

export function ByokConnect() {
  const params = useSearchParams();
  const presetId = params.get("provider") ?? undefined;
  const target = params.get("next") ?? "/onboarding";
  const next = target.startsWith("/") ? target : "/onboarding";

  return (
    <div className="flex min-h-dvh flex-col bg-linen text-carbon">
      <header className="flex items-center gap-2 px-4 py-4 sm:px-8">
        <BrandMark />
        <span className="text-[14px] font-medium">Kru</span>
      </header>
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-4 pb-24">
        <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
          Connect a model
        </p>
        <h1 className="mt-3 text-[32px] font-semibold tracking-[-0.64px]">
          Sign in or add an API endpoint
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-graphite">
          Sign in with a ChatGPT or SuperGrok plan, or pick a provider or any
          compatible server and paste a key. Kru checks the key, keeps it in
          the local store, and never shows it again. Add more from Settings.
        </p>
        <div className="mt-6 rounded-2xl border border-fog bg-paper-white p-5">
          <ByokSetupFlow
            initialPresetId={presetId}
            onSaved={(saved) => {
              const url = new URL(next, window.location.origin);
              url.searchParams.set("connected", saved.id);
              window.location.href = `${url.pathname}${url.search}`;
            }}
          />
        </div>
        <Link
          href={next}
          className="mt-6 text-[13px] text-ash hover:text-carbon"
        >
          Back
        </Link>
      </main>
    </div>
  );
}

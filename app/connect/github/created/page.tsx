import Link from "next/link";
import { connection } from "next/server";
import { BrandMark } from "@/components/landing/brand-mark";
import { requirePageSession } from "@/lib/auth/guard";

/**
 * Only reached when creating the GitHub App failed. A successful creation
 * carries straight on to authorizing and installing it, so there is no page
 * in between to read.
 */
export default async function GithubAppCreatedPage({
  searchParams,
}: PageProps<"/connect/github/created">) {
  await connection();
  await requirePageSession("/connect/github/created");
  const { error } = await searchParams;
  return (
    <div className="flex min-h-dvh flex-col bg-linen text-carbon">
      <header className="flex items-center gap-2 px-4 py-4 sm:px-8">
        <BrandMark />
        <span className="text-[14px] font-medium">Kru</span>
      </header>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col justify-center px-4 pb-24">
        <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">
          GitHub
        </p>
        <h1 className="mt-3 text-[32px] font-semibold tracking-[-0.64px]">
          GitHub setup failed
        </h1>
        <p className="mt-3 text-[15px] leading-6 text-graphite">
          {error ??
            "The GitHub App was not created. Nothing was saved, so you can start again."}
        </p>
        <Link
          href="/onboarding"
          className="mt-8 inline-flex h-11 w-fit items-center rounded-full bg-brand px-5 text-[14px] font-medium text-brand-foreground"
        >
          Back to setup
        </Link>
      </main>
    </div>
  );
}

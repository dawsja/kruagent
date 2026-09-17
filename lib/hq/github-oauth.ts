import { randomBytes } from "node:crypto";
import { getOnboarding, getStoredGithubApp } from "./data";
import { appUrl } from "./oauth";
import type { GithubApp } from "./types";

const ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
] as const;

const holder = globalThis as typeof globalThis & { __kruGithubEnvWarned?: boolean };

/**
 * The GitHub App this server uses: one given entirely through the four
 * GITHUB_* variables, or the one created from the setup page. A partial set of
 * variables is ignored with a warning rather than half-working.
 */
export async function getKruGithubApp(): Promise<GithubApp | null> {
  const present = ENV_KEYS.filter((key) => process.env[key]);
  if (present.length === ENV_KEYS.length) {
    return {
      appId: Number(process.env.GITHUB_APP_ID),
      slug: process.env.GITHUB_APP_SLUG!,
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    };
  }
  if (present.length > 0 && !holder.__kruGithubEnvWarned) {
    holder.__kruGithubEnvWarned = true;
    console.warn(
      `[kru] Ignoring ${present.join(", ")}. Set all of ${ENV_KEYS.join(", ")} to use a GitHub App from the environment.`,
    );
  }
  return getStoredGithubApp();
}

/** GitHub App names are unique across GitHub, so suggest one nobody has. */
export function suggestedAppName() {
  return `Kru-${randomBytes(3).toString("hex")}`;
}

/**
 * The manifest for this server's own private GitHub App. The user can rename
 * it on GitHub's page before creating it. Authorization happens after install
 * through Kru's own flow, so GitHub always returns to the setup URL.
 *
 * Permissions here only shape a new app. An app created before a permission
 * was added keeps its old set until the person adds it on GitHub and accepts
 * it on the installation; Settings points there when a read is refused.
 */
export function githubAppManifest(name = suggestedAppName()) {
  const url = appUrl();
  return {
    name,
    url,
    description:
      "Self-hosted Kru. Agents read the repos you grant and propose pull requests you approve.",
    redirect_url: `${url}/api/connect/github/manifest`,
    callback_urls: [`${url}/api/connect/github/callback`],
    setup_url: `${url}/api/connect/github/setup`,
    public: false,
    request_oauth_on_install: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      // Reading CI results on the pull requests Kru opened.
      checks: "read",
      // Labelled issues become cards; Kru comments when their PR opens.
      issues: "write",
      metadata: "read",
    },
  };
}

/** Where the manifest form is posted. GitHub returns `state` with the code. */
export function githubManifestAction(state: string) {
  const url = new URL("https://github.com/settings/apps/new");
  url.searchParams.set("state", state);
  return url.toString();
}

export function githubAuthorizeUrl(clientId: string, state: string, verifierChallenge: string) {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", `${appUrl()}/api/connect/github/callback`);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", verifierChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export function githubInstallUrl(slug: string) {
  return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new`;
}

/**
 * Where GitHub hands the browser back when Kru started the trip itself, with
 * no `next` of its own to return to: setup while it is unfinished, the board
 * once it is done.
 */
export function githubReturnPath() {
  return getOnboarding()?.complete ? "/app" : "/onboarding";
}

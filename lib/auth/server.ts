import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { nextCookies } from "better-auth/next-js";
import { username } from "better-auth/plugins/username";
import { ensureKruDatabase } from "@/lib/db/init";
import { dbPath } from "@/lib/db/sqlite";
import { appUrl } from "@/lib/hq/oauth";
import { derivedAuthSecret } from "@/lib/hq/secrets";
import { trustedOriginsFor } from "./origins";
import { ensureSetupToken } from "./setup-token";

function countUsersNow(): number {
  const row = ensureKruDatabase().prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
  return Number(row.n);
}

function buildOptions() {
  return {
    appName: "Kru",
    database: ensureKruDatabase(),
    baseURL: appUrl(),
    secret: process.env.BETTER_AUTH_SECRET || derivedAuthSecret(),
    trustedOrigins: (request?: Request) => trustedOriginsFor(request),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      maxPasswordLength: 256,
      autoSignIn: true,
    },
    // Accounts are only created by the register page's server action, which
    // checks the setup token. The public HTTP sign-up route answers 404.
    disabledPaths: ["/sign-up/email"],
    plugins: [username(), nextCookies()],
    advanced: {
      useSecureCookies: appUrl().startsWith("https://"),
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/username": { window: 60, max: 5 },
        "/change-password": { window: 60, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async () => {
            if (countUsersNow() > 0) {
              throw new APIError("FORBIDDEN", { message: "Registration is closed" });
            }
          },
        },
      },
    },
  };
}

function createAuth(options: ReturnType<typeof buildOptions>) {
  return betterAuth(options);
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = NonNullable<Awaited<ReturnType<Auth["api"]["getSession"]>>>;

type AuthCache = { key: string; ready: Promise<Auth> };
const holder = globalThis as typeof globalThis & { __kruAuth?: AuthCache };

/**
 * Better Auth for this data directory, created once per process after its
 * tables are migrated. While no account exists, the setup token is issued and
 * printed to the logs. The database trigger backs up the one-account rule even
 * if two registrations race.
 */
export function getAuth(): Promise<Auth> {
  const key = dbPath();
  if (holder.__kruAuth?.key === key) return holder.__kruAuth.ready;

  const ready = (async () => {
    const options = buildOptions();
    const { runMigrations } = await getMigrations(options);
    await runMigrations();
    ensureKruDatabase().exec(
      `CREATE TRIGGER IF NOT EXISTS kru_single_user BEFORE INSERT ON "user"
       WHEN (SELECT COUNT(*) FROM "user") >= 1
       BEGIN SELECT RAISE(ABORT, 'registration closed'); END;`,
    );
    const auth = createAuth(options);
    if (countUsersNow() === 0) ensureSetupToken();
    return auth;
  })();

  holder.__kruAuth = { key, ready };
  ready.catch(() => {
    if (holder.__kruAuth?.ready === ready) holder.__kruAuth = undefined;
  });
  return ready;
}

/** How many accounts exist (0 or 1). Waits for auth tables to exist. */
export async function countAccounts(): Promise<number> {
  await getAuth();
  return countUsersNow();
}

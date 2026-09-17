/**
 * Runs once when a Kru server starts: opens the database, applies
 * migrations, imports an old data/kru.json, marks runs a restart
 * interrupted, and prepares login. While no account exists, the setup token
 * is printed here. Skipped while `next build` runs.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  const { ensureKruDatabase } = await import("./lib/db/init");
  ensureKruDatabase();
  const { getAuth } = await import("./lib/auth/server");
  await getAuth();
  // The crew: picks up dropped cards and answers the Team room, when on.
  const { startBotDispatcher } = await import("./lib/hq/bots/dispatcher");
  startBotDispatcher();
  // A ChatGPT sign-in returns to http://localhost:1455/auth/callback, an
  // address OpenAI fixed. Outside Docker (which maps the port), answer there.
  const { configuredCallbackPort, startOAuthCallbackListener } = await import("./lib/hq/oauth-listener");
  const port = configuredCallbackPort();
  if (port) await startOAuthCallbackListener({ port });
}

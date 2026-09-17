/**
 * A tiny HTTP listener on port 1455 for installs that don't run in Docker.
 * OpenAI returns a ChatGPT sign-in to http://localhost:1455/auth/callback,
 * an address fixed by its client registration. This listener only forwards
 * that one path to Kru's own address; everything else is a 404. Docker
 * installs publish port 1455 straight to Kru instead and don't need it.
 */
import http from "node:http";
import { OPENAI_OAUTH_CALLBACK_PORT } from "./openai-oauth.ts";

/** The port to listen on, or 0 when the listener is turned off. */
export function configuredCallbackPort(env: Record<string, string | undefined> = process.env) {
  const raw = env.KRU_OAUTH_CALLBACK_PORT;
  if (raw === undefined || raw === "") return OPENAI_OAUTH_CALLBACK_PORT;
  if (/^(0|off|false|no)$/i.test(raw.trim())) return 0;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : OPENAI_OAUTH_CALLBACK_PORT;
}

/** Where a request to the listener is sent on, or null when it isn't the callback. */
export function callbackRedirect(appUrl: string, requestUrl: string | undefined, method: string | undefined) {
  if (method !== "GET" && method !== "HEAD") return null;
  const url = new URL(requestUrl ?? "/", "http://localhost");
  if (url.pathname !== "/auth/callback") return null;
  return `${appUrl.replace(/\/$/, "")}/auth/callback${url.search}`;
}

export async function startOAuthCallbackListener(options: {
  port: number;
  host?: string;
  appUrl?: string;
}): Promise<http.Server | null> {
  const appUrl = options.appUrl ?? process.env.APP_URL ?? "http://localhost:3000";
  const host = options.host ?? process.env.HOSTNAME ?? "127.0.0.1";
  // When Kru itself already answers on this port, its own route serves the callback.
  if (Number(process.env.PORT) === options.port) return null;

  const server = http.createServer((request, response) => {
    const target = callbackRedirect(appUrl, request.url, request.method);
    if (target) {
      response.writeHead(302, { Location: target, "Cache-Control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  });

  return new Promise((resolve) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        console.warn(
          `[kru] port ${options.port} is busy (a Codex CLI login?), so a ChatGPT sign-in must use a device code or a pasted address.`,
        );
      } else {
        console.warn(`[kru] could not listen on port ${options.port} for sign-in callbacks: ${error.message}`);
      }
      resolve(null);
    });
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      console.info(`[kru] sign-in callback listener on http://${host}:${port}/auth/callback`);
      resolve(server);
    });
  });
}

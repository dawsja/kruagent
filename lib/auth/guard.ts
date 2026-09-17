import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import { trustedOriginsFor } from "./origins";
import { getAuth, type Session } from "./server";

export type { Session };

/** The signed-in session for these headers, or null. */
export async function getSession(requestHeaders?: Headers): Promise<Session | null> {
  // Read the request first. On a page this marks rendering as per-request
  // before auth (and the database) is touched, so builds never open it.
  const source = requestHeaders ?? (await headers());
  const auth = await getAuth();
  return auth.api.getSession({ headers: source });
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Blocks cross-site state-changing requests. Browsers send Origin on these;
 * when it's missing, only an explicit same-origin Fetch Metadata header passes.
 */
export function isSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (origin) return trustedOriginsFor(request).includes(origin);
  return request.headers.get("sec-fetch-site") === "same-origin";
}

type Handler<C> = (
  request: Request,
  context: C,
  session: Session,
) => Promise<Response> | Response;

/**
 * Wraps a route handler so it only runs for the signed-in owner. JSON routes
 * answer 401 without a session; browser navigations (like GitHub redirects)
 * go to /login and come back afterwards. Unsafe methods must be same-origin.
 */
export function withSession<C = unknown>(
  handler: Handler<C>,
  options: { navigation?: boolean } = {},
) {
  return async (request: Request, context: C): Promise<Response> => {
    if (UNSAFE_METHODS.has(request.method) && !isSameOrigin(request)) {
      return NextResponse.json({ error: "Cross-site request blocked" }, { status: 403 });
    }
    const session = await getSession(request.headers);
    if (!session) {
      if (options.navigation) {
        const here = new URL(request.url);
        const login = new URL("/login", request.url);
        login.searchParams.set("next", `${here.pathname}${here.search}`);
        return NextResponse.redirect(login);
      }
      return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
    }
    return handler(request, context, session);
  };
}

/** For server-rendered pages: the session, or a redirect to /login. */
export async function requirePageSession(next: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(next)}`);
  return session;
}

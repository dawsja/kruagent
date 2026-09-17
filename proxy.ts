import { getSessionCookie } from "better-auth/cookies";
import { NextResponse, type NextRequest } from "next/server";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);
// /auth/callback is where a ChatGPT sign-in returns; it arrives with no
// cookies and proves itself with a one-time state instead.
const PUBLIC_PATH = /^\/(login|register|api\/auth|auth\/callback)(\/|$)/;

function portOf(url: URL) {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

/**
 * Browsers treat localhost, 127.0.0.1 and 0.0.0.0 as different sites, so the
 * login and OAuth state cookies from one aren't sent to another. A page load
 * on a different loopback name for the same port as APP_URL (for example a
 * GitHub callback that returns to 0.0.0.0) is sent to APP_URL's host instead.
 */
function loopbackRedirect(request: NextRequest) {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const host = request.headers.get("host");
  if (!host) return null;
  let app: URL;
  let current: URL;
  try {
    app = new URL(process.env.APP_URL ?? "http://localhost:3000");
    current = new URL(`${app.protocol}//${host}`);
  } catch {
    return null;
  }
  if (current.hostname === app.hostname) return null;
  if (!LOOPBACK_HOSTS.has(current.hostname) || !LOOPBACK_HOSTS.has(app.hostname)) {
    return null;
  }
  if (portOf(current) !== portOf(app)) return null;
  const { pathname, search } = request.nextUrl;
  return NextResponse.redirect(new URL(`${pathname}${search}`, app.origin));
}

/**
 * Optimistic gate. Requests without a session cookie get a 401 (API) or a
 * redirect to /login (pages). This only checks that a cookie exists; every
 * route handler and page still verifies the session itself.
 */
export function proxy(request: NextRequest) {
  const redirect = loopbackRedirect(request);
  if (redirect) return redirect;

  const { pathname, search } = request.nextUrl;
  if (PUBLIC_PATH.test(pathname) || getSessionCookie(request)) {
    return NextResponse.next();
  }
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Sign in to continue" }, { status: 401 });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.png|logo\\.png|robots\\.txt|api/health).*)",
  ],
};

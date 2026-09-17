import { appUrl } from "@/lib/hq/oauth";

/**
 * Origins allowed to send state-changing requests: the `APP_URL` origin, plus
 * the origin the browser actually used for this request. A cross-site page
 * can't make a victim's browser send a matching Host header, so accepting it
 * keeps CSRF protection while letting Kru work on another port or LAN address.
 */
export function trustedOriginsFor(request?: Request | Headers): string[] {
  const origins = new Set<string>([new URL(appUrl()).origin]);
  const headers = request instanceof Headers ? request : request?.headers;
  const host = headers?.get("x-forwarded-host") ?? headers?.get("host");
  if (host) {
    const fromUrl =
      request && !(request instanceof Headers) ? new URL(request.url).protocol : null;
    const proto =
      headers?.get("x-forwarded-proto") ??
      (fromUrl ?? new URL(appUrl()).protocol).replace(":", "");
    origins.add(`${proto}://${host}`);
  }
  return [...origins];
}

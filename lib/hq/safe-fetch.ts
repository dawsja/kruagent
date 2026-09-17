/** An endpoint answered with a redirect, which Kru refuses to follow. */
export class EndpointRedirectError extends Error {
  constructor(location: string | null) {
    super(
      `The endpoint redirected${location ? ` to ${location.slice(0, 120)}` : ""}. Use its final URL instead.`,
    );
    this.name = "EndpointRedirectError";
  }
}

/**
 * `fetch` that never follows redirects. API keys travel in request headers,
 * so following a redirect could hand a key to a different server.
 */
export const noRedirectFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await fetch(input, { ...init, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new EndpointRedirectError(res.headers.get("location"));
  }
  return res;
}) as typeof fetch;

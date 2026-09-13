/** Public origins only: never derive marketing links from the current request. */
export function validatePublicOrigin(
  value: string,
  name: string,
  allowLoopback = process.env.NODE_ENV === "development",
): string {
  const invalid = () => new Error(`${name} must be an HTTPS origin without credentials, a path, query, or fragment (loopback is allowed only in development).`);

  // Check the original spelling too: URL parsing normalizes dot paths, empty
  // query strings, backslashes, and whitespace that should not be configuration.
  if (value !== value.trim() || !/^https?:\/\/[^@/?#\\\s]+\/?$/i.test(value)) throw invalid();

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }

  const hostname = url.hostname.replace(/\.$/, "");
  const loopback = hostname === "localhost" || hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname);
  if (
    url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
    (loopback ? !allowLoopback : url.protocol !== "https:")
  ) throw invalid();

  return url.origin;
}

export const SITE_URL = validatePublicOrigin(
  process.env.NEXT_PUBLIC_SITE_URL || "https://firstlight.build",
  "NEXT_PUBLIC_SITE_URL",
);

export const COMPOSE_URL = validatePublicOrigin(
  process.env.NEXT_PUBLIC_COMPOSE_URL || "https://app.firstlight.build",
  "NEXT_PUBLIC_COMPOSE_URL",
);

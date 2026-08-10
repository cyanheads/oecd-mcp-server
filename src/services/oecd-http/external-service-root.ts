/**
 * @fileoverview Validation for the OECD service root a catalog entry delegates
 * to — the one place an upstream-supplied URL is allowed to influence where
 * this server sends a request.
 * @module services/oecd-http/external-service-root
 */

/**
 * The path shape an external dataflow href is allowed to carry:
 * `/{service}/rest/dataflow/…`, where `{service}` is the segment naming the
 * owning service (`sti-public`, `dcd-public`, `archive`).
 *
 * Only that one segment is read. Everything after it is discarded and every
 * request path is rebuilt from identifiers this server has already validated,
 * so the href acts as a hint about *where* a structure lives rather than a
 * request to replay.
 */
const EXTERNAL_DATAFLOW_PATH = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)\/rest\/dataflow\//;

/**
 * Read the service root out of an `rel: external` href published on a dataflow
 * entry, or return undefined when the href is not one this server will follow.
 *
 * The href arrives inside an upstream response body, which makes an unchecked
 * `fetch(href)` a server-side request forgery: whoever can shape that body can
 * choose the host this server talks to. Three constraints close that off, and
 * an href failing any of them resolves to undefined so the caller degrades to
 * reporting the structure as unreachable.
 *
 * 1. The origin must equal the configured base URL's origin exactly — same
 *    scheme, host, and port. OECD's own delegation never leaves `sdmx.oecd.org`,
 *    so a cross-origin href is either a catalog change worth re-reviewing or an
 *    attempt to redirect the server, and neither should be followed silently.
 * 2. The scheme must be `https`. Origin equality already pins it to whatever
 *    the base URL uses; requiring https on top means a base URL configured over
 *    plaintext delegates nowhere at all rather than widening the surface.
 * 3. The path must match the SDMX dataflow shape above, and only its leading
 *    service segment survives into the returned root.
 *
 * The origin pinned here is the origin the request reaches only because
 * `fetchOecd` issues every request with `redirect: 'manual'` and refuses a 3xx
 * outright: a host allowed to redirect could hand the request to any other one
 * after this check has passed. The two rules are a pair — neither is worth much
 * loosened on its own.
 */
export function externalServiceRoot(href: unknown, baseUrl: string): string | undefined {
  if (typeof href !== 'string') return;

  let target: URL;
  let base: URL;
  try {
    target = new URL(href);
    base = new URL(baseUrl);
  } catch {
    return;
  }

  if (target.protocol !== 'https:') return;
  if (target.origin !== base.origin) return;

  const service = EXTERNAL_DATAFLOW_PATH.exec(target.pathname)?.[1];
  if (service === undefined) return;

  return `${target.origin}/${service}/rest`;
}

/**
 * Read the service root a dataflow response delegates to.
 *
 * OECD publishes the delegation as a `links[]` entry with `rel: "external"` on
 * the dataflow entry itself, alongside `isExternalReference: true` and an
 * absent `structure` URN. The first link that survives {@link externalServiceRoot}
 * wins; a response carrying none resolves to undefined.
 */
export function externalServiceRootOf(data: unknown, baseUrl: string): string | undefined {
  const root = data as { data?: { dataflows?: unknown } } | undefined;
  const dataflows = (root?.data?.dataflows ?? []) as Array<Record<string, unknown>>;
  const links = (dataflows[0]?.links ?? []) as Array<Record<string, unknown>>;

  for (const link of links) {
    if (link.rel !== 'external') continue;
    const resolved = externalServiceRoot(link.href, baseUrl);
    if (resolved) return resolved;
  }
  return;
}

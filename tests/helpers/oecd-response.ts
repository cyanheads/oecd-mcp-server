/**
 * @fileoverview Structure responses as OECD sends them, caching headers
 * included. The structure cache keeps a response only for the lifetime its
 * `cache-control` grants, so a test that reads a fixture twice through a
 * definition needs OECD's real headers to see the second read served from it.
 * @module tests/helpers/oecd-response
 */

/** A `200` SDMX-JSON body under the `cache-control` OECD sends on the catalog and on every definition. */
export function cacheableJson(body: unknown): Response {
  return Response.json(body, { headers: { 'cache-control': 'public,max-age=86400' } });
}

/** What OECD answers the dataflow route for an id it does not publish. */
export function noResultsFound(): Response {
  return new Response('No Results Found', {
    status: 404,
    headers: { 'cache-control': 'no-cache,no-store', 'content-type': 'text/plain' },
  });
}

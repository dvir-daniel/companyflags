// What Settings → CDN (cdn.tsx) reads from a publish besides its components. Apart from the page so that an edit to
// its components swaps in place.

/** The Cloudflare plugin's id (server/plugins/cloudflare.ts). */
const CLOUDFLARE = 'cloudflare';
/** One plugin's failure in a publish's error: "<plugin id>: <what went wrong>", ids as server/plugin.ts allows them. */
const FAILURE = /(?:^|; )([a-z][a-z0-9-]*): (.*?)(?=; [a-z][a-z0-9-]*: |$)/gs;

/**
 * Why Cloudflare didn't purge after a publish, or null. After a publish each plugin's onPublish runs; the ones that
 * fail are kept on the publish together, as "purge: cloudflare: Cloudflare said 500; <other plugin>: …"
 * (server/workers.ts, server/plugin.ts publishHooks). Only the Cloudflare plugin's is the CDN's: what it said, without
 * the prefixes. Another plugin's failure isn't Cloudflare's.
 */
export function cloudflareFailure(error: string | null | undefined): string | null {
  const rest = error?.match(/^(?:purge|after publishing): (.*)$/s)?.[1];
  if (!rest) return null;
  for (const [, plugin, said] of rest.matchAll(FAILURE)) if (plugin === CLOUDFLARE) return said.trim() || 'Cloudflare didn’t say why.';
  return null;
}

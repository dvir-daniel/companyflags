// After a publish, drop the files it changed from Cloudflare's cache so apps get the new values in seconds instead of
// within a minute. Every CDN file is tagged (delivery.ts Cache-Tag) with its environment, with its entity and each one
// above it, and with its own link: a publish purges only the tags of what it changed (cdn.ts, events.ts PublishScope).
// Which zone and token: cdn.ts (cloudflare()'s options, else CF_ZONE_ID and CF_API_TOKEN, else Settings → CDN).
// Only the cloudflare plugin's `fetch` reaches Cloudflare: tests hand it a fake, so they never purge a real zone.

/** How long one purge may take: the outbox doesn't wait for it, but a hung request shouldn't pile up either. */
export const PURGE_TIMEOUT_MS = 5000;

export type CloudflareZone = { zoneId: string; token: string };

/** One purge of these cache tags in a Cloudflare zone. Throws with Cloudflare's own words when it says no. */
export async function purgeTags(fetchFn: typeof fetch, zone: CloudflareZone, tags: string[]): Promise<void> {
  const res = await fetchFn(`https://api.cloudflare.com/client/v4/zones/${zone.zoneId}/purge_cache`, {
    method: 'POST',
    headers: { authorization: `Bearer ${zone.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ tags }),
    signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
  });
  if (res.ok) return;
  const body = await res.text();
  let said = body;
  try { said = (JSON.parse(body) as { errors?: { message?: string }[] }).errors?.map((e) => e.message).filter(Boolean).join('; ') || body; } catch { /* not JSON */ }
  throw new CloudflareError(res.status, said);
}

export class CloudflareError extends Error {
  status: number;
  constructor(status: number, said: string) { super(`Cloudflare said ${status}: ${said}`); this.status = status; }
}

/** The tag every CDN file of an environment carries (delivery.ts). */
export const envTag = (environment: string) => `env-${environment}`;
/** The tag of an entity's files and those of every entity under it, in one environment. */
export const entityTag = (environment: string, entity: string) => `env-${environment}/${entity}`;
/** The tag of an entity's own files (its app link), in one environment: not those of the entities under it. */
export const linkTag = (environment: string, entity: string) => `link-${environment}/${entity}`;
/** A CDN file's tags: its environment, then for an entity's file, the entity and each one above it (`path`, itself
 *  first), and its own link. */
export const fileTags = (environment: string, path: readonly string[] | null): string[] =>
  [envTag(environment), ...(path?.length ? [...path.map((k) => entityTag(environment, k)), linkTag(environment, path[0])] : [])];
/** The most tags one purge sends: Cloudflare takes 30 in one call on every plan. More than that purges the environment. */
export const MAX_PURGE_TAGS = 30;

// After a publish, drop the environment's files from Cloudflare's cache so apps get the new values in
// seconds instead of within a minute. Every app file is tagged with its environment (delivery.ts Cache-Tag).
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

/** The tag every app file of an environment carries (delivery.ts). */
export const envTag = (environment: string) => `env-${environment}`;

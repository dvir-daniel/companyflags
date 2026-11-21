// The Cloud CDN plugin: after each publish, invalidates the CDN files it changed in Google Cloud CDN, by their cache
// tags (cdn.ts purgeTagsFor), so apps get a change in seconds instead of within a minute. The project, the URL map and
// the host are set here, else with FF_CLOUD_CDN_PROJECT, FF_CLOUD_CDN_URL_MAP and FF_CLOUD_CDN_HOST. No key is stored:
// the token is the service account's, from the metadata server (Cloud Run, GKE, Compute Engine), kept in memory until
// shortly before it expires; or GOOGLE_OAUTH_ACCESS_TOKEN, to try it from a laptop.

import { definePlugin, type OnPublish } from '../plugin.ts';
import { purgeTagsFor } from '../cdn.ts';
import { PURGE_TIMEOUT_MS } from '../purge.ts';

export type CloudCdnOptions = {
  /** The Google Cloud project, and the load balancer's URL map the CDN files go through. Left out:
   *  FF_CLOUD_CDN_PROJECT and FF_CLOUD_CDN_URL_MAP. */
  project?: string;
  urlMap?: string;
  /** Only this host's files (cdn.flags.example.com). Left out: FF_CLOUD_CDN_HOST, else every host of the URL map. */
  host?: string;
  /** How the server reaches Google Cloud: fetch, unless a test hands it another. Without one, nothing is purged. */
  fetch?: typeof fetch;
};

/** Cloud CDN takes 10 cache tags in one invalidation. */
export const CLOUD_CDN_TAGS_PER_CALL = 10;
/** The most calls one purge makes: more tags than these hold invalidate the environment's tag. */
export const CLOUD_CDN_MAX_CALLS = 3;
/** The token is fetched again this long before it expires. */
const REFRESH_BEFORE_MS = 5 * 60_000;
const PROJECT = /^([a-z][a-z0-9.-]*:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const URL_MAP = /^[a-z]([-a-z0-9]{0,61}[a-z0-9])?$/;

export class CloudCdnError extends Error {
  status: number;
  constructor(status: number, said: string) {
    super(`Cloud CDN said ${status}: ${said}`);
    this.status = status;
  }
}

/** The service account's access token: GOOGLE_OAUTH_ACCESS_TOKEN, else the metadata server's (GCE_METADATA_HOST, else
 *  metadata.google.internal), kept until REFRESH_BEFORE_MS before it expires. */
export function googleToken(o: { env: Readonly<Record<string, string | undefined>>; fetch: typeof fetch; now?: () => number }): () => Promise<string> {
  const now = o.now ?? Date.now;
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;
  async function fetchToken(): Promise<string> {
    const host = o.env.GCE_METADATA_HOST || 'metadata.google.internal';
    let res: Response;
    try {
      res = await o.fetch(`http://${host}/computeMetadata/v1/instance/service-account/default/token`, {
        headers: { 'metadata-flavor': 'Google' },
        signal: AbortSignal.timeout(2000),
      });
    } catch (e) {
      throw new CloudCdnError(
        0,
        `no access token: run on Google Cloud with a service account, or set GOOGLE_OAUTH_ACCESS_TOKEN (the metadata server didn’t answer: ${(e as Error).message})`,
      );
    }
    if (!res.ok) throw new CloudCdnError(res.status, `the metadata server gave no token: ${(await res.text()).slice(0, 200)}`);
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) throw new CloudCdnError(res.status, 'the metadata server gave no token');
    cached = { token: j.access_token, until: now() + (j.expires_in ?? 0) * 1000 - REFRESH_BEFORE_MS };
    return j.access_token;
  }
  return async () => {
    if (o.env.GOOGLE_OAUTH_ACCESS_TOKEN) return o.env.GOOGLE_OAUTH_ACCESS_TOKEN;
    if (cached && cached.until > now()) return cached.token;
    pending ??= fetchToken().finally(() => {
      pending = null;
    });
    return pending;
  };
}

export const cloudCdn = (o: CloudCdnOptions = {}) =>
  definePlugin({
    id: 'cloud-cdn',
    setup: ({ env, log }) => {
      const project = (o.project ?? env.FF_CLOUD_CDN_PROJECT ?? '').trim();
      const urlMap = (o.urlMap ?? env.FF_CLOUD_CDN_URL_MAP ?? '').trim();
      const host = (o.host ?? env.FF_CLOUD_CDN_HOST ?? '').trim() || undefined;
      const fetchFn = 'fetch' in o ? o.fetch : globalThis.fetch;
      const token = fetchFn ? googleToken({ env, fetch: fetchFn }) : null;
      const missing = [!project && 'project (FF_CLOUD_CDN_PROJECT)', !urlMap && 'urlMap (FF_CLOUD_CDN_URL_MAP)'].filter(Boolean);
      const problem = missing.length
        ? `cloudCdn(): no ${missing.join(' or ')}, so publishes don’t purge Cloud CDN`
        : !PROJECT.test(project)
          ? `cloudCdn(): "${project}" isn’t a project ID, so publishes don’t purge Cloud CDN`
          : !URL_MAP.test(urlMap)
            ? `cloudCdn(): "${urlMap}" isn’t a URL map’s name, so publishes don’t purge Cloud CDN`
            : null;
      const url = `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(project)}/global/urlMaps/${encodeURIComponent(urlMap)}/invalidateCache`;

      async function invalidate(bearer: string, cacheTags: string[]): Promise<void> {
        const res = await fetchFn!(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
          body: JSON.stringify(host ? { host, cacheTags } : { cacheTags }),
          signal: AbortSignal.timeout(PURGE_TIMEOUT_MS),
        });
        // 200 with an Operation: accepted; it takes effect in about 10 seconds, and isn't waited for
        if (res.ok) return;
        const body = await res.text();
        let said = body.slice(0, 300) || res.statusText;
        try {
          said = (JSON.parse(body) as { error?: { message?: string } }).error?.message || said;
        } catch {
          /* not JSON */
        }
        throw new CloudCdnError(res.status, said);
      }

      const onPublish: OnPublish = async (environment, scope = null) => {
        let tags = purgeTagsFor(environment, scope);
        if (!tags.length) return 'off';
        if (problem || !fetchFn || !token) return 'off';
        if (tags.length > CLOUD_CDN_TAGS_PER_CALL * CLOUD_CDN_MAX_CALLS) tags = purgeTagsFor(environment, null);
        const bearer = await token();
        const calls: string[][] = [];
        for (let i = 0; i < tags.length; i += CLOUD_CDN_TAGS_PER_CALL) calls.push(tags.slice(i, i + CLOUD_CDN_TAGS_PER_CALL));
        const results = await Promise.allSettled(calls.map((c) => invalidate(bearer, c)));
        const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failed) throw failed.reason;
        log(`invalidated ${tags.length} cache tag${tags.length === 1 ? '' : 's'} in Cloud CDN (${urlMap}${host ? `, ${host}` : ''})`);
        return 'purged';
      };

      return {
        onPublish,
        purges: !problem,          // a longer stale-while-revalidate only while it can purge (plugin.ts)
        warnings: () => (problem ? [problem] : []),
      };
    },
  });

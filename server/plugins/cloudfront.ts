// The CloudFront plugin: after each publish, invalidates the CDN files it changed in a CloudFront distribution, by
// their cache tags (cdn.ts purgeTagsFor; CloudFront's tag invalidation, with the distribution's CacheTagConfig on the
// Cache-Tag header), so apps get a change in seconds instead of within a minute. The distribution is set here, else
// with FF_CLOUDFRONT_DISTRIBUTION_ID. No key is stored: the credentials are AWS's usual ones (aws.ts credentialChain:
// the environment's keys, a task role, a pod identity, an instance profile), and each call is signed with SigV4.

import { randomUUID } from 'node:crypto';
import { definePlugin, type OnPublish } from '../plugin.ts';
import { purgeTagsFor } from '../cdn.ts';
import { PURGE_TIMEOUT_MS } from '../purge.ts';
import { credentialChain, signV4, xmlEscape, xmlText } from '../aws.ts';

export type CloudFrontOptions = {
  /** The distribution the CDN files are served through (E2QWRUHAPOMQZL). Left out: FF_CLOUDFRONT_DISTRIBUTION_ID. */
  distributionId?: string;
  /** How the server reaches AWS: fetch, unless a test hands it another. Without one, nothing is purged. */
  fetch?: typeof fetch;
};

/** The most tags one invalidation sends: CloudFront takes 150 tags a second per account, and a publish purges twice.
 *  More than that invalidates the environment's tag. */
export const MAX_CLOUDFRONT_TAGS = 100;
const DISTRIBUTION_ID = /^[A-Z0-9]{6,32}$/;
const ENDPOINT = 'https://cloudfront.amazonaws.com/2020-05-31/distribution';

export class CloudFrontError extends Error {
  status: number;
  code: string | null;
  constructor(status: number, code: string | null, said: string) {
    super(`CloudFront said ${status}${code ? ` ${code}` : ''}: ${said}`);
    this.status = status;
    this.code = code;
  }
}

/** The body of one CreateInvalidation: each tag as a `#tag` path, and a reference no other call has. */
export function invalidationBatch(tags: readonly string[], callerReference: string): string {
  const paths = tags.map((t) => `<Path>${xmlEscape(`#${t}`)}</Path>`).join('');
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<InvalidationBatch xmlns="http://cloudfront.amazonaws.com/doc/2020-05-31/">' +
    `<Paths><Quantity>${tags.length}</Quantity><Items>${paths}</Items></Paths>` +
    `<CallerReference>${xmlEscape(callerReference)}</CallerReference>` +
    '</InvalidationBatch>'
  );
}

export const cloudfront = (o: CloudFrontOptions = {}) =>
  definePlugin({
    id: 'cloudfront',
    setup: ({ env, log }) => {
      const distributionId = (o.distributionId ?? env.FF_CLOUDFRONT_DISTRIBUTION_ID ?? '').trim();
      const fetchFn = 'fetch' in o ? o.fetch : globalThis.fetch;
      const credentials = fetchFn ? credentialChain({ env, fetch: fetchFn }) : null;
      const problem = !distributionId
        ? 'cloudfront(): no distribution ID (its distributionId, or FF_CLOUDFRONT_DISTRIBUTION_ID), so publishes don’t purge CloudFront'
        : !DISTRIBUTION_ID.test(distributionId)
          ? `cloudfront(): "${distributionId}" isn’t a distribution ID (like E2QWRUHAPOMQZL), so publishes don’t purge CloudFront`
          : null;

      const onPublish: OnPublish = async (environment, scope = null) => {
        let tags = purgeTagsFor(environment, scope);
        if (!tags.length) return 'off';
        if (problem || !fetchFn || !credentials) return 'off';
        if (tags.length > MAX_CLOUDFRONT_TAGS) tags = purgeTagsFor(environment, null);
        const url = `${ENDPOINT}/${encodeURIComponent(distributionId)}/invalidation`;
        const body = invalidationBatch(tags, `companyflags-${Date.now()}-${randomUUID()}`);
        const headers = signV4({ method: 'POST', url, headers: { 'content-type': 'application/xml' }, body }, await credentials(), {
          region: 'us-east-1',
          service: 'cloudfront',
        });
        const res = await fetchFn(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(PURGE_TIMEOUT_MS) });
        if (!res.ok) {
          // e.g. 400 TooManyInvalidationsInProgress: kept on the publish, and the purge after it (workers.ts) tries again
          const said = await res.text();
          throw new CloudFrontError(res.status, xmlText(said, 'Code') ?? null, xmlText(said, 'Message') ?? (said.slice(0, 300) || res.statusText));
        }
        log(`invalidated ${tags.length} cache tag${tags.length === 1 ? '' : 's'} in CloudFront (${distributionId})`);
        return 'purged';
      };

      return {
        onPublish,
        purges: !problem,          // a longer stale-while-revalidate only while it can purge (plugin.ts)
        warnings: () => (problem ? [problem] : []),
      };
    },
  });

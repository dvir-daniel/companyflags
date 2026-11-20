// The CDN in front of the app files (Cloudflare). After a publish the worker drops that environment's files from the
// CDN's cache (purge.ts, Cache-Tag env-<environment>), so apps get a change in seconds instead of within the cache's
// minute. Without it nothing breaks: the CDN asks this server again after a minute.
//
// Which zone and token, first found:
//   1. the server's environment, CF_ZONE_ID and CF_API_TOKEN (index.ts): shown in Settings → CDN, not changeable there;
//   2. Settings → CDN: an admin saves them (cdn_setting). Saving checks them with Cloudflare first.
// The token is kept on the server, like single sign-on client secrets: the console only ever sees its last 4 characters.
// Only the server's own start gives this a way to reach Cloudflare (`fetch`); without it (tests) nothing goes out.

import { all, HttpError, one, type Db } from './db.ts';
import * as journal from './journal.ts';
import type { Actor } from './layers.ts';
import { CloudflareError, envTag, purgeTags, type CloudflareZone, type Purger } from './purge.ts';

export type CdnSource = 'server' | 'console';
export type CdnState = {
  source: CdnSource | null;                        // null: no CDN purge is set up
  zoneId: string | null;
  tokenEnd: string | null;                         // the token's last 4 characters
  updatedAt: string | null;
  updatedBy: string | null;
  reachable: boolean;                              // this server can call Cloudflare (false only in tests)
  publishes: { environment: string; revision: number; publishedAt: string | null; purgedAt: string | null; error: string | null }[];
};

export type CdnOptions = { fetch?: typeof fetch; server?: Partial<CloudflareZone>; log?: (m: string) => void };

const ZONE_ID = /^[0-9a-f]{32}$/;
/** A tag no app file carries: purging it checks the zone and the token's permission without dropping anything. */
const CHECK_TAG = 'companyflags-check';

export function createCdn(db: Db, o: CdnOptions = {}) {
  const log = o.log ?? (() => {});
  const fromServer = o.server?.zoneId && o.server.token ? { zoneId: o.server.zoneId, token: o.server.token } : null;

  async function zone(): Promise<(CloudflareZone & { source: CdnSource }) | null> {
    if (fromServer) return { ...fromServer, source: 'server' };
    const row = await one<{ zone_id: string; api_token: string }>(db, `select zone_id, api_token from cdn_setting`);
    return row ? { zoneId: row.zone_id, token: row.api_token, source: 'console' } : null;
  }

  /** The worker's purger: one environment's files, after its publish. 'off' when no CDN is set up. */
  const purge: Purger = async (environment) => {
    const z = await zone();
    if (!z || !o.fetch) return 'off';
    await purgeTags(o.fetch, z, [envTag(environment)]);
    log(`purged ${envTag(environment)} from the Cloudflare cache`);
    return 'purged';
  };

  /** Checks a zone and token with Cloudflare before they're saved: the words to show when it says no. */
  async function check(z: CloudflareZone): Promise<void> {
    if (!o.fetch) throw new HttpError(503, 'This server can’t reach Cloudflare, so it can’t check the zone and token.');
    try {
      await purgeTags(o.fetch, z, [CHECK_TAG]);
    } catch (e) {
      if (e instanceof CloudflareError) {
        if (e.status === 401 || e.status === 403) throw new HttpError(422, `Cloudflare didn’t accept this token for this zone: it needs the “Zone → Cache Purge → Purge” permission on it. (${e.message})`);
        if (e.status === 404 || e.status === 400) throw new HttpError(422, `Cloudflare doesn’t know this zone ID: copy it from the domain’s Overview page, under API. (${e.message})`);
        throw new HttpError(502, `Cloudflare couldn’t check them right now: try again. (${e.message})`);
      }
      throw new HttpError(502, `Cloudflare couldn’t be reached: ${(e as Error).message}`);
    }
  }

  const fromServerError = () => new HttpError(409, 'The CDN is set on the server (CF_ZONE_ID and CF_API_TOKEN): change it there.');

  return {
    purge,

    async state(): Promise<CdnState> {
      const row = fromServer ? undefined : await one<{ zone_id: string; api_token: string; updated_at: string; updated_by: string }>(db,
        `select zone_id, api_token, updated_at, updated_by from cdn_setting`);
      const z = fromServer ?? (row ? { zoneId: row.zone_id, token: row.api_token } : null);
      const publishes = await all<CdnState['publishes'][number]>(db, `select e.key as environment, q.revision::int as revision,
          q.published_at as "publishedAt", q.purged_at as "purgedAt", q.last_error as error
        from publish_queue q join environment e on e.id = q.environment_id order by q.id desc limit 10`);
      return {
        source: fromServer ? 'server' : row ? 'console' : null,
        zoneId: z?.zoneId ?? null,
        tokenEnd: z ? z.token.slice(-4) : null,
        updatedAt: row?.updated_at ?? null,
        updatedBy: row?.updated_by ?? null,
        reachable: !!o.fetch,
        publishes,
      };
    },

    /** Saves the zone and token, once Cloudflare accepts them. A token left out keeps the saved one (a new zone ID only). */
    async save(input: { zoneId?: unknown; token?: unknown }, actor: Actor): Promise<void> {
      if (fromServer) throw fromServerError();
      const zoneId = typeof input.zoneId === 'string' ? input.zoneId.trim().toLowerCase() : '';
      if (!ZONE_ID.test(zoneId)) throw new HttpError(422, 'The zone ID is 32 letters and digits (0–9, a–f): copy it from the domain’s Overview page in Cloudflare, under API.');
      let token = typeof input.token === 'string' ? input.token.trim() : '';
      const saved = await one<{ zone_id: string; api_token: string }>(db, `select zone_id, api_token from cdn_setting`);
      if (!token) {
        if (!saved) throw new HttpError(422, 'Add the API token: Cloudflare → My Profile → API Tokens → Create Token, with “Zone → Cache Purge → Purge” on this zone.');
        token = saved.api_token;
      }
      if (token.length < 20 || token.length > 200 || /\s/.test(token)) throw new HttpError(422, 'That doesn’t look like a Cloudflare API token: copy it again from Cloudflare.');
      await check({ zoneId, token });
      await db.transaction(async (tx) => {
        await tx.query(`insert into cdn_setting (id, zone_id, api_token, updated_at, updated_by) values (true, $1, $2, now(), $3)
          on conflict (id) do update set zone_id = excluded.zone_id, api_token = excluded.api_token, updated_at = now(), updated_by = excluded.updated_by`,
          [zoneId, token, actor.name]);
        // History names the zone and the token's last 4 characters, never the token
        await journal.audit(tx, actor, { kind: 'cdn.update', before: saved ? { zoneId: saved.zone_id, tokenEnd: saved.api_token.slice(-4) } : null,
          after: { zoneId, tokenEnd: token.slice(-4) } });
      });
    },

    /** Stops purging: apps then get a change within the CDN's minute. */
    async remove(actor: Actor): Promise<void> {
      if (fromServer) throw fromServerError();
      await db.transaction(async (tx) => {
        const gone = await one<{ zone_id: string }>(tx, `delete from cdn_setting returning zone_id`);
        if (!gone) throw new HttpError(404, 'No CDN is set up.');
        await journal.audit(tx, actor, { kind: 'cdn.remove', before: { zoneId: gone.zone_id } });
      });
    },

    /** Purges one environment now, outside a publish (to check the setup, or after a problem). */
    async purgeNow(environment: unknown, actor: Actor): Promise<void> {
      const env = typeof environment === 'string'
        ? await one<{ id: number; key: string }>(db, `select id, key from environment where key = $1`, [environment]) : undefined;
      if (!env) throw new HttpError(404, 'environment not found');
      const z = await zone();
      if (!z) throw new HttpError(409, 'No CDN is set up: add the zone and token first.');
      if (!o.fetch) throw new HttpError(503, 'This server can’t reach Cloudflare.');
      try {
        await purgeTags(o.fetch, z, [envTag(env.key)]);
      } catch (e) {
        throw new HttpError(502, `The purge didn’t go through: ${(e as Error).message}`);
      }
      await journal.audit(db, actor, { kind: 'cdn.purge', environment: env.id, after: { tag: envTag(env.key) } });
    },
  };
}
export type Cdn = ReturnType<typeof createCdn>;

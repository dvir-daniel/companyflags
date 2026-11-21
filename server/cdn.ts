// Cloudflare, the CDN in front of the CDN files. After a publish the worker drops the files it changed from the CDN's
// cache (purge.ts: the environment's tag, or only the tags of the entities whose answers or links changed), so apps
// get a change in seconds instead of within the cache's minute. A publish that changed nobody's answers (a new
// entity, a flag's description) purges nothing. Without it nothing breaks: the CDN asks this server again after a
// minute. A purge that can't run (Cloudflare says no, or the saved token can't be read after FF_SECRET
// changed) is kept on the publish and shown in /readyz's warnings and the metrics (workers.ts publishState).
//
// Which zone and token, first found:
//   1. the server's: cloudflare()'s options in companyflags.config.ts, else CF_ZONE_ID and CF_API_TOKEN
//      (plugins/cloudflare.ts). Shown in Settings → CDN, not changeable there;
//   2. Settings → CDN: an admin saves them (cdn_setting). Saving checks them with Cloudflare first.
// The token is kept on the server, like single sign-on client secrets: the console only ever sees its last 4 characters.
// Only the plugin's `fetch` reaches Cloudflare; without one (tests) nothing goes out.

import { all, HttpError, one, type Db } from './db.ts';
import * as journal from './journal.ts';
import type { Actor } from './layers.ts';
import type { PublishScope } from './events.ts';
import type { OnPublish } from './plugin.ts';
import { CloudflareError, entityTag, envTag, linkTag, MAX_PURGE_TAGS, purgeTags, type CloudflareZone } from './purge.ts';
import { SealError, type Sealer } from './sealed.ts';

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

/** `secrets`: seals the token saved in the console (sealed.ts); without it (a test) it is kept as it is. */
export type CdnOptions = { fetch?: typeof fetch; server?: Partial<CloudflareZone>; log?: (m: string) => void; secrets?: Sealer };
const asIs: Sealer = { seal: (v) => v, open: (v) => v };

const ZONE_ID = /^[0-9a-f]{32}$/;
/** How long this server trusts what it knows about whether a purge can run (Settings → CDN may change on another). */
const PURGING_TTL_MS = 30_000;
/** A tag no CDN file carries: purging it checks the zone and the token's permission without dropping anything. */
const CHECK_TAG = 'companyflags-check';
/** Said when the token saved in the console was sealed with another FF_SECRET: nothing is purged until then. */
export const UNREADABLE_TOKEN = 'The CDN’s API token can’t be read (FF_SECRET changed), so nothing is purged: save it again in Settings → CDN';

/** The tags a publish purges: the environment's, or only those of what it changed; none when it changed nobody's answers. */
export function purgeTagsFor(environment: string, scope: PublishScope): string[] {
  if (!scope) return [envTag(environment)];
  const tags = [...new Set([...scope.entities.map((k) => entityTag(environment, k)), ...scope.links.map((k) => linkTag(environment, k))])];
  return tags.length > MAX_PURGE_TAGS ? [envTag(environment)] : tags;
}

export function createCdn(db: Db, o: CdnOptions = {}) {
  const log = o.log ?? (() => {});
  const fromServer = o.server?.zoneId && o.server.token ? { zoneId: o.server.zoneId, token: o.server.token } : null;
  const box = o.secrets ?? asIs;
  /** The saved token, unsealed; null when it was sealed with another FF_SECRET (it has to be saved again). */
  const tokenOf = (stored: string): string | null => {
    try { return box.open(stored); } catch (e) {
      if (e instanceof SealError) return null;
      throw e;
    }
  };

  /** The zone and token; null when none is set up. A saved token that can't be read is an error: purging is off
   *  without anyone having turned it off. */
  async function zone(): Promise<(CloudflareZone & { source: CdnSource }) | null> {
    if (fromServer) return { ...fromServer, source: 'server' };
    const row = await one<{ zone_id: string; api_token: string }>(db, `select zone_id, api_token from cdn_setting`);
    if (!row) return null;
    const token = tokenOf(row.api_token);
    if (token === null) throw new Error(UNREADABLE_TOKEN);
    return { zoneId: row.zone_id, token, source: 'console' };
  }

  // Whether a purge can run (a zone and a token this server can read, and a way to reach Cloudflare), for the CDN
  // files' caching (plugin.ts purges): kept in memory, looked at again once it is 30 seconds old, and at once after a
  // change here (another server's change shows within those 30 seconds).
  let purging = { on: !!fromServer && !!o.fetch, at: 0 };
  let looking: Promise<boolean> | null = null;
  const lookAgain = (): Promise<boolean> => (looking ??= zone().then((z) => !!z && !!o.fetch, () => false)
    .then((on) => { purging = { on, at: Date.now() }; return on; })
    .finally(() => { looking = null; }));
  /** Whether a purge runs after a publish, from memory (it is asked on every CDN file's answer). */
  const purges = (): boolean => {
    if (Date.now() - purging.at > PURGING_TTL_MS) void lookAgain();
    return purging.on;
  };

  /** The worker's purger, after a publish: the files it changed (purgeTagsFor). 'off' when there is nothing to purge
   *  or no CDN is set up. */
  const purge: OnPublish = async (environment, scope = null) => {
    const tags = purgeTagsFor(environment, scope);
    if (!tags.length) return 'off';
    const z = await zone();
    if (!z || !o.fetch) return 'off';
    await purgeTags(o.fetch, z, tags);
    log(`purged ${tags.join(', ')} from the Cloudflare cache`);
    return 'purged';
  };

  /** What an operator should know (index.ts /readyz's warnings, the metrics): a saved token that can't be read. */
  async function warnings(): Promise<string[]> {
    try { await zone(); return []; } catch (e) { return [(e as Error).message]; }
  }

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

  const fromServerError = () => new HttpError(409, 'The CDN is set on the server (cloudflare() in companyflags.config.ts, or CF_ZONE_ID and CF_API_TOKEN): change it there.');

  return {
    purge,
    warnings,
    purges,
    /** Looks now whether a purge can run (the plugin's setup, before the first answer). */
    lookAgain,

    async state(): Promise<CdnState> {
      const row = fromServer ? undefined : await one<{ zone_id: string; api_token: string; updated_at: string; updated_by: string }>(db,
        `select zone_id, api_token, updated_at, updated_by from cdn_setting`);
      const z = fromServer ?? (row ? { zoneId: row.zone_id, token: tokenOf(row.api_token) ?? '' } : null);
      const publishes = await all<CdnState['publishes'][number]>(db, `select e.key as environment, q.revision::int as revision,
          q.published_at as "publishedAt", q.purged_at as "purgedAt", q.last_error as error
        from publish_queue q join environment e on e.id = q.environment_id order by q.id desc limit 10`);
      return {
        source: fromServer ? 'server' : row ? 'console' : null,
        zoneId: z?.zoneId ?? null,
        tokenEnd: z?.token ? z.token.slice(-4) : null,
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
      const row = await one<{ zone_id: string; api_token: string }>(db, `select zone_id, api_token from cdn_setting`);
      const saved = row ? { zone_id: row.zone_id, api_token: tokenOf(row.api_token) ?? '' } : undefined;
      if (!token) {
        if (!saved?.api_token) throw new HttpError(422, 'Add the API token: Cloudflare → My Profile → API Tokens → Create Token, with “Zone → Cache Purge → Purge” on this zone.');
        token = saved.api_token;
      }
      if (token.length < 20 || token.length > 200 || /\s/.test(token)) throw new HttpError(422, 'That doesn’t look like a Cloudflare API token: copy it again from Cloudflare.');
      await check({ zoneId, token });
      await db.transaction(async (tx) => {
        await tx.query(`insert into cdn_setting (id, zone_id, api_token, updated_at, updated_by) values (true, $1, $2, now(), $3)
          on conflict (id) do update set zone_id = excluded.zone_id, api_token = excluded.api_token, updated_at = now(), updated_by = excluded.updated_by`,
          [zoneId, box.seal(token), actor.name]);
        // History names the zone and the token's last 4 characters, never the token
        await journal.audit(tx, actor, { kind: 'cdn.update', before: saved ? { zoneId: saved.zone_id, tokenEnd: saved.api_token.slice(-4) } : null,
          after: { zoneId, tokenEnd: token.slice(-4) } });
      });
      await lookAgain();
    },

    /** Stops purging: apps then get a change within the CDN's minute. */
    async remove(actor: Actor): Promise<void> {
      if (fromServer) throw fromServerError();
      await db.transaction(async (tx) => {
        const gone = await one<{ zone_id: string }>(tx, `delete from cdn_setting returning zone_id`);
        if (!gone) throw new HttpError(404, 'No CDN is set up.');
        // the purges that failed with it no longer need a look (/readyz's warnings)
        await tx.query(`update publish_queue set last_error = null where last_error like 'purge:%'`);
        await journal.audit(tx, actor, { kind: 'cdn.remove', before: { zoneId: gone.zone_id } });
      });
      await lookAgain();
    },

    /** Purges one environment now, outside a publish (to check the setup, or after a problem). */
    async purgeNow(environment: unknown, actor: Actor): Promise<void> {
      const env = typeof environment === 'string'
        ? await one<{ id: number; key: string }>(db, `select id, key from environment where key = $1`, [environment]) : undefined;
      if (!env) throw new HttpError(404, 'environment not found');
      let z: Awaited<ReturnType<typeof zone>>;
      try { z = await zone(); } catch (e) { throw new HttpError(409, `${(e as Error).message}.`); }
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

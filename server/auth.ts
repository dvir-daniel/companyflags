// Who may read what.
// - Apps (android, ios, web) read their entity's file at a secret link (delivery.ts): no keys, no tokens.
//   The link's secret is an HMAC of the entity and its link version, made with the environment's secret,
//   so it differs per environment and an entity's link can be replaced on its own (rotateClientLink).
// - Backend servers use API keys, in the Authorization header, the only header they need. The key's scope says which
//   entities it may ask about: its own (`entity`), its own and every one under it (`below`), or any (`all`). The
//   request names the entity by its dimension, in the path (`/sdk/v1/flagd/store/acme-12`), never in a header and
//   never from what an app says about itself (M2). mayAsk() checks it against the snapshot's paths on every request.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { HttpError, one, type Db } from './db.ts';

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** The secret part of an entity's app link in one environment. 22 characters, 128 bits. (The words "client-link/<key>"
 *  stay as they were for customers, so every link given out before dimensions keeps its secret.) */
export const clientSecret = (envSecret: string, entity: string, version: number) =>
  createHmac('sha256', envSecret).update(`client-link/${entity}/${version}`).digest('base64url').slice(0, 22);

/** The secret part of an app's OpenFeature token (ofrep.ts): bound to the app as well as the entity and its link version,
 *  so a token for one app can't be turned into another app's, and replacing the link replaces it too. */
export const appTokenSecret = (envSecret: string, app: string, entity: string, version: number) =>
  createHmac('sha256', envSecret).update(`app-token/${app}/${entity}/${version}`).digest('base64url').slice(0, 22);

export function sameSecret(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// The prefix (shown in the console and logs) is the readable part and the secret's first 4 characters. The secret is
// base64url, which has "_" in it too, so the prefix is cut by length, never at the last "_".
export function newApiKey(envKey: string, projectKey: string) {
  const head = `ff_${envKey}_${projectKey.replace(/[^a-z0-9]/g, '')}`;
  const secret = randomBytes(18).toString('base64url');
  const raw = `${head}_${secret}`;
  return { raw, hash: sha256(raw), prefix: `${head}_${secret.slice(0, 4)}` };
}

export type KeyScope = 'entity' | 'below' | 'all';
export const KEY_SCOPES: readonly KeyScope[] = ['entity', 'below', 'all'];
export type Principal = {
  keyId: string;
  environment: string;
  project: string;
  scope: KeyScope;
  entity: string | null;             // the key's own entity (null for an `all` key)
};

type KeyRow = { id: string; env_key: string; project_key: string; scope: KeyScope; entity_key: string | null };

/** A map that keeps at most `max` entries, dropping the one used longest ago (a Map keeps insertion order:
 *  a hit is moved to the end, so the first key is the least recently used). */
export class LruCache<K, V> {
  #map = new Map<K, V>();
  readonly max: number;
  constructor(max: number) { this.max = max; }
  get size() { return this.#map.size; }
  get(key: K): V | undefined {
    const v = this.#map.get(key);
    if (v !== undefined) { this.#map.delete(key); this.#map.set(key, v); }
    return v;
  }
  set(key: K, value: V) {
    this.#map.delete(key);
    this.#map.set(key, value);
    while (this.#map.size > this.max) this.#map.delete(this.#map.keys().next().value as K);
  }
  delete(key: K) { this.#map.delete(key); }
  clear() { this.#map.clear(); }
}

// API keys are kept in memory instead of being looked up on every request, by each app (createApp makes its
// own KeyCache, so two apps in one process share nothing). Revoking a key clears the app's copy once the revoke
// commits (journal.ts); other server processes pick it up within KEY_TTL_MS. `last_used_at` is written at most
// once a minute per key. Keys that aren't valid are remembered apart, in a smaller cache: a spray of made-up keys
// only pushes out other made-up keys, never the real ones.
const KEY_TTL_MS = 60_000;
export class KeyCache {
  keys = new LruCache<string, { row: KeyRow; at: number }>(50_000);
  misses = new LruCache<string, number>(10_000);
  lastUsedWritten = new LruCache<string, number>(50_000);
  forget() { this.keys.clear(); this.misses.clear(); }
}

async function findKey(db: Db, raw: string, cache: KeyCache): Promise<KeyRow | null> {
  const hash = sha256(raw);
  const hit = cache.keys.get(hash);
  if (hit && Date.now() - hit.at < KEY_TTL_MS) return hit.row;
  const missed = cache.misses.get(hash);
  if (missed !== undefined && Date.now() - missed < KEY_TTL_MS) return null;
  const row = await one<KeyRow>(db, `select k.id, e.key as env_key, p.key as project_key, k.scope, c.key as entity_key
    from api_key k join environment e on e.id = k.environment_id join project p on p.id = k.project_id
    left join entity c on c.id = k.entity_id where k.key_hash = $1 and k.revoked_at is null`, [hash]);
  if (row) { cache.keys.set(hash, { row, at: Date.now() }); cache.misses.delete(hash); }
  else { cache.keys.delete(hash); cache.misses.set(hash, Date.now()); }
  return row ?? null;
}

export type AuthHeaders = { authorization?: string };

// A backend server's request: which environment and server it is for, and which entities it may ask about.
export async function authenticate(db: Db, headers: AuthHeaders, cache: KeyCache): Promise<Principal> {
  const raw = headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!raw) throw new HttpError(401, 'missing API key (Authorization: Bearer <key>)');
  const k = await findKey(db, raw, cache);
  if (!k) throw new HttpError(401, 'unknown or revoked API key');
  const now = Date.now();
  if (now - (cache.lastUsedWritten.get(k.id) ?? 0) > 60_000) {
    cache.lastUsedWritten.set(k.id, now);
    db.query(`update api_key set last_used_at = now() where id = $1`, [k.id]).catch(() => {});
  }
  return { keyId: k.id, environment: k.env_key, project: k.project_key, scope: k.scope, entity: k.entity_key };
}

/** May this key ask about this entity? `path`: the entity and those above it (EntityInfo.path), read from the snapshot
 *  on every request, so moving an entity out from under a `below` key's entity takes it out of reach at once. */
export const mayAsk = (p: Pick<Principal, 'scope' | 'entity'>, entity: string, path: readonly string[]) =>
  p.scope === 'all' || (p.scope === 'entity' ? p.entity === entity : !!p.entity && path.includes(p.entity));

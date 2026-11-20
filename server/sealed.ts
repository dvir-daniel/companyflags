// Secrets this server keeps for other systems (the CDN's API token, the headers and signing secrets of webhooks) are
// stored sealed: AES-256-GCM with a key derived from the server's secret (BETTER_AUTH_SECRET, or the one it made for
// itself, betterAuth.ts serverSecret). A copy of the database, or a backup, without that secret can't read them.
//
//   enc:v1:<12-byte nonce, base64url>:<ciphertext and 16-byte tag, base64url>
//
// A new BETTER_AUTH_SECRET makes the sealed values unreadable: they are set again (the CDN token, a webhook's
// headers) or made again (a webhook's signing secret), as after any leak of the old secret.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { Db } from './db.ts';

const PREFIX = 'enc:v1:';

export type Sealer = {
  /** The value, sealed. */
  seal(plain: string): string;
  /** The value back. A value that was never sealed (from before 0.9) comes back as it is; one sealed with another
   *  secret throws a SealError. */
  open(stored: string): string;
};

export class SealError extends Error {}

export const isSealed = (v: unknown): v is string => typeof v === 'string' && v.startsWith(PREFIX);

/** Seals and opens with a key derived from the server's secret. */
export function sealer(secret: string): Sealer {
  const key = Buffer.from(hkdfSync('sha256', secret, 'companyflags', 'stored secrets v1', 32));
  return {
    seal(plain) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const sealed = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
      return `${PREFIX}${nonce.toString('base64url')}:${sealed.toString('base64url')}`;
    },
    open(stored) {
      if (!isSealed(stored)) return stored;
      const [nonce, sealed] = stored.slice(PREFIX.length).split(':').map((p) => Buffer.from(p, 'base64url'));
      if (!nonce || !sealed || nonce.length !== 12 || sealed.length < 16) throw new SealError('a stored secret is damaged');
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAuthTag(sealed.subarray(sealed.length - 16));
        return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString('utf8');
      } catch {
        throw new SealError('a stored secret was sealed with another BETTER_AUTH_SECRET: set it again');
      }
    },
  };
}

/** Seals the secrets stored before they were sealed (migration 0020 made room for them): once, at the start, in one
 *  transaction. Values sealed already are left as they are, so it runs on every start and does nothing after the
 *  first. Returns how many it sealed. */
export async function sealStoredSecrets(db: Db, box: Sealer): Promise<number> {
  return db.transaction(async (tx) => {
    let n = 0;
    const cdn = await tx.query<{ api_token: string }>(`select api_token from cdn_setting for update`);
    for (const r of cdn.rows) {
      if (isSealed(r.api_token)) continue;
      await tx.query(`update cdn_setting set api_token = $1`, [box.seal(r.api_token)]);
      n++;
    }
    const hooks = await tx.query<{ id: string; secret: string; headers: Record<string, string> | null }>(
      `select id::text as id, secret, headers from webhook for update`);
    for (const h of hooks.rows) {
      const headers = h.headers && typeof h.headers === 'object' ? h.headers : {};
      const plain = Object.entries(headers).filter(([, v]) => !isSealed(v));
      if (isSealed(h.secret) && !plain.length) continue;
      const sealedHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, isSealed(v) ? v : box.seal(String(v))]));
      await tx.query(`update webhook set secret = $2, headers = $3::jsonb where id = $1`,
        [h.id, isSealed(h.secret) ? h.secret : box.seal(h.secret), JSON.stringify(sealedHeaders)]);
      n++;
    }
    return n;
  });
}

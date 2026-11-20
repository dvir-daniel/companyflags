// What webhooks are sent with (webhooks.ts): a fetch that reaches only the public internet, unless an operator lets
// it reach an origin on their own network (FF_WEBHOOK_ALLOWED_ORIGINS). An admin chooses a webhook's address, method,
// headers and body, so without this a webhook could reach this machine, the network it is on, or a cloud's metadata
// address (169.254.169.254), and say through its test whether something answers there.
//
// The address a name resolves to is checked when the connection is made, by the connection's own lookup, so a name
// can't resolve to a public address for the check and a private one for the connection (DNS rebinding). Redirects
// are never followed. The answer is its status only: webhooks never read what comes back.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isPublicAddress } from './sso.ts';

/** The address isn't on the public internet, and its origin isn't allowed. */
export class NotPublicError extends Error {
  constructor() { super('not a public address'); this.name = 'NotPublicError'; }
}

export type PublicFetchOptions = {
  /** Origins it may reach although they aren't public, e.g. http://ci.internal:8080 (FF_WEBHOOK_ALLOWED_ORIGINS). */
  allowedOrigins?: readonly string[];
  /** How names are resolved: the system's (dns.lookup), unless a test hands it another. */
  lookup?: typeof dnsLookup;
};

const originOf = (u: string) => { try { return new URL(u).origin; } catch { return null; } };

/** FF_WEBHOOK_ALLOWED_ORIGINS: origins, comma-separated. */
export const allowedOriginsFrom = (v: string | undefined) => (v ?? '').split(',').map((s) => originOf(s.trim())).filter((o): o is string => !!o);

export function publicFetch(o: PublicFetchOptions = {}): typeof fetch {
  const allowed = new Set((o.allowedOrigins ?? []).map(originOf).filter(Boolean));
  const resolve = o.lookup ?? dnsLookup;
  // the connection's lookup: every address the name has must be public
  const lookup = ((hostname: string, options: { all?: boolean; family?: number }, callback: (e: Error | null, a: string | LookupAddress[], f?: number) => void) => {
    resolve(hostname, { ...options, all: true }, (e, addresses) => {
      const list = (addresses ?? []) as LookupAddress[];
      if (e) return callback(e, []);
      if (!list.length || list.some((a) => !isPublicAddress(a.address))) return callback(new NotPublicError(), []);
      if (options.all) return callback(null, list);
      callback(null, list[0].address, list[0].family);
    });
  }) as unknown as LookupFunction;

  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError(`${url.protocol} isn’t http or https`);
    const open = allowed.has(url.origin);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // an address written as a number never goes through the lookup
    if (!open && isIP(host) && !isPublicAddress(host)) throw new NotPublicError();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const res = await new Promise<IncomingMessage>((done, fail) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: init.method ?? 'GET', headers, signal: init.signal ?? undefined, ...(open ? {} : { lookup }),
      }, done);
      req.on('error', fail);
      req.end(typeof init.body === 'string' ? init.body : undefined);
    });
    res.destroy();                                         // the answer's body isn't read
    const status = res.statusCode ?? 0;
    return new Response(null, { status: status >= 200 && status <= 599 ? status : 502 });
  }) as typeof fetch;
}

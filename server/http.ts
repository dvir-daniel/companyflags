// What the HTTP API's routes share about requests: reading a JSON body, and the environment a request names. A
// mistake in either is the caller's (400 with a code, db.ts ERROR_CODES), never a 500.

import type { Context } from 'hono';
import { HttpError } from './db.ts';

/** Whether a value is a JSON object (not null, not a list). */
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A body that is there must be a JSON object: 400 bad_json otherwise. An empty body passes (the route decides). */
export async function checkBody(c: Context): Promise<void> {
  const text = await c.req.text();
  if (!text.trim()) return;
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'the request body isn’t valid JSON', {}, 'bad_json'); }
  if (!isObject(v)) throw new HttpError(400, 'the request body must be a JSON object: { … }', {}, 'bad_json');
}

/** The request's JSON body, an object. `optional`: an empty body is {} (a route whose body only adds a reason);
 *  otherwise an empty body is a 400 that says to send one. */
export async function jsonBody<T = Record<string, unknown>>(c: Context, optional = false): Promise<T> {
  const text = await c.req.text();
  if (!text.trim()) {
    if (optional) return {} as T;
    throw new HttpError(400, 'send a JSON object in the body', {}, 'bad_json');
  }
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new HttpError(400, 'the request body isn’t valid JSON', {}, 'bad_json'); }
  if (!isObject(v)) throw new HttpError(400, 'the request body must be a JSON object: { … }', {}, 'bad_json');
  return v as T;
}

/** The environment a request names in ?environment=: required, never a default. A request that forgets it would
 *  otherwise get another environment's answer, in the right shape. */
export function environmentOf(c: Context): string {
  const env = c.req.query('environment')?.trim();
  if (!env) throw new HttpError(400, 'name the environment: ?environment=<key>, e.g. ?environment=production', {}, 'bad_request');
  return env;
}

// Webhooks, out and in (the console's Migration page; docs/guide/webhooks.md, docs/guide/migration.md).
//
// Out: after each change, this server sends each webhook what changed, read from the history (journal.ts):
//   changes  what an environment serves: one message per save, with every entry of it, and `values`: what those flags
//            are set to now (values.ts), so another system can be kept the same
//   reviews  a request made, approved, rejected or scheduled
// as signed JSON (Standard Webhooks: webhook-id, webhook-timestamp, webhook-signature), a Slack message, or whatever a
// JSONata expression makes of the JSON (transform.ts; nothing: that message isn't sent). Each webhook keeps its own
// place in the history (`cursor`), so it gets every change once and in order; one that fails is tried again later
// (RETRY_AFTER_S) and holds up only itself, and after the last try that message is passed over. Several servers can
// share the database: a webhook is sent by one at a time (`claimed_until`).
//
// History rows are numbered as they're written, but a save becomes readable when it commits: a row number that isn't
// readable yet (a hole) is a save still under way, or one rolled back. A webhook stops before a hole, and after
// GAP_WAIT_MS takes it for rolled back and goes on.
//
// In: another system posts its values to /hooks/v1/<token>, in one of the import formats; they're imported into the
// webhook's environment (values.ts applyImport): applied at once, or as a request for review where it needs approval.
// A value that's already what it says changes nothing, so sending back what a webhook out sent makes no loop.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { all, HttpError, one, type Db } from './db.ts';
import * as journal from './journal.ts';
import { KINDS } from './journal.ts';
import type { Actor } from './layers.ts';
import type { DataPlane } from './snapshot.ts';
import { expressionProblem, runJsonata } from './transform.ts';
import { applyImport, FORMATS_IN, toValues, valuesOf, type Imported, type ValuesDoc } from './values.ts';

export const EVENTS = ['changes', 'reviews'] as const;
export type WebhookEvent = (typeof EVENTS)[number];
export const OUT_FORMATS = ['json', 'slack', 'jsonata'] as const;
export const METHODS = ['POST', 'PUT', 'PATCH'] as const;
const REVIEW_KINDS = new Set(['change_set.create', 'change_set.approve', 'change_set.reject', 'change_set.schedule']);
export const TIMEOUT_MS = 10_000;
/** Seconds before each next try of a message that failed; after the last, it's passed over. */
export const RETRY_AFTER_S = [5, 30, 120, 600, 1800, 3600, 7200];
export const MAX_TRIES = RETRY_AFTER_S.length + 1;
export const GAP_WAIT_MS = 10_000;
const READ_ROWS = 500;
const BODY_MAX = 1_000_000;
const RESERVED_HEADERS = new Set(['content-type', 'content-length', 'host', 'user-agent', 'webhook-id', 'webhook-timestamp', 'webhook-signature']);

// ---------------------------------------------------------------- which history rows make a message

export type HistoryRow = {
  id: number; environment: string | null; revision: number | null; changedAt: string; at: string; changedBy: string; actorType: string;
  kind: string; flag: string | null; entity: string | null; before: unknown; after: unknown; comment: string | null; changeSetId: number | null;
};
export type Filter = { events: readonly string[]; environments: readonly string[] | null };

export const eventOf = (r: Pick<HistoryRow, 'kind' | 'revision'>): WebhookEvent | null =>
  r.revision !== null ? 'changes' : REVIEW_KINDS.has(r.kind) ? 'reviews' : null;
export const wants = (h: Filter, r: HistoryRow) => {
  const e = eventOf(r);
  return !!e && h.events.includes(e) && (!h.environments || (r.environment !== null && h.environments.includes(r.environment)));
};
// One save's rows share its time (Postgres now() is the transaction's start) and who made it.
const saveOf = (r: HistoryRow) => `${r.at}|${r.changedBy}`;

export type Next = { message: HistoryRow[]; cursor: number; gapSince: number | null };
/**
 * The next message for a webhook, from the history rows after its cursor (in order): the rows of one save it wants,
 * and where its cursor goes once that's sent (past rows it doesn't want, too). It reads on only while the row numbers
 * follow on from the cursor: at a hole it stops, and a hole right at the cursor is waited for `gapWaitMs` (`gapSince`:
 * since when), then passed over.
 */
export function nextMessage(rows: readonly HistoryRow[], hook: Filter & { cursor: number }, gapSince: number | null, now: number, gapWaitMs = GAP_WAIT_MS): Next {
  const message: HistoryRow[] = [];
  let cursor = hook.cursor;
  let expected = cursor + 1;
  let gap = gapSince;
  let save: string | null = null;
  for (const r of rows) {
    if (r.id !== expected) {
      if (cursor > hook.cursor) break;                      // what's before the hole goes first
      if (gap === null) return { message, cursor, gapSince: now };
      if (now - gap < gapWaitMs) return { message, cursor, gapSince: gap };
      gap = null;                                           // waited long enough: rolled back
    }
    if (save !== null && saveOf(r) !== save) break;         // the next save is the next message
    if (wants(hook, r)) { save ??= saveOf(r); message.push(r); }
    cursor = r.id;
    expected = r.id + 1;
  }
  return { message, cursor, gapSince: cursor > hook.cursor ? null : gap };
}

// ---------------------------------------------------------------- what a message says

export type Names = { person: Map<string, string>; entity: Map<string, string>; environment: Map<string, string> };
type Says = (e: { flag: string | null; entity: string | null; before: unknown; after: unknown }, name: (k: string) => string) => string;

/** One history entry in words: "Changed settings on new_checkout for Acme", "Approved request #12". */
export function sentence(r: HistoryRow, n: Names): string {
  const says = (KINDS as Record<string, { says?: Says }>)[r.kind]?.says;
  if (says) return says(r, (k) => n.entity.get(k) ?? k);
  const req = r.changeSetId !== null ? ` #${r.changeSetId}` : '';
  switch (r.kind) {
    case 'change_set.create': return `Asked for a review of request${req}`;
    case 'change_set.approve': return `Approved request${req}`;
    case 'change_set.reject': return `Rejected request${req}`;
    case 'change_set.schedule': {
      const at = (r.after as { scheduledAt?: string } | null)?.scheduledAt;
      return `Scheduled request${req}${at ? ` for ${at}` : ''}`;
    }
    default: return `${r.kind}${r.flag ? ` ${r.flag}` : ''}`;
  }
}

export type Message = {
  type: WebhookEvent | 'ping';
  timestamp: string;
  data: {
    by?: { key: string; name: string; type: string };
    changes?: {
      id: number; kind: string; text: string; environment: string | null; revision: number | null; flag: string | null; entity: string | null;
      comment: string | null; request: number | null; before: unknown; after: unknown;
    }[];
    values?: Record<string, ValuesDoc>;                // per environment: the flags it changed, as they are set now
    url?: string;
    webhook?: string;
  };
};

export function buildMessage(rows: readonly HistoryRow[], n: Names, o: { baseURL?: string | null; values?: Record<string, ValuesDoc> } = {}): Message {
  const first = rows[0];
  const type: WebhookEvent = rows.some((r) => eventOf(r) === 'changes') ? 'changes' : 'reviews';
  const request = type === 'reviews' ? first.changeSetId : null;
  const base = o.baseURL?.replace(/\/+$/, '');
  return {
    type,
    timestamp: new Date(first.changedAt).toISOString(),
    data: {
      by: { key: first.changedBy, name: n.person.get(first.changedBy) ?? first.changedBy, type: first.actorType },
      changes: rows.map((r) => ({
        id: r.id, kind: r.kind, text: sentence(r, n), environment: r.environment, revision: r.revision, flag: r.flag, entity: r.entity,
        comment: r.comment, request: r.changeSetId, before: r.before ?? null, after: r.after ?? null,
      })),
      ...(o.values && Object.keys(o.values).length ? { values: o.values } : {}),
      ...(base ? { url: request !== null ? `${base}/#/approvals/${request}` : `${base}/#/history` } : {}),
    },
  };
}

const slackText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** The message as Slack's incoming webhooks take it (Discord takes it too, at its webhook address + /slack). */
export function slackMessage(m: Message, n: Names): { text: string } {
  if (m.type === 'ping') return { text: `CompanyFeatures can reach this webhook${m.data.webhook ? ` (${slackText(m.data.webhook)})` : ''}.` };
  const changes = m.data.changes ?? [];
  const envs = [...new Set(changes.map((c) => c.environment).filter((e): e is string => !!e))].map((e) => `*${slackText(n.environment.get(e) ?? e)}*`);
  const lines = [...new Set(changes.map((c) => c.text))];
  const shown = lines.slice(0, 10).map((l) => `• ${slackText(l)}`);
  if (lines.length > shown.length) shown.push(`• and ${lines.length - shown.length} more`);
  const comments = [...new Set(changes.map((c) => c.comment).filter((c): c is string => !!c))].map((c) => `> ${slackText(c)}`);
  const head = `*${slackText(m.data.by?.name ?? 'Someone')}*${envs.length ? ` in ${envs.join(', ')}` : ''}`;
  const link = m.data.url ? `<${m.data.url}|Open in CompanyFeatures>` : '';
  return { text: [head, ...shown, ...comments, link].filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------- signing (Standard Webhooks, standardwebhooks.com)

export const newSecret = () => `whsec_${randomBytes(24).toString('base64')}`;
export function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

// ---------------------------------------------------------------- the webhooks

type OutRow = {
  id: string; name: string; url: string; method: string; headers: Record<string, string>; format: string; expression: string | null;
  events: string[]; environments: string[] | null; secret: string; enabled: boolean; cursor: string; gapSince: Date | string | null; attempts: number;
};
export type WebhookView = {
  id: number; name: string; host: string; method: string; headerNames: string[]; format: string; expression: string | null;
  events: string[]; environments: string[] | null; enabled: boolean; createdAt: string; createdBy: string;
  lastStatus: number | null; lastError: string | null; lastSentAt: string | null; lastFailedAt: string | null; attempts: number; nextAttemptAt: string | null;
};
export type IncomingView = {
  id: number; name: string; environment: string; format: string; expression: string | null; createFlags: boolean; flagSets: string[]; enabled: boolean;
  createdAt: string; createdBy: string; lastReceivedAt: string | null; lastStatus: number | null; lastResult: string | null;
};
export type Sent = { ok: boolean; status: number | null; error: string | null; skipped?: boolean };

export type WebhookOptions = {
  fetch?: typeof fetch;            // only the server's own start sends anything: an app made in a test never does
  baseURL?: string | null;         // the console's address, for links in messages
  log?: (m: string) => void;
  gapWaitMs?: number;
  everyMs?: number;
};

const OUT_COLUMNS = `id::text as id, name, url, method, headers, format, expression, events, environments, secret, enabled, cursor::text as cursor,
  gap_since as "gapSince", attempts`;
const VIEW_COLUMNS = `id::int as id, name, url, method, headers, format, expression, events, environments, enabled, created_at as "createdAt",
  created_by as "createdBy", last_status as "lastStatus", last_error as "lastError", last_sent_at as "lastSentAt", last_failed_at as "lastFailedAt",
  attempts, next_attempt_at as "nextAttemptAt"`;
const IN_COLUMNS = `w.id::int as id, w.name, e.key as environment, w.format, w.expression, w.create_flags as "createFlags", w.flag_sets as "flagSets", w.enabled,
  w.created_at as "createdAt", w.created_by as "createdBy", w.last_received_at as "lastReceivedAt", w.last_status as "lastStatus", w.last_result as "lastResult"`;

const hostOf = (url: string) => { try { return new URL(url).host; } catch { return url; } };
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function createWebhooks(db: Db, plane: Pick<DataPlane, 'snapshots'>, o: WebhookOptions = {}) {
  const log = o.log ?? (() => {});
  const gapWaitMs = o.gapWaitMs ?? GAP_WAIT_MS;

  // ------------------------------------------------------------ sending

  async function names(rows: readonly HistoryRow[]): Promise<Names> {
    const people = [...new Set(rows.map((r) => r.changedBy))];
    // an entity's parent, in History's entries (before dimensions, the parent was `company`)
    type Was = { parent?: unknown; company?: unknown } | null;
    const parents = (s: unknown) => [(s as Was)?.parent, (s as Was)?.company];
    const ents = [...new Set(rows.flatMap((r) => [r.entity, ...parents(r.before), ...parents(r.after)]))]
      .filter((k): k is string => typeof k === 'string');
    const [p, e, env] = await Promise.all([
      all<{ key: string; name: string }>(db, `select key, coalesce(name, key) as name from app_user where key = any($1::text[])`, [people]),
      all<{ key: string; name: string }>(db, `select key, name from entity where key = any($1::text[])`, [ents]),
      all<{ key: string; name: string }>(db, `select key, name from environment`),
    ]);
    const map = (l: { key: string; name: string }[]) => new Map(l.map((x) => [x.key, x.name]));
    return { person: map(p), entity: map(e), environment: map(env) };
  }

  /** What the flags a message changed are set to now, per environment. */
  function valuesFor(rows: readonly HistoryRow[]): Record<string, ValuesDoc> {
    const out: Record<string, ValuesDoc> = {};
    for (const env of new Set(rows.filter((r) => r.revision !== null && r.environment).map((r) => r.environment!))) {
      const snap = plane.snapshots.get(env);
      if (!snap) continue;
      out[env] = valuesOf(snap, rows.filter((r) => r.environment === env && r.flag).map((r) => r.flag!));
    }
    return out;
  }

  /** The body to send for a message, or null when a JSONata expression makes nothing of it (not sent). */
  async function render(h: Pick<OutRow, 'format' | 'expression'>, m: Message, n: Names): Promise<{ body: string; type: string } | null> {
    if (h.format === 'slack') return { body: JSON.stringify(slackMessage(m, n)), type: 'application/json' };
    if (h.format === 'jsonata') {
      const out = await runJsonata(h.expression, m);
      if (out === undefined || out === null) return null;
      return typeof out === 'string' ? { body: out, type: 'text/plain; charset=utf-8' } : { body: JSON.stringify(out), type: 'application/json' };
    }
    return { body: JSON.stringify(m), type: 'application/json' };
  }

  async function send(h: Pick<OutRow, 'url' | 'method' | 'headers' | 'secret'>, id: string, out: { body: string; type: string }): Promise<Sent> {
    if (!o.fetch) return { ok: false, status: null, error: 'This server doesn’t send webhooks (no network access set up).' };
    const timestamp = Math.floor(Date.now() / 1000);
    try {
      const res = await o.fetch(h.url, {
        method: h.method,
        headers: {
          ...(isObject(h.headers) ? h.headers : {}),
          'content-type': out.type, 'user-agent': 'CompanyFeatures-Webhooks',
          'webhook-id': id, 'webhook-timestamp': String(timestamp), 'webhook-signature': sign(h.secret, id, timestamp, out.body),
        },
        body: out.body,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, error: null };
      const redirect = res.status >= 300 && res.status < 400 ? ': webhooks don’t follow redirects, so use the address it points to' : '';
      return { ok: false, status: res.status, error: `It answered ${res.status}${redirect}.` };
    } catch (e) {
      const err = e as Error;
      return { ok: false, status: null, error: err.name === 'TimeoutError' ? `No answer within ${TIMEOUT_MS / 1000} seconds.` : `It couldn’t be reached: ${err.message}.` };
    }
  }

  const readAfter = (cursor: number) => all<HistoryRow & { id: string }>(db, `select h.id::text as id, e.key as environment, h.revision::float8 as revision,
      h.changed_at as "changedAt", h.changed_at::text as at, h.changed_by as "changedBy", h.actor_type as "actorType", h.change_type as kind,
      h.flag, h.entity, h.before, h.after, h.comment, h.change_set_id::float8 as "changeSetId"
    from change_history h left join environment e on e.id = h.environment_id where h.id > $1 order by h.id limit ${READ_ROWS}`, [cursor])
    .then((rows) => rows.map((r) => ({ ...r, id: Number(r.id) })));

  async function deliver(h: OutRow) {
    let cursor = Number(h.cursor);
    let gap = h.gapSince ? new Date(h.gapSince).getTime() : null;
    let attempts = h.attempts;
    const started = Date.now();
    try {
      while (Date.now() - started < 20_000) {
        const rows = await readAfter(cursor);
        if (!rows.length) break;
        const next = nextMessage(rows, { events: h.events, environments: h.environments, cursor }, gap, Date.now(), gapWaitMs);
        gap = next.gapSince;
        if (!next.message.length) {
          if (next.cursor === cursor) break;                  // waiting at a hole
          cursor = next.cursor;
          continue;
        }
        // `values` are what this save made: wait until this server's snapshot of each environment has its revision. The
        // publisher runs beside this worker (another instance catches up from the database), so it's a moment at most;
        // the next round (wake, or everyMs) tries again.
        const behind = next.message.some((r) => {
          const snap = r.revision !== null && r.environment ? plane.snapshots.get(r.environment) : undefined;
          return !!snap && snap.revision < r.revision!;
        });
        if (behind) break;
        let sent: Sent;
        try {
          const n = await names(next.message);
          const m = buildMessage(next.message, n, { baseURL: o.baseURL, values: valuesFor(next.message) });
          const out = await render(h, m, n);
          sent = out ? await send(h, `msg_${next.message[0].id}`, out) : { ok: true, status: null, error: null, skipped: true };
        } catch (e) {
          sent = { ok: false, status: null, error: (e as Error).message };
        }
        if (sent.ok) {
          cursor = next.cursor;
          attempts = 0;
          if (!sent.skipped) await db.query(`update webhook set last_status = $2, last_error = null, last_sent_at = now(), next_attempt_at = null where id = $1`, [h.id, sent.status]);
          continue;
        }
        attempts++;
        if (attempts >= MAX_TRIES) {
          log(`webhook ${h.name}: passed over a message after ${MAX_TRIES} tries: ${sent.error}`);
          await db.query(`update webhook set last_status = $2, last_error = $3, last_failed_at = now(), next_attempt_at = null where id = $1`,
            [h.id, sent.status, `${sent.error} After ${MAX_TRIES} tries, that message was passed over.`]);
          cursor = next.cursor;
          attempts = 0;
          break;
        }
        await db.query(`update webhook set last_status = $2, last_error = $3, last_failed_at = now(), next_attempt_at = now() + make_interval(secs => $4) where id = $1`,
          [h.id, sent.status, sent.error, RETRY_AFTER_S[attempts - 1]]);
        break;
      }
    } finally {
      await db.query(`update webhook set cursor = $2, gap_since = $3, attempts = $4, claimed_until = null where id = $1`,
        [h.id, cursor, gap === null ? null : new Date(gap), attempts]).catch((e) => log(`webhook ${h.name}: ${(e as Error).message}`));
    }
  }

  async function round() {
    if (!o.fetch) return;
    const due = await all<OutRow>(db, `with due as (
        select id from webhook w where enabled and (claimed_until is null or claimed_until < now())
          and (next_attempt_at is null or next_attempt_at <= now())
          and exists (select 1 from change_history h where h.id > w.cursor)
        for update skip locked)
      update webhook w set claimed_until = now() + interval '60 seconds' from due where w.id = due.id returning ${OUT_COLUMNS.replace(/(^|,\s*)(\w)/g, '$1w.$2')}`);
    await Promise.all(due.map((h) => deliver(h).catch((e) => log(`webhook ${h.name}: ${(e as Error).message}`))));
  }

  function start() {
    let stopped = false;
    let current: Promise<void> | null = null;
    const loop = (): Promise<void> => {
      if (current) return current;
      if (stopped) return Promise.resolve();
      current = round().catch((e) => log(`webhooks: ${(e as Error).message}`)).finally(() => { current = null; });
      return current;
    };
    const timer = setInterval(() => { void loop(); }, o.everyMs ?? 1000);
    return {
      wake: () => { if (!stopped) setImmediate(() => { void loop(); }); },
      stop: async () => { stopped = true; clearInterval(timer); if (current) await current; },
      drain: async () => { if (current) await current; await loop(); },
    };
  }

  // ------------------------------------------------------------ out: what admins set

  const viewOf = (r: Omit<WebhookView, 'host' | 'headerNames'> & { url: string; headers: Record<string, string> }): WebhookView => {
    const { url, headers, ...rest } = r;
    return { ...rest, host: hostOf(url), headerNames: Object.keys(isObject(headers) ? headers : {}) };
  };
  const summary = (v: Partial<WebhookView>) => ({
    name: v.name, host: v.host, method: v.method, format: v.format, events: v.events, environments: v.environments, enabled: v.enabled, headerNames: v.headerNames,
  });

  async function envKeys() { return (await all<{ key: string }>(db, `select key from environment order by id`)).map((e) => e.key); }

  type OutInput = { name?: unknown; url?: unknown; method?: unknown; headers?: unknown; format?: unknown; expression?: unknown; events?: unknown; environments?: unknown; enabled?: unknown };
  async function checkOut(i: OutInput, creating: boolean) {
    const out: { name?: string; url?: string; method?: string; headers?: Record<string, string>; format?: string; expression?: string | null;
      events?: string[]; environments?: string[] | null; enabled?: boolean } = {};
    if (creating || i.name !== undefined) {
      const name = typeof i.name === 'string' ? i.name.trim() : '';
      if (!name || name.length > 80) throw new HttpError(422, 'Give it a name, up to 80 characters.');
      out.name = name;
    }
    if (creating || i.url !== undefined) {
      let u: URL | null = null;
      try { u = typeof i.url === 'string' ? new URL(i.url.trim()) : null; } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol) || u.href.length > 2000) throw new HttpError(422, 'The address is a full URL starting with https:// (or http://).');
      out.url = u.href;
    }
    if (i.method !== undefined) {
      if (!METHODS.includes(i.method as (typeof METHODS)[number])) throw new HttpError(422, `The method is ${METHODS.join(', ')}.`);
      out.method = i.method as string;
    }
    if (i.headers !== undefined) {
      if (!isObject(i.headers)) throw new HttpError(422, 'Headers are { "<name>": "<value>" }.');
      const entries = Object.entries(i.headers);
      if (entries.length > 10) throw new HttpError(422, 'At most 10 headers.');
      for (const [k, v] of entries) {
        if (!/^[A-Za-z0-9-]{1,64}$/.test(k)) throw new HttpError(422, `“${k}” isn’t a header name: letters, digits and dashes.`);
        if (RESERVED_HEADERS.has(k.toLowerCase())) throw new HttpError(422, `${k} is set by CompanyFeatures: leave it out.`);
        if (typeof v !== 'string' || v.length > 2000 || /[\r\n]/.test(v)) throw new HttpError(422, `${k}: the value is one line of text.`);
      }
      out.headers = Object.fromEntries(entries) as Record<string, string>;
    }
    if (creating || i.format !== undefined) {
      const format = i.format ?? 'json';
      if (!OUT_FORMATS.includes(format as (typeof OUT_FORMATS)[number])) throw new HttpError(422, `The format is ${OUT_FORMATS.join(', ')}.`);
      out.format = format as string;
    }
    if (i.expression !== undefined) out.expression = typeof i.expression === 'string' && i.expression.trim() ? i.expression : null;
    if (creating || i.events !== undefined) {
      const events = i.events ?? ['changes'];
      if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) throw new HttpError(422, 'Pick what it sends: changes, reviews or both.');
      out.events = [...new Set(events as string[])];
    }
    if (i.environments !== undefined) {
      if (i.environments === null) out.environments = null;
      else {
        const keys = await envKeys();
        if (!Array.isArray(i.environments) || !i.environments.length || i.environments.some((e) => !keys.includes(e))) {
          throw new HttpError(422, 'Pick the environments it sends changes of (or all of them).');
        }
        out.environments = [...new Set(i.environments as string[])];
      }
    }
    if (i.enabled !== undefined) {
      if (typeof i.enabled !== 'boolean') throw new HttpError(422, '“enabled” is true or false.');
      out.enabled = i.enabled;
    }
    return out;
  }
  const checkExpression = (format: string, expression: string | null | undefined) => {
    if (format !== 'jsonata') return;
    const problem = expressionProblem(expression);
    if (problem) throw new HttpError(422, problem);
  };

  async function viewOut(id: number | string): Promise<WebhookView> {
    const r = await one<Parameters<typeof viewOf>[0]>(db, `select ${VIEW_COLUMNS} from webhook where id = $1`, [id]);
    if (!r) throw new HttpError(404, 'There’s no such webhook.');
    return viewOf(r);
  }

  // ------------------------------------------------------------ in

  const parseToken = (token: string) => {
    const m = /^ffh_(\d{1,15})_([A-Za-z0-9_-]{20,64})$/.exec(token);
    return m ? { id: Number(m[1]), secret: m[2] } : null;
  };
  const newInToken = (id: number | string) => { const secret = randomBytes(24).toString('base64url'); return { secret, token: `ffh_${id}_${secret}` }; };

  async function viewIn(id: number | string): Promise<IncomingView> {
    const r = await one<IncomingView>(db, `select ${IN_COLUMNS} from webhook_in w join environment e on e.id = w.environment_id where w.id = $1`, [id]);
    if (!r) throw new HttpError(404, 'There’s no such webhook.');
    return r;
  }
  type InInput = { name?: unknown; environment?: unknown; format?: unknown; expression?: unknown; createFlags?: unknown; flagSets?: unknown; enabled?: unknown };
  async function checkIn(i: InInput, creating: boolean) {
    const out: { name?: string; environmentId?: number; format?: string; expression?: string | null; createFlags?: boolean; flagSets?: string[]; enabled?: boolean } = {};
    if (creating || i.name !== undefined) {
      const name = typeof i.name === 'string' ? i.name.trim() : '';
      if (!name || name.length > 80) throw new HttpError(422, 'Give it a name, up to 80 characters.');
      out.name = name;
    }
    if (creating || i.environment !== undefined) {
      const env = typeof i.environment === 'string' ? await one<{ id: number }>(db, `select id from environment where key = $1`, [i.environment]) : undefined;
      if (!env) throw new HttpError(422, 'Pick the environment it imports into.');
      out.environmentId = env.id;
    }
    if (creating || i.format !== undefined) {
      if (!FORMATS_IN.includes(i.format as (typeof FORMATS_IN)[number])) throw new HttpError(422, `The format is ${FORMATS_IN.join(', ')}.`);
      out.format = i.format as string;
    }
    if (i.expression !== undefined) out.expression = typeof i.expression === 'string' && i.expression.trim() ? i.expression : null;
    if (i.createFlags !== undefined) out.createFlags = i.createFlags === true;
    if (i.flagSets !== undefined) {
      if (!Array.isArray(i.flagSets) || i.flagSets.some((a) => typeof a !== 'string')) throw new HttpError(422, 'Flag sets are a list of flag set keys.');
      const known = new Set((await all<{ key: string }>(db, `select key from project`)).map((p) => p.key));
      const unknown = (i.flagSets as string[]).find((a) => !known.has(a));
      if (unknown) throw new HttpError(422, `There’s no flag set “${unknown}”.`);
      out.flagSets = [...new Set(i.flagSets as string[])];
    }
    if (i.enabled !== undefined) out.enabled = i.enabled === true;
    return out;
  }

  return {
    start,
    /** One round now (tests). */
    round,

    // ---------------------------------------------------------- out

    async list(): Promise<{ reachable: boolean; webhooks: WebhookView[]; incoming: IncomingView[] }> {
      const [rows, incoming] = await Promise.all([
        all<Parameters<typeof viewOf>[0]>(db, `select ${VIEW_COLUMNS} from webhook order by id`),
        all<IncomingView>(db, `select ${IN_COLUMNS} from webhook_in w join environment e on e.id = w.environment_id order by w.id`),
      ]);
      return { reachable: !!o.fetch, webhooks: rows.map(viewOf), incoming };
    },

    /** A new webhook: from now on, it gets every change it asks for. Its signing secret is shown this once. */
    async add(input: OutInput, actor: Actor): Promise<{ webhook: WebhookView; secret: string }> {
      const v = await checkOut(input, true);
      checkExpression(v.format!, v.expression);
      const secret = newSecret();
      const id = await db.transaction(async (tx) => {
        const row = await one<{ id: string }>(tx, `insert into webhook (name, url, method, headers, format, expression, events, environments, secret, cursor, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9, (select coalesce(max(id), 0) from change_history), $10) returning id::text as id`,
          [v.name, v.url, v.method ?? 'POST', JSON.stringify(v.headers ?? {}), v.format, v.expression ?? null, v.events, v.environments ?? null, secret, actor.name]);
        const view = viewOf((await one<Parameters<typeof viewOf>[0]>(tx, `select ${VIEW_COLUMNS} from webhook where id = $1`, [row!.id]))!);
        await journal.audit(tx, actor, { kind: 'webhook.create', after: summary(view) });
        return row!.id;
      });
      return { webhook: await viewOut(id), secret };
    },

    /** Changes a webhook. A new address or headers replace the old (they're never shown again). Switched back on, it
     *  goes on from now: changes made while it was off aren't sent. */
    async update(id: string, input: OutInput, actor: Actor): Promise<WebhookView> {
      const before = await viewOut(id);
      const v = await checkOut(input, false);
      const format = v.format ?? before.format;
      checkExpression(format, v.expression !== undefined ? v.expression : before.expression);
      await db.transaction(async (tx) => {
        await tx.query(`update webhook set name = coalesce($2, name), url = coalesce($3, url), method = coalesce($4, method),
            headers = coalesce($5::jsonb, headers), format = $6, expression = case when $7::boolean then $8 else expression end,
            events = coalesce($9, events), environments = case when $10::boolean then $11::text[] else environments end,
            enabled = coalesce($12, enabled),
            cursor = case when $12::boolean and not enabled then (select coalesce(max(id), 0) from change_history) else cursor end,
            attempts = 0, next_attempt_at = null, gap_since = null
          where id = $1`,
          [id, v.name ?? null, v.url ?? null, v.method ?? null, v.headers ? JSON.stringify(v.headers) : null, format,
            v.expression !== undefined, v.expression ?? null, v.events ?? null, v.environments !== undefined, v.environments ?? null, v.enabled ?? null]);
        const after = viewOf((await one<Parameters<typeof viewOf>[0]>(tx, `select ${VIEW_COLUMNS} from webhook where id = $1`, [id]))!);
        await journal.audit(tx, actor, { kind: 'webhook.update', before: summary(before), after: summary(after) });
      });
      return viewOut(id);
    },

    async remove(id: string, actor: Actor): Promise<void> {
      const before = await viewOut(id);
      await db.transaction(async (tx) => {
        await tx.query(`delete from webhook where id = $1`, [id]);
        await journal.audit(tx, actor, { kind: 'webhook.delete', before: summary(before) });
      });
    },

    /** A new signing secret, shown this once: the old one stops signing at once. */
    async newSecret(id: string, actor: Actor): Promise<{ secret: string }> {
      const before = await viewOut(id);
      const secret = newSecret();
      await db.transaction(async (tx) => {
        await tx.query(`update webhook set secret = $2 where id = $1`, [id, secret]);
        await journal.audit(tx, actor, { kind: 'webhook.secret', after: { name: before.name } });
      });
      return { secret };
    },

    /** Sends a test message now ("ping"), signed like the rest. Changes nothing. */
    async test(id: string): Promise<Sent> {
      const h = await one<OutRow>(db, `select ${OUT_COLUMNS} from webhook where id = $1`, [id]);
      if (!h) throw new HttpError(404, 'There’s no such webhook.');
      const m: Message = { type: 'ping', timestamp: new Date().toISOString(), data: { webhook: h.name } };
      const n: Names = { person: new Map(), entity: new Map(), environment: new Map() };
      const out = await render(h, m, n);
      if (!out) return { ok: true, status: null, error: null, skipped: true };
      return send(h, `msg_ping_${Date.now()}`, out);
    },

    // ---------------------------------------------------------- in

    /** A new incoming webhook. Its address (with the token) is shown this once. */
    async addIn(input: InInput, actor: Actor): Promise<{ webhook: IncomingView; token: string }> {
      const v = await checkIn(input, true);
      checkExpression(v.format!, v.expression);
      return db.transaction(async (tx) => {
        const placeholder = sha256(randomBytes(16).toString('hex'));
        const row = await one<{ id: string }>(tx, `insert into webhook_in (name, environment_id, format, expression, create_flags, flag_sets, token_hash, created_by)
          values ($1, $2, $3, $4, $5, $6, $7, $8) returning id::text as id`,
          [v.name, v.environmentId, v.format, v.expression ?? null, v.createFlags ?? false, v.flagSets ?? [], placeholder, actor.name]);
        const { secret, token } = newInToken(row!.id);
        await tx.query(`update webhook_in set token_hash = $2 where id = $1`, [row!.id, sha256(secret)]);
        const view = (await one<IncomingView>(tx, `select ${IN_COLUMNS} from webhook_in w join environment e on e.id = w.environment_id where w.id = $1`, [row!.id]))!;
        await journal.audit(tx, actor, { kind: 'webhook_in.create', after: { name: view.name, environment: view.environment, format: view.format, createFlags: view.createFlags, flagSets: view.flagSets } });
        return { webhook: view, token };
      });
    },

    async updateIn(id: string, input: InInput, actor: Actor): Promise<IncomingView> {
      const before = await viewIn(id);
      const v = await checkIn(input, false);
      checkExpression(v.format ?? before.format, v.expression !== undefined ? v.expression : before.expression);
      await db.transaction(async (tx) => {
        await tx.query(`update webhook_in set name = coalesce($2, name), environment_id = coalesce($3, environment_id), format = coalesce($4, format),
            expression = case when $5::boolean then $6 else expression end, create_flags = coalesce($7, create_flags), flag_sets = coalesce($8, flag_sets),
            enabled = coalesce($9, enabled) where id = $1`,
          [id, v.name ?? null, v.environmentId ?? null, v.format ?? null, v.expression !== undefined, v.expression ?? null, v.createFlags ?? null, v.flagSets ?? null, v.enabled ?? null]);
        const after = (await one<IncomingView>(tx, `select ${IN_COLUMNS} from webhook_in w join environment e on e.id = w.environment_id where w.id = $1`, [id]))!;
        const pick = (x: IncomingView) => ({ name: x.name, environment: x.environment, format: x.format, createFlags: x.createFlags, flagSets: x.flagSets, enabled: x.enabled });
        await journal.audit(tx, actor, { kind: 'webhook_in.update', before: pick(before), after: pick(after) });
      });
      return viewIn(id);
    },

    async removeIn(id: string, actor: Actor): Promise<void> {
      const before = await viewIn(id);
      await db.transaction(async (tx) => {
        await tx.query(`delete from webhook_in where id = $1`, [id]);
        await journal.audit(tx, actor, { kind: 'webhook_in.delete', before: { name: before.name, environment: before.environment } });
      });
    },

    /** A new address, shown this once: the old one stops working at once. */
    async newToken(id: string, actor: Actor): Promise<{ token: string }> {
      const before = await viewIn(id);
      const { secret, token } = newInToken(id);
      await db.transaction(async (tx) => {
        await tx.query(`update webhook_in set token_hash = $2 where id = $1`, [id, sha256(secret)]);
        await journal.audit(tx, actor, { kind: 'webhook_in.token', after: { name: before.name } });
      });
      return { token };
    },

    /** A post to an incoming webhook's address: its values, imported. The status and JSON to answer with. */
    async receive(token: string, body: string): Promise<{ status: number; json: Record<string, unknown> }> {
      const t = parseToken(token);
      const row = t ? await one<{ id: number; name: string; environment: string; format: string; expression: string | null; createFlags: boolean;
        flagSets: string[]; enabled: boolean; tokenHash: string }>(db, `select w.id::int as id, w.name, e.key as environment, w.format, w.expression,
          w.create_flags as "createFlags", w.flag_sets as "flagSets", w.enabled, w.token_hash as "tokenHash"
        from webhook_in w join environment e on e.id = w.environment_id where w.id = $1`, [t.id]) : undefined;
      const hash = t ? Buffer.from(sha256(t.secret)) : Buffer.alloc(64);
      if (!t || !row || !timingSafeEqual(hash, Buffer.from(row.tokenHash.padEnd(64).slice(0, 64)))) {
        return { status: 401, json: { error: 'There’s no webhook at this address, or its address was replaced.' } };
      }
      const record = (status: number, result: string) => db.query(`update webhook_in set last_received_at = now(), last_status = $2, last_result = $3 where id = $1`,
        [row.id, status, result.slice(0, 500)]).catch(() => {});
      const answer = async (status: number, json: Record<string, unknown>, result: string) => { await record(status, result); return { status, json }; };
      if (!row.enabled) return answer(409, { error: 'This webhook is switched off in CompanyFeatures.' }, 'Refused: switched off');
      if (body.length > BODY_MAX) return answer(413, { error: `The body is larger than ${BODY_MAX / 1_000_000} MB.` }, 'Refused: too large');
      let input: unknown;
      try { input = JSON.parse(body); } catch { return answer(400, { error: 'The body isn’t JSON.' }, 'Refused: not JSON'); }
      try {
        const read = await toValues(row.format, input, row.expression);
        if (read.problems.length) return answer(422, { error: 'Nothing was imported: fix these first.', problems: read.problems }, `Refused: ${read.problems[0]}`);
        const actor: Actor = { name: `Webhook: ${row.name}`, type: 'service_token' };
        const r: Imported = await applyImport(db, read.doc, { environment: row.environment, createFlags: row.createFlags, flagSets: row.flagSets, reason: `From the webhook “${row.name}”` }, actor);
        const warnings = [...read.warnings, ...r.warnings];
        const what = `${r.created ? `${r.created} new, ` : ''}${r.changed} changed`;
        if (!r.applied) return answer(202, { applied: false, request: r.request, created: r.created, changed: r.changed, warnings }, `Request #${r.request}: ${what}`);
        return answer(200, { applied: true, revision: r.revision ?? null, created: r.created, changed: r.changed, warnings }, r.changed || r.created ? `Imported: ${what}` : 'Nothing to change');
      } catch (e) {
        if (e instanceof HttpError) {
          const problems = Array.isArray(e.body.errors) ? (e.body.errors as string[]) : null;
          return answer(e.status, { error: e.message, ...(problems ? { problems } : {}) }, `Refused: ${problems?.[0] ?? e.message}`);
        }
        throw e;
      }
    },
  };
}
export type Webhooks = ReturnType<typeof createWebhooks>;

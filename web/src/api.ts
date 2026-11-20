import type { ErrorCode as ServerErrorCode } from '../../server/db.ts';
import type { DecidedBy } from '../../server/evaluator.ts';
import type { FieldInfo } from '../../server/fields.ts';
import { entityWords, type EntityWords, type Vocab } from '../../server/words.ts';
import type { Dimension } from '../../server/dimensions.ts';
// One vocabulary with the server: the in-app default, attribute names, comparisons, section and level names, the
// three choices, what an entity gets with nothing of its own, and the dimensions' words.
export { CODE_DEFAULT } from '../../server/evaluator.ts';
export type { DecidedBy, Section, LevelName, EntityAnswer, AnswerPick, AnswerException } from '../../server/evaluator.ts';
export {
  CHOICE_NAME, CHOICES, choiceText, conditionText, entityWords, fieldLabel, getsWithoutOwn, levelOf, noValueOp, opLabel, OPS_BY_TYPE, ownerName, sameAs,
  SECTION_LABEL, sourceText, STAGE_LABEL, whenText, withoutOwn, type EntityWords, type Vocab,
} from '../../server/words.ts';
export {
  above, below, capital, checkDimensions, count, dimensionOf, joined, many, MAX_DIMENSIONS, one, own, PRESETS, suggestKey, title, type Dimension, type Dimensions,
} from '../../server/dimensions.ts';
export { groupLabel } from '../../server/fields.ts';

export type Op = string;
export type Condition = { field: string; op: Op; values?: (string | number)[] };
export type SplitRange = { variation: string; from: number; to: number; group?: string };
export type Split = { by: string; fallbackBy: string | null; salt?: string; hashVersion?: number; ranges: SplitRange[]; outsideGroup?: string };
export type Rule = {
  ruleKey?: string; name: string | null; locked: boolean; disabled: boolean;
  conditions: Condition[]; serveVariation: string | null; split: Split | null;
};
export type Inherit = 'base_rules_then_base_default' | 'base_rules_then_customer_default' | 'customer_only';
export type Layer = {
  version: number; enabled: boolean | null; variationWhenOff: string | null; defaultVariation: string | null;
  inherit: Inherit | null; rules: Rule[]; updatedAt?: string; updatedBy?: string;
};
export type Variation = { key: string; value: unknown };
export type FlagDetail = {
  key: string; name: string | null; tags: string[]; valueType: string; kind: string; description: string | null; owner: string | null;
  removeBy: string | null; archivedAt: string | null; createdAt?: string;
  /** free values: any value is typed into the rules and the default (each a hidden variant), with no named list */
  freeValues?: boolean;
  variations: Variation[]; delivery: Record<string, string[]>;
  layers: Record<string, { base: Layer; entities: { entity: string; layer: Layer }[] }>;
  /** a version release (docs/design/release-versions.md): per environment, the version it was on before its current one,
   *  since when it's been on the current one, and the versions it has served while on (from its history) */
  versions?: Record<string, { previous: string | null; since: string | null; served: string[] }>;
};
export type FlagSummary = Omit<FlagDetail, 'variations' | 'layers'> & { envs: Record<string, { enabled: boolean; entityLayers: number; defaultVariation: string; defaultValue: unknown }> };
/** A dimension (server/dimensions.ts), with how many entities it has and how many of them have a parent. */
export type DimensionInfo = Dimension & { entities: number; withParent: number };
// An entry of a dimension. `parent`: the entity above it, in the dimension right above (it follows that one's settings
// until it has its own).
export type Entity = { key: string; name: string; dimension: string; createdAt: string; parent?: string | null };
/** An entity's name, with its parent's: "Acme 12 (Acme)". */
export function entityLabel(entities: Entity[], key: string): string {
  const byKey = entityIndex(entities);
  const c = byKey.get(key);
  if (!c) return key;
  const parent = c.parent ? byKey.get(c.parent) : undefined;
  return parent ? `${c.name} (${parent.name})` : c.name;
}
/** An entity as words.ts names it (its name, and those above it); null for none. */
export function entityWordsOf(entities: Entity[], key: string | null | undefined): EntityWords | null {
  if (!key) return null;
  const byKey = entityIndex(entities);
  return entityWords(key, (k) => byKey.get(k)) ?? { key, name: key, above: [] };
}
// One Map per entities list (meta.entities is replaced, not changed, when it reloads): lookups by key in
// long lists stay O(1) instead of a scan per row.
const indexes = new WeakMap<Entity[], Map<string, Entity>>();
export function entityIndex(entities: Entity[]): Map<string, Entity> {
  let m = indexes.get(entities);
  if (!m) { m = new Map(entities.map((c) => [c.key, c])); indexes.set(entities, m); }
  return m;
}
/** What words.ts needs for a sentence: the dimensions, and entity names by key (useVocab in app.ts). */
const vocabs = new WeakMap<Entity[], Vocab>();
export function vocabOf(meta: Pick<Meta, 'dimensions' | 'entities'>): Vocab {
  let v = vocabs.get(meta.entities);
  if (!v || v.dimensions !== meta.dimensions) {
    const byKey = entityIndex(meta.entities);
    v = { dimensions: meta.dimensions, nameOf: (k) => byKey.get(k)?.name };
    vocabs.set(meta.entities, v);
  }
  return v;
}
// an attribute a rule can check, with its group, label and known values (server/fields.ts)
export type Field = FieldInfo;
// status: 'invited' until they use their invite link; 'removed' when an admin removed their access;
// 'no_account': from before Better Auth, without an account or an invite yet
export type User = { key: string; name: string; role: string; status?: 'active' | 'invited' | 'removed' | 'no_account' };
export type Meta = {
  me: User;                                                   // who is signed in
  signIn: 'better-auth' | 'test-header';
  environments: { key: string; name: string; minApprovals: number; revision: number }[];
  projects: { key: string; kind: 'client' | 'server' }[];
  /** what config is served per, top to bottom (server/dimensions.ts) */
  dimensions: DimensionInfo[];
  entities: Entity[]; users: User[]; fields: Field[];
  dataPlane: Record<string, { revision: number; builtAt: string }>;
  /** change sets waiting for review, in every environment, that `me` may approve (server/policy.ts mayApprove;
   *  older servers don't send it) */
  pendingApprovals?: number;
  /** the plugins this server runs (server/plugin.ts): 'ofrep', 'flagd', 'app-files', 'cloudflare', or its own */
  plugins: string[];
};
export type TraceStep = {
  stage: string; layer: 'base' | 'entity' | null; owner?: string; ruleKey?: string; ruleName?: string | null;
  outcome: string; detail: string;
  conditions?: { field: string; op: string; values?: unknown[]; actual: unknown; result: boolean; note?: string }[];
  split?: { unit: string | null; unitValue?: string; bucket?: number; range?: SplitRange | null; salt: string; hashVersion: number };
};
export type EvalResult = {
  key: string; value?: unknown; variant?: string; codeDefault?: boolean; reason: string; errorCode?: string;
  metadata: Record<string, string | number | boolean>; decidedBy: DecidedBy; group?: string; trace?: TraceStep[];
};

/** What the console acts on in an error, never its words: the server's stable `code` (server/db.ts ErrorCode),
 *  `offline` when the request never reached the server, or `stale` when the draft session refused a publish because
 *  the server has a newer version of a flag in it (draftSession.ts). */
export type ErrorCode = ServerErrorCode | 'offline' | 'stale';

export type ErrorBody = { error?: string; errors?: string[]; code?: ErrorCode; [k: string]: unknown } | null;
export class ApiError extends Error {
  status: number;
  body: ErrorBody;
  constructor(status: number, body: ErrorBody) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
  get details(): string[] { return this.body?.errors ?? []; }
  get code(): ErrorCode | undefined { return this.body?.code; }
}
/** The error's code, if it is one the console knows (an ApiError, or anything else carrying a `code`). */
export const errorCode = (e: unknown): ErrorCode | undefined => (e && typeof e === 'object' && 'code' in e ? (e as { code?: ErrorCode }).code : undefined);

// ---------------------------------------------------------------- the answer cache
// Like Next.js' client cache: a page you've seen opens at once with its last answer while a fresh one loads
// (stale-while-revalidate), and navigation fetches a page's first answer before switching (main.tsx), so the
// old page stays on screen instead of flashing a placeholder. Answers are kept as JSON text and parsed on each
// read, so no page can change another page's copy. Any change made through the API clears them.
const answers = new Map<string, string>();
// A change (yours, or a revision event from someone else) starts a new generation: a GET that started before it
// may carry old data, so it's never joined by a later read and its answer is never kept.
let generation = 0;
const inflight = new Map<string, { gen: number; p: Promise<string> }>();
const MAX_ANSWERS = 200;
// POSTs that only read (they run the evaluator): they don't make kept answers stale
const READ_ONLY_POSTS = new Set(['/trace', '/compare']);

/** The last answer for a GET, if there is one: for a page's first render. */
export function peek<T>(path: string): T | undefined {
  const text = answers.get(path);
  return text === undefined ? undefined : ((text ? JSON.parse(text) : null) as T);
}

/** Starts a GET now so the page that needs it opens with it (a hovered link, a navigation). Never fails. */
export function prefetch(path: string): Promise<void> {
  if (answers.has(path) && !inflight.has(path)) return Promise.resolve();
  return get(path).then(() => {}, () => {});
}

function get(path: string): Promise<string> {
  const running = inflight.get(path);
  if (running && running.gen === generation) return running.p;
  const entry = { gen: generation, p: request('GET', path).finally(() => { if (inflight.get(path) === entry) inflight.delete(path); }) };
  inflight.set(path, entry);
  return entry.p;
}

/** Data changed on the server (a revision event): reads started before now must not be reused or kept. */
export function invalidate() { generation++; }

/** Fired on window when the server says the session is over, so the app can show the sign-in page. */
export const SIGNED_OUT_EVENT = 'cf:signed-out';

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<string> {
  const gen = generation;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      // the server refuses changes without this header, so another site can't make them with your cookie (CSRF)
      headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-requested-with': 'companyflags' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, { error: 'can’t reach the server', code: 'offline' });   // fetch fails only when nothing answered
  }
  const text = await res.text();
  if (!res.ok) {
    let json: ErrorBody = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { error: text }; }
    if (res.status === 401 && path !== '/meta') (globalThis as { dispatchEvent?: (e: Event) => boolean }).dispatchEvent?.(new Event(SIGNED_OUT_EVENT));
    throw new ApiError(res.status, json);
  }
  if (method === 'GET') {
    if (gen === generation) {
      answers.delete(path);                                // newest last, so the oldest goes first when full
      answers.set(path, text);
      if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value!);
    }
  } else if (!READ_ONLY_POSTS.has(path)) {
    generation++;
    answers.clear();
  }
  return text;
}

export async function api<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  // the same GET asked for twice at once (a prefetch, then the page) goes to the server once
  const text = method === 'GET' && !Object.keys(headers).length ? await get(path) : await request(method, path, body, headers);
  return (text ? JSON.parse(text) : null) as T;
}

// Friendly names for evaluation reasons
export const REASON_LABEL: Record<string, string> = {
  TARGETING_MATCH: 'Rule matched', SPLIT: 'Rollout', DEFAULT: 'Default', STATIC: 'Default (no rules)',
  DISABLED: 'Flag is off', ERROR: 'Error', FLAG_NOT_FOUND: 'Not in this service', TYPE_MISMATCH: 'Wrong value type',
};
export const reasonLabel = (r: string) => REASON_LABEL[r] ?? r;

export const KIND_INFO: Record<string, string> = {
  release: 'Release — roll out a new feature, then remove the flag',
  kill_switch: 'Kill switch — turn something off fast in an emergency',
  ops: 'Ops — operational toggle, long-lived',
  experiment: 'Experiment — compare variants',
  config: 'Config — remote settings like URLs or limits',
  permission: 'Permission — who may use a feature (no percentage rollouts)',
};

export const fmtValue = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v));
export const ago = (iso?: string | null) => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < -60) {                                  // scheduled things: "in 5m", "in 3h", then the date
    const f = -s;
    if (f < 3600) return `in ${Math.round(f / 60)}m`;
    if (f < 86400) return `in ${Math.round(f / 3600)}h`;
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};
export const uuid = () => crypto.randomUUID();

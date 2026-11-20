// The draft session: one person's draft in one environment, in one place. A draft can span several flags there.
// The session opens a flag (the server's copy and any saved draft), takes edits through the lines.ts operations,
// says what they change (items, sentences, problems), notices when the server has a newer version, rebases onto it
// ("keep my edits on the new version") and publishes in the right order: hidden values, one submit, then clear.
//
// Drafts live in the browser. Each keeps the settings it was based on (that environment's layers with their
// versions, and the flag's variants), so publishing sends the versions the edits were made against: if someone else
// changed the flag since, the publish is refused instead of quietly overwriting their change, and the session
// offers the rebase. Whether publishing makes a change set is policy.ts needsReview.
//
// Plain TypeScript, no React: the console reaches it through useDraft.ts (localStorage and api()); tests use
// memoryStorage() and an HTTP adapter over the app's own request handler.
import { needsReview } from '../../server/policy.ts';
import { errorCode, type ErrorCode, type FlagDetail, type Meta } from './api.ts';
import { changes, lineProblem, ownIdsOf, sortLines, summarize, toDraft, valueEdits, valuesToCreate, type Draft, type Line, type PublishItem } from './lines.ts';

/** How the session reaches the server (api() in the browser). A failure throws an error carrying the server's `code`. */
export type Http = <T = any>(method: string, path: string, body?: unknown) => Promise<T>;
/** Where drafts are kept: localStorage in the browser, memoryStorage() in tests. */
export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
/** What the sentences, the checks and the publish rule need from /meta. */
export type DraftMeta = Pick<Meta, 'entities' | 'dimensions' | 'fields' | 'environments'>;
type EnvLayers = FlagDetail['layers'][string];

/** What a draft of one flag was made against: the flag's layers in this environment, with their versions, and what
 *  the sentences and checks need of the flag. Only this is stored, never the whole flag. */
export type BasedOn = Pick<FlagDetail, 'valueType' | 'kind' | 'variations'> & { layers: EnvLayers };

export type LineProblem = { line: string; problem: string };
export type DraftItem = PublishItem & { flag: string };
/** One flag in the draft, as people read it. `before`: each changed layer as it was (by entity, '' for everyone's),
 *  so the review shows it before and after, as the approver sees it. */
export type DraftFlag = {
  key: string; items: DraftItem[]; before: Record<string, EnvLayers['base'] | null>; sentences: string[]; problems: LineProblem[]; stale: boolean; at: string;
  /** named variants given a new value (the same in every environment) */
  values: { key: string; value: unknown; was: unknown }[];
};
/** The draft in this environment. */
export type DraftSummary = {
  flags: DraftFlag[];
  /** how many changes, as the review counts them (one per sentence) */
  changes: number;
  has: (flag: string) => boolean;
  /** flags the server has a newer version of: publishing is refused until they're rebased */
  stale: string[];
  /** a protected environment: publishing sends one change set for review */
  needsReview: boolean;
};
/** One flag, opened for editing. */
export type FlagView = {
  key: string;
  /** loading: no copy of the flag yet; error: the first load failed (`error` says why) */
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  /** what you edit against: the server's copy, with the settings a saved draft was based on in this environment */
  flag: FlagDetail | null;
  /** the server's copy now (the switch and the on/off state show this one) */
  live: FlagDetail | null;
  orig: Draft | null;
  draft: Draft | null;
  /** it differs from the settings it was based on (it's in the draft) */
  changed: boolean;
  items: DraftItem[];
  sentences: string[];
  problems: LineProblem[];
  stale: boolean;
};
export type Published = { applied: boolean; revision?: number; changeSetId?: number; flags: string[]; changes: number };
/** Something about keeping the draft the person should hear: an old saved draft dropped, or storage that refused it. */
export type DraftNotice = { kind: 'dropped' | 'not-saved'; message: string; flags: string[] };

const list = (xs: string[]) => (xs.length <= 3 ? xs.join(', ') : `${xs.slice(0, 2).join(', ')} and ${xs.length - 2} more`);

/** A publish refused before anything was sent: the server has a newer version of these flags. Rebase them first. */
export class StaleDraftError extends Error {
  readonly code: ErrorCode = 'stale';
  readonly flags: string[];
  constructor(flags: string[]) {
    super(`${list(flags)} changed since your draft began, so publishing would be refused: keep your edits on the new version first`);
    this.flags = flags;
  }
}

// ---------------------------------------------------------------- storage
// Version 2: one key per person and environment, so an edit writes only that environment's draft, and an entry holds
// only what the draft needs (BasedOn), not the whole flag. An entry that fails the shape check, or whose flag no
// longer exists, is dropped and reported.

const STORE = 2;
/** Where one person's draft in one environment is kept. */
export const storageKey = (person: string, env: string) => `cf.draft.v${STORE}.${person}.${env}`;
type StoredFlag = { based: BasedOn; ownIds: Record<string, string>; draft: Draft; at: string };
type Stored = { version: typeof STORE; flags: Record<string, StoredFlag> };

/** Drafts kept in memory: for tests, or a browser that has no storage for this page. */
export function memoryStorage(): DraftStorage & { keys: () => string[] } {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}
/** What the session uses of the browser window (none in Node tests: this module is typed without the DOM there). */
type BrowserWindow = {
  localStorage: DraftStorage;
  addEventListener: (type: 'pagehide' | 'storage', fn: (e: { key?: string | null }) => void) => void;
};
const browserWindow = () => (globalThis as { window?: BrowserWindow }).window;
/** The browser's localStorage, when there is a window and the page may use it. */
export function browserStorage(): DraftStorage | null {
  const w = browserWindow();
  if (!w) return null;
  try { return w.localStorage; } catch { return null; }
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isLayer = (l: unknown) => isObj(l) && typeof l.version === 'number' && Array.isArray(l.rules);
const isLine = (l: unknown) => isObj(l) && typeof l.id === 'string' && Array.isArray(l.conditions);
const isDraft = (d: unknown): d is Draft => isObj(d) && typeof d.fallback === 'string' && Array.isArray(d.lines) && d.lines.every(isLine)
  && isObj(d.newValues) && isObj(d.afterEveryone) && (d.variantValues === undefined || isObj(d.variantValues));

function isStoredFlag(e: unknown): e is StoredFlag {
  if (!isObj(e) || typeof e.at !== 'string' || !isObj(e.ownIds) || !isObj(e.based) || !isDraft(e.draft)) return false;
  const b = e.based;
  return typeof b.valueType === 'string' && typeof b.kind === 'string' && Array.isArray(b.variations) && isObj(b.layers)
    && isLayer(b.layers.base) && Array.isArray(b.layers.entities)
    && b.layers.entities.every((c: unknown) => isObj(c) && typeof c.entity === 'string' && isLayer(c.layer));
}

const droppedNotice = (env: string, flags: string[], why: 'shape' | 'no-flag' = 'shape'): DraftNotice => ({
  kind: 'dropped', flags,
  message: why === 'no-flag' ? `Your saved draft of ${list(flags)} in ${env} was dropped: the flag was archived or is no longer there.`
    : flags.length ? `Your saved draft of ${list(flags)} in ${env} couldn’t be read, so it was dropped.` : `Your saved draft in ${env} couldn’t be read, so it was dropped.`,
});

// ---------------------------------------------------------------- the session

const flagUrl = (key: string) => `/flags/${key}`;               // the same GET as paths.ts flagPath
const basedOf = (f: FlagDetail, env: string): BasedOn => ({ valueType: f.valueType, kind: f.kind, variations: f.variations, layers: f.layers[env] });
const inEnv = (env: string, layers: EnvLayers): Pick<FlagDetail, 'layers'> => ({ layers: { [env]: layers } });
/** The versions of a flag's layers in one environment: a newer server version changes this. */
const versions = (l: EnvLayers | undefined) =>
  JSON.stringify(l ? [l.base?.version ?? null, ...l.entities.map((c) => `${c.entity}:${c.layer.version}`).sort()] : null);
const now = () => new Date().toISOString();
/** The server says the flag isn't there. */
const gone = (e: unknown) => (e as { status?: number } | null)?.status === 404;

/** A flag with edits: the settings they were made against, the draft as it opened (orig) and as edited. */
type Entry = { based: BasedOn; orig: Draft; draft: Draft; at: string };
/** The latest copy of a flag from the server, and the draft it opens as. */
type Copy = { flag: FlagDetail; fresh: Draft };

export class DraftSession {
  readonly person: string;
  readonly env: string;
  private readonly http: Http;
  private readonly storage: DraftStorage | null;
  private readonly debounceMs: number;
  private entries = new Map<string, Entry>();
  private copies = new Map<string, Copy>();
  private failed = new Map<string, string>();      // a flag whose first load failed, and why
  private outdated = new Set<string>();            // another write path changed it: stale until a fresh copy says otherwise
  private asked = new Map<string, number>();       // the latest request per flag: an older answer that comes late is dropped
  private opened = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saved = true;                            // the last write reached storage (a failure is reported once)
  private notices: DraftNotice[] = [];
  private listeners = new Set<() => void>();
  private tick = 0;
  private summaryCache: { tick: number; meta: DraftMeta; value: DraftSummary } | null = null;
  private derived = new Map<string, { entry: Entry; copy: Copy | undefined; meta: DraftMeta; stale: boolean; value: DraftFlag }>();
  private views = new Map<string, { inputs: unknown[]; value: FlagView }>();
  private merged = new Map<string, { copy: Copy; based: BasedOn; flag: FlagDetail }>();
  private shown = new Map<string, Copy>();           // the console's last copy, shown until open() keeps it

  constructor(o: { person: string; env: string; http: Http; storage?: DraftStorage | null; debounceMs?: number }) {
    this.person = o.person;
    this.env = o.env;
    this.http = o.http;
    this.storage = o.storage ?? null;
    this.debounceMs = o.debounceMs ?? 400;
    this.load();
  }

  /** For useSyncExternalStore: called after every change. */
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  // ---- reading

  has(flag: string) { return this.entries.has(flag); }
  /** There is a copy of this flag from the server (or the console's last one). */
  loaded(flag: string) { return this.copies.has(flag); }

  /** The draft in this environment, as people read it. The same object until something changes. */
  summary(meta: DraftMeta): DraftSummary {
    const c = this.summaryCache;
    if (c && c.tick === this.tick && c.meta === meta) return c.value;
    const flags = [...this.entries.keys()].map((k) => this.flagOf(k, meta)!);
    const keys = new Set(flags.map((f) => f.key));
    const value: DraftSummary = {
      flags,
      changes: flags.reduce((n, f) => n + Math.max(f.sentences.length, 1), 0),
      has: (k) => keys.has(k),
      stale: flags.filter((f) => f.stale).map((f) => f.key),
      needsReview: needsReview(meta.environments.find((e) => e.key === this.env)),
    };
    this.summaryCache = { tick: this.tick, meta, value };
    return value;
  }

  /** One flag as its page shows it. The same object until that flag changes. `known`: the console's last copy of it,
   *  shown until there is one here (the page's first paint), the same object open() then keeps. */
  view(key: string, meta: DraftMeta, known?: FlagDetail): FlagView {
    const copy = this.copies.get(key) ?? (known ? this.firstCopy(key, known) : undefined);
    const entry = this.entries.get(key);
    const d = entry ? this.flagOf(key, meta) : null;
    const error = copy ? null : this.failed.get(key) ?? null;
    const stale = this.isStale(key);
    const inputs = [copy, entry, d, error, stale];
    const c = this.views.get(key);
    if (c && c.inputs.every((x, i) => x === inputs[i])) return c.value;
    const value: FlagView = {
      key, status: copy ? 'ready' : error ? 'error' : 'loading', error,
      flag: copy ? (entry ? this.editedAgainst(key, copy, entry.based) : copy.flag) : null,
      live: copy?.flag ?? null,
      orig: entry?.orig ?? copy?.fresh ?? null,
      draft: entry?.draft ?? copy?.fresh ?? null,
      changed: !!d, items: d?.items ?? [], sentences: d?.sentences ?? [], problems: d?.problems ?? [], stale,
    };
    this.views.set(key, { inputs, value });
    return value;
  }

  // ---- opening a flag

  /** Opens a flag. `known`, the console's last copy of it, shows at once until refresh() brings the server's.
   *  Returns close, which also writes what's waiting. */
  open(key: string, known?: FlagDetail): () => void {
    this.opened.set(key, (this.opened.get(key) ?? 0) + 1);
    const first = known && !this.copies.has(key) ? this.firstCopy(key, known) : undefined;
    if (first) { this.copies.set(key, first); this.bump(); }
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      const n = (this.opened.get(key) ?? 1) - 1;
      if (n > 0) this.opened.set(key, n); else this.opened.delete(key);
      this.flush();
    };
  }

  /** A fresh copy of the flag from the server. Edits are kept, still against the settings they were based on. */
  async refresh(key: string): Promise<void> {
    const mine = (this.asked.get(key) ?? 0) + 1;
    this.asked.set(key, mine);
    try {
      const f = await this.http<FlagDetail>('GET', flagUrl(key));
      if (this.asked.get(key) === mine) this.setCopy(key, f);
    } catch (e) {
      if (this.asked.get(key) !== mine) throw e;
      if (gone(e)) { this.copies.delete(key); this.dropGone(key); }
      if (!this.copies.has(key)) { this.failed.set(key, (e as Error).message); this.bump(); }
      throw e;
    }
  }

  // ---- editing

  /** One edit to one flag, made with the lines.ts operations. Lines are kept in evaluation order (sortLines). An
   *  edit that leaves the flag as it was based on takes it out of the draft. */
  edit(key: string, change: (draft: Draft) => Draft) {
    const entry = this.entries.get(key);
    const copy = this.copies.get(key);
    if (!entry && !copy) return;                                    // not open: nothing to edit against
    const based = entry?.based ?? basedOf(copy!.flag, this.env);
    const orig = entry?.orig ?? copy!.fresh;
    const before = entry?.draft ?? orig;
    const next = change(before);
    if (next === before) return;
    const draft = next.lines === before.lines ? next : { ...next, lines: sortLines(next.lines) };
    if (differs(based, this.env, orig, draft)) this.entries.set(key, { based, orig, draft, at: now() });
    else this.entries.delete(key);
    this.bump();
    this.schedule();
  }

  /** Drops these flags' edits (every flag's when left out). Returns Undo: the same edits, on the same settings. */
  discard(flags?: string[]): () => void {
    const gone = (flags ?? [...this.entries.keys()]).flatMap((k) => { const e = this.entries.get(k); return e ? [[k, e] as const] : []; });
    if (!gone.length) return () => {};
    for (const [k] of gone) this.entries.delete(k);
    this.bump();
    this.write();
    return () => {
      for (const [k, e] of gone) if (!this.entries.has(k)) this.entries.set(k, e);
      this.bump();
      this.write();
    };
  }

  // ---- newer versions

  /** Another write path in this browser changed these flags in this environment (an entity's "use its parent's
   *  again", the switch, the bulk bar): a draft of them is stale until a fresh copy says otherwise, and an open one
   *  shows the change. */
  async noteChanged(flags: string[]): Promise<void> {
    const ours = flags.filter((k) => this.entries.has(k) || this.copies.has(k) || this.opened.has(k));
    if (!ours.length) return;
    for (const k of ours) if (this.entries.has(k)) this.outdated.add(k);
    this.bump();
    await Promise.allSettled(ours.map((k) => this.refresh(k)));
  }

  /** Asks the server for every flag in the draft (or these) and answers which it has a newer version of. The review
   *  runs this when it opens, and publish before it sends anything. */
  async checkStale(flags: string[] = [...this.entries.keys()]): Promise<string[]> {
    const answers = await Promise.allSettled(flags.map((k) => this.refresh(k)));
    // a flag that no longer exists has left the draft (and was reported): that's not a failure
    const failed = answers.find((a): a is PromiseRejectedResult => a.status === 'rejected' && !gone(a.reason));
    if (failed) throw failed.reason;
    return flags.filter((k) => this.isStale(k));
  }

  /** "Keep my edits on the new version": each stale flag (or these) is based on a fresh server copy, with every line,
   *  default and choice I changed kept as I left it and everything else as the server has it now. */
  async rebase(flags?: string[]): Promise<string[]> {
    const keys = flags ?? [...this.entries.keys()].filter((k) => this.isStale(k));
    await this.checkStale(keys);
    const done: string[] = [];
    for (const k of keys) {
      const e = this.entries.get(k);
      const c = this.copies.get(k);
      if (!e || !c || !this.isStale(k)) continue;
      const theirs = toDraft(c.flag, this.env, ownIdsOf(e.orig));
      const draft = keepMine(e.orig, e.draft, theirs);
      const based = basedOf(c.flag, this.env);
      if (differs(based, this.env, theirs, draft)) this.entries.set(k, { based, orig: theirs, draft, at: now() });
      else this.entries.delete(k);
      done.push(k);
    }
    if (done.length) { this.bump(); this.write(); }
    return done;
  }

  // ---- publishing

  /** Publishes the whole draft: checks every flag for a newer version (refused with StaleDraftError if there is one),
   *  creates the values typed for single entities, sends every change in one submit (one version, or in a protected
   *  environment one change set), then clears what it sent. */
  async publish(o: { meta: DraftMeta; reason?: string; allowReshuffle?: boolean }): Promise<Published> {
    this.flush();
    if (!this.entries.size) throw new Error('your draft is empty');
    const reason = o.reason?.trim() ?? '';
    if (this.summary(o.meta).needsReview && !reason) throw new Error('add a reason for the reviewer');
    const stale = await this.checkStale();
    if (stale.length) throw new StaleDraftError(stale);
    const keys = [...this.entries.keys()];
    if (!keys.length) throw new Error('your draft is empty');
    const s = this.summary(o.meta);
    const sent = new Map(keys.map((k) => [k, this.entries.get(k)!]));
    // a value typed for one entity is created first: it changes nothing until a published rule uses it
    for (const [k, e] of sent) {
      const create = valuesToCreate(this.copies.get(k)?.flag ?? e.based, e.draft);
      if (create.length) await this.http('PUT', `/flags/${k}/variations`, { variations: create });
    }
    // then the new values of named variants (the same in every environment). The server refuses one that an environment
    // needing approval serves, or that a request waiting there uses (control.ts upsertVariations), so a value never
    // changes under an approver; a request sent below keeps the values it was sent with.
    for (const [k, e] of sent) {
      const edits = valueEdits(e.based, e.draft);
      if (edits.length) await this.http('PUT', `/flags/${k}/variations`, { variations: edits.map(({ key, value }) => ({ key, value })) });
    }
    const said = s.flags.flatMap((f) => f.sentences.map((l) => `${f.key}: ${l}`)).join('\n');
    const items = s.flags.flatMap((f) => f.items.map((i) => ({ ...i, allowReshuffle: o.allowReshuffle || undefined })));
    let res: { applied: boolean; revision?: number; changeSetId?: number };
    try {
      // only new values of variants: nothing in this environment's settings to publish
      res = !items.length ? { applied: true } : await this.http('POST', `/environments/${this.env}/publish`, {
        items, reason: reason ? `${reason}\n\n${said}` : said,
      });
    } catch (e) {
      // changed in the moment between the check and the submit: the same refusal, for the flag the server names
      if (errorCode(e) === 'conflict') {
        const named = (e as { body?: { flag?: unknown } }).body?.flag;
        const which = typeof named === 'string' && sent.has(named) ? [named] : keys;
        for (const k of which) this.outdated.add(k);
        this.bump();
        throw new StaleDraftError(which);
      }
      throw e;
    }
    // what was sent is no longer a draft (an edit made meanwhile stays), and the server's copies are out of date
    for (const [k, e] of sent) if (this.entries.get(k) === e) this.entries.delete(k);
    this.bump();
    this.write();
    void Promise.allSettled(keys.map((k) => this.refresh(k)));
    return { applied: res.applied, revision: res.revision, changeSetId: res.changeSetId, flags: keys, changes: s.changes };
  }

  // ---- keeping the draft

  /** Writes what's waiting now (the console also does this when the page is hidden). */
  flush() { if (this.timer !== null) this.write(); }
  /** Done with this session: what's waiting is written. */
  close() { this.flush(); this.listeners.clear(); }
  /** Another tab changed this draft: read it again (an edit still waiting here is written over it instead). */
  reread() {
    if (this.timer !== null) return;
    this.entries.clear();
    this.load();
    this.bump();
  }
  /** What the person should hear about keeping the draft, each once. */
  takeNotices(): DraftNotice[] {
    const n = this.notices;
    this.notices = [];
    return n;
  }

  // ---- inside

  private bump() {
    this.tick++;
    for (const l of [...this.listeners]) l();
  }

  private isStale(key: string) {
    const e = this.entries.get(key);
    if (!e) return false;
    if (this.outdated.has(key)) return true;
    const c = this.copies.get(key);
    if (!c) return false;
    // a variant whose value the draft changes, changed by someone else since
    const was = new Map(e.based.variations.map((v) => [v.key, JSON.stringify(v.value)]));
    const changedUnder = Object.keys(e.draft.variantValues ?? {})
      .some((k) => was.get(k) !== JSON.stringify(c.flag.variations.find((v) => v.key === k)?.value));
    return changedUnder || versions(c.flag.layers[this.env]) !== versions(e.based.layers);
  }

  private setCopy(key: string, flag: FlagDetail) {
    const prev = this.copies.get(key);
    if (prev && JSON.stringify(prev.flag) === JSON.stringify(flag)) {
      if (this.outdated.delete(key)) this.bump();
      return;
    }
    if (!flag.layers[this.env]) { this.failed.set(key, `${key} has no settings in this environment`); this.bump(); return; }
    if (flag.archivedAt) this.dropGone(key);                       // archived: a draft of it can never be published
    // the same stored layers open as the same lines (an "Own settings only" default keeps its id)
    const ids = prev ? ownIdsOf(prev.fresh) : this.entries.has(key) ? ownIdsOf(this.entries.get(key)!.orig) : {};
    this.copies.set(key, { flag, fresh: toDraft(flag, this.env, ids) });
    this.failed.delete(key);
    this.outdated.delete(key);
    this.bump();
  }

  /** A copy to open with before the server's comes, made once per object (so the view shows the same lines open keeps). */
  private firstCopy(key: string, flag: FlagDetail): Copy | undefined {
    if (!flag.layers[this.env]) return undefined;
    const had = this.shown.get(key);
    if (had?.flag === flag) return had;
    const entry = this.entries.get(key);
    const copy = { flag, fresh: toDraft(flag, this.env, entry ? ownIdsOf(entry.orig) : {}) };
    this.shown.set(key, copy);
    return copy;
  }

  /** The server's copy, with the settings the draft was based on in this environment (the same object per pair). */
  private editedAgainst(key: string, copy: Copy, based: BasedOn): FlagDetail {
    const m = this.merged.get(key);
    if (m && m.copy === copy && m.based === based) return m.flag;
    const flag = { ...copy.flag, layers: { ...copy.flag.layers, [this.env]: based.layers } };
    this.merged.set(key, { copy, based, flag });
    return flag;
  }

  private flagOf(key: string, meta: DraftMeta): DraftFlag | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    const copy = this.copies.get(key);
    const stale = this.isStale(key);
    const c = this.derived.get(key);
    if (c && c.entry === entry && c.copy === copy && c.meta === meta && c.stale === stale) return c.value;
    // the checks know the newest variants: one may have been added since the draft began
    const facts = { key, kind: copy?.flag.kind ?? entry.based.kind, valueType: copy?.flag.valueType ?? entry.based.valueType, variations: copy?.flag.variations ?? entry.based.variations };
    const items = changes(inEnv(this.env, entry.based.layers), this.env, entry.orig, entry.draft).map((i) => ({ ...i, flag: key }));
    const layers = entry.based.layers;
    const value: DraftFlag = {
      key, stale, at: entry.at, items,
      before: Object.fromEntries(items.map((i) => [i.entity ?? '', i.entity ? layers.entities.find((c) => c.entity === i.entity)?.layer ?? null : layers.base])),
      sentences: summarize(facts, entry.orig, entry.draft, meta),
      values: valueEdits(facts, entry.draft),
      problems: entry.draft.lines.flatMap((l) => {
        const problem = lineProblem(l, facts, entry.draft, meta.fields);
        return problem ? [{ line: l.id, problem }] : [];
      }),
    };
    this.derived.set(key, { entry, copy, meta, stale, value });
    return value;
  }

  private schedule() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.write(), this.debounceMs);
  }

  private write() {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
    if (!this.storage) return;
    const key = storageKey(this.person, this.env);
    try {
      if (!this.entries.size) this.storage.removeItem(key);
      else {
        const stored: Stored = {
          version: STORE,
          flags: Object.fromEntries([...this.entries].map(([k, e]) => [k, { based: e.based, ownIds: ownIdsOf(e.orig), draft: e.draft, at: e.at }])),
        };
        this.storage.setItem(key, JSON.stringify(stored));
      }
      this.saved = true;
    } catch (e) {
      // the draft stays in this tab; the person hears it once, not on every edit
      if (this.saved) {
        const full = (e as { name?: string })?.name === 'QuotaExceededError';
        this.report({
          kind: 'not-saved', flags: [...this.entries.keys()],
          message: `${full ? 'This browser’s storage is full' : 'This browser didn’t let the console save your draft'}, so your draft in ${this.env} is kept in this tab only: publish or discard it before you close the tab.`,
        });
      }
      this.saved = false;
    }
  }

  private load() {
    if (!this.storage) return;
    const key = storageKey(this.person, this.env);
    let raw: string | null = null;
    try { raw = this.storage.getItem(key); } catch { return; }       // storage that can't be read: an empty draft
    if (raw !== null) {
      let stored: unknown = null;
      try { stored = JSON.parse(raw); } catch { /* unreadable: dropped below */ }
      const current = isObj(stored) && stored.version === STORE && isObj(stored.flags);
      const flags: Record<string, unknown> = isObj(stored) && isObj(stored.flags) ? stored.flags : {};
      const dropped: string[] = [];
      for (const [k, e] of Object.entries(flags)) {
        const entry = current ? this.entryOf(e) : null;
        if (entry) this.entries.set(k, entry); else dropped.push(k);
      }
      if (!current || dropped.length) {
        this.report(droppedNotice(this.env, dropped));
        this.write();
      }
    }
  }

  /** A stored entry as the session keeps it, or null when it isn't in the shape this version stores. */
  private entryOf(stored: unknown): Entry | null {
    if (!isStoredFlag(stored)) return null;
    const e = stored;
    try {
      const orig = toDraft(inEnv(this.env, e.based.layers), this.env, e.ownIds);
      changes(inEnv(this.env, e.based.layers), this.env, orig, e.draft);      // throws on a draft it can't read
      return { based: e.based, orig, draft: e.draft, at: e.at };
    } catch {
      return null;
    }
  }

  /** The flag is no longer there (or archived): its draft can't be published, so it leaves the draft, said once. */
  private dropGone(key: string) {
    if (!this.entries.delete(key)) return;
    this.outdated.delete(key);
    this.report(droppedNotice(this.env, [key], 'no-flag'));
    this.write();
  }

  private report(n: DraftNotice) {
    this.notices.push(n);
    this.bump();
  }
}

// ---------------------------------------------------------------- the rebase
// A three-way merge of the draft as it opened (orig), as I left it (mine) and as the server has it now (theirs).
// What I changed is kept as I left it; everything else is theirs. Lines are matched by id (a rule's key; toDraft
// gives an "Own settings only" default the id it had in orig).

function keepMine(orig: Draft, mine: Draft, theirs: Draft): Draft {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const pick = <T>(o: T, m: T, t: T): T => (same(o, m) ? t : m);
  const byId = (d: Draft) => new Map(d.lines.map((l) => [l.id, l]));
  const O = byId(orig), M = byId(mine), T = byId(theirs);
  const mineChanged = (id: string) => M.has(id) && (!O.has(id) || !same(O.get(id), M.get(id)));
  // a line stays when I added or changed it, or when they have it and I didn't remove it
  const stays = (id: string) => mineChanged(id) || (T.has(id) && !(O.has(id) && !M.has(id)));
  const line = (id: string): Line => (mineChanged(id) ? M.get(id)! : T.get(id)!);
  // the order is mine where I moved lines, theirs otherwise; a line only the other side has goes right after the
  // line it follows there
  const order = (d: Draft, other: Map<string, Line>) => d.lines.filter((l) => other.has(l.id)).map((l) => l.id).join();
  const moved = order(orig, M) !== order(mine, O);
  const first = (moved ? mine : theirs).lines.map((l) => l.id).filter(stays);
  const inFirst = new Set(first);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of (moved ? theirs : mine).lines.map((l) => l.id).filter(stays)) {
    if (inFirst.has(id)) { anchor = id; continue; }
    const at = after.get(anchor);
    if (at) at.push(id); else after.set(anchor, [id]);
  }
  const ids = [...(after.get(null) ?? []), ...first.flatMap((id) => [id, ...(after.get(id) ?? [])])];
  const afterEveryone: Record<string, string> = {};
  for (const c of new Set([...Object.keys(orig.afterEveryone), ...Object.keys(mine.afterEveryone), ...Object.keys(theirs.afterEveryone)])) {
    const v = pick(orig.afterEveryone[c], mine.afterEveryone[c], theirs.afterEveryone[c]);
    if (v) afterEveryone[c] = v;
  }
  return {
    fallback: pick(orig.fallback, mine.fallback, theirs.fallback),
    lines: sortLines(ids.map(line)),
    newValues: { ...theirs.newValues, ...mine.newValues },
    afterEveryone,
    ...(mine.variantValues ? { variantValues: mine.variantValues } : {}),
  };
}

/** The draft changes something: a layer in this environment, or a variant's value. */
function differs(based: BasedOn, env: string, orig: Draft, draft: Draft): boolean {
  return changes(inEnv(env, based.layers), env, orig, draft).length > 0 || valueEdits(based, draft).length > 0;
}

// ---------------------------------------------------------------- the console's sessions
// One per person and environment, kept for the page's life: written when the page is hidden, read again when another
// tab changes it. Signing in as someone else closes the last person's.

const shared = new Map<string, DraftSession>();
let listening = false;

export function sharedSession(person: string, env: string, http: Http): DraftSession {
  for (const [k, s] of shared) if (s.person !== person) { s.close(); shared.delete(k); }
  const key = JSON.stringify([person, env]);
  let s = shared.get(key);
  if (!s) {
    s = new DraftSession({ person, env, http, storage: browserStorage() });
    shared.set(key, s);
  }
  const w = browserWindow();
  if (!listening && w) {
    listening = true;
    w.addEventListener('pagehide', () => { for (const x of shared.values()) x.flush(); });
    w.addEventListener('storage', (e) => { for (const x of shared.values()) if (e.key === storageKey(x.person, x.env)) x.reread(); });
  }
  return s;
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { createRoot } from 'react-dom/client';
import { api, ApiError, entityLabel, errorCode, invalidate, SIGNED_OUT_EVENT, title as dimTitle, type Meta } from './api.ts';
import { AppContext, go, type AppCtx, type DialogOpts } from './app.ts';
import { pageEnv, preload, routeParts } from './paths.ts';
import { useDraftNotices } from './useDraft.ts';
import { Actions, Field, Modal } from './ui.tsx';
import { textareaField } from './uiKit.ts';
import { Footer, MobileNav, Sidebar, TitleBar } from './shell.tsx';
import { signOut } from './session.ts';
import { ErrorBoundary } from './errorBoundary.tsx';
import { EnvChip, RouteSkeleton } from './loading.tsx';
import { writePersistent } from './persist.ts';
import { JoinSkeleton, ResetSkeleton, SignInSkeleton } from './signinFrame.tsx';
import { lastSignedIn, rememberSignedIn, signInInfo } from './signinKit.ts';
import { bootProblem } from './text.ts';
import { Button } from '@companyflags/ui/components/button';
import { AppFrame, MainPane } from '@companyflags/ui/components/app-frame';
import { Toaster, notify } from '@companyflags/ui/components/toast';
import { initTheme } from '@companyflags/ui/lib/theme';
import { applyLook, currentLook, loadLook, lookName, useLook } from './appearanceKit.ts';
import { Banner } from './look.tsx';
import { SettingsFrame } from './pages/settingsFrame.tsx';
import { isSettingsKey, SETTINGS } from './pages/settingsKit.ts';
import './index.css';

// Each page is its own chunk, fetched the first time it's opened (or when a link to it is hovered: paths.ts).
const PAGE_CODE = {
  flags: () => import('./pages/Flags.tsx'),
  flag: () => import('./pages/FlagPage.tsx'),
  releases: () => import('./pages/Releases.tsx'),
  release: () => import('./pages/ReleasePage.tsx'),
  approvals: () => import('./pages/Approvals.tsx'),
  dimensions: () => import('./pages/Entities.tsx'),
  compare: () => import('./pages/Compare.tsx'),
  keys: () => import('./pages/Keys.tsx'),
  tokens: () => import('./pages/Tokens.tsx'),
  history: () => import('./pages/History.tsx'),
  settings: () => import('./pages/Settings.tsx'),
  people: () => import('./pages/People.tsx'),
  migration: () => import('./pages/Migration.tsx'),
  webhooks: () => import('./pages/Webhooks.tsx'),
} as const;
const Flags = lazy(() => PAGE_CODE.flags().then((m) => ({ default: m.Flags })));
const FlagPage = lazy(() => PAGE_CODE.flag().then((m) => ({ default: m.FlagPage })));
const Releases = lazy(() => PAGE_CODE.releases().then((m) => ({ default: m.Releases })));
const ReleasePage = lazy(() => PAGE_CODE.release().then((m) => ({ default: m.ReleasePage })));
const Approvals = lazy(() => PAGE_CODE.approvals().then((m) => ({ default: m.Approvals })));
const DimensionPage = lazy(() => PAGE_CODE.dimensions().then((m) => ({ default: m.DimensionPage })));
const EntityPage = lazy(() => PAGE_CODE.dimensions().then((m) => ({ default: m.EntityPage })));
const Compare = lazy(() => PAGE_CODE.compare().then((m) => ({ default: m.Compare })));
const Keys = lazy(() => PAGE_CODE.keys().then((m) => ({ default: m.Keys })));
const Tokens = lazy(() => PAGE_CODE.tokens().then((m) => ({ default: m.Tokens })));
const History = lazy(() => PAGE_CODE.history().then((m) => ({ default: m.History })));
const Settings = lazy(() => PAGE_CODE.settings().then((m) => ({ default: m.Settings })));
// the first-run steps (pages/setup.tsx), which the Flags list also shows until apps can read flags
const GetStarted = lazy(() => import('./pages/setup.tsx').then((m) => ({ default: m.GetStarted })));
const People = lazy(() => PAGE_CODE.people().then((m) => ({ default: m.People })));
const Migration = lazy(() => PAGE_CODE.migration().then((m) => ({ default: m.Migration })));
const Webhooks = lazy(() => PAGE_CODE.webhooks().then((m) => ({ default: m.Webhooks })));
// signing in needs Better Auth's client; people who are signed in never download it
const SIGN_IN_CODE = () => import('./signin.tsx');
const SignInPage = lazy(() => SIGN_IN_CODE().then((m) => ({ default: m.SignInPage })));
const JoinPage = lazy(() => SIGN_IN_CODE().then((m) => ({ default: m.JoinPage })));
const ResetPage = lazy(() => SIGN_IN_CODE().then((m) => ({ default: m.ResetPage })));

/** Starts downloading the code of the page at this address. Never fails (a failed chunk shows in the page). */
const loadPageCode = (hash: string): Promise<unknown> => {
  const [first, second] = routeParts(hash) ?? [];
  const page = (first === 'settings' && second === 'people' ? 'people' : first) as keyof typeof PAGE_CODE | undefined;
  return page && page in PAGE_CODE ? PAGE_CODE[page]().catch(() => {}) : Promise.resolve();
};

// The page waits up to this long for the next page's code and first answer before switching, as Next.js does
// with a prefetched route: the old page stays on screen instead of a placeholder flashing in and being replaced.
const NAV_WAIT_MS = 300;

// the address in the window; no page (or just "#/") opens the flag list
const currentHash = () => (location.hash.length > 2 ? location.hash : '#/flags');
// a link that can't be decoded (e.g. "#/flag/%E0%A4%A") is a page that doesn't exist, not a crash
const BAD_ADDRESS = ['\u0000bad-address'];
const routeOf = (hash: string) => routeParts(hash) ?? BAD_ADDRESS;

// The console's pages and what each needs in its address. Anything else is "Page not found".
function knownRoute([page, a]: string[]): boolean {
  switch (page) {
    case 'flag': case 'release': case 'dimensions': return !!a;
    case 'approvals': return !a || /^\d+$/.test(a);
    case 'settings': return !a || isSettingsKey(a);
    case 'flags': case 'releases': case 'compare': case 'keys': case 'tokens': case 'history': case 'migration': case 'webhooks': return true;
    default: return false;
  }
}

function NotFound() {
  return (
    <div className="grid max-w-[620px] content-start gap-4 p-12 max-sm:p-6">
      <h1 className="m-0 text-[28px] leading-tight font-semibold text-ink">Page not found</h1>
      <p className="m-0 text-ink-2">There’s no page at this address. It may have been mistyped, or the link may be from an older version of the console.</p>
      <div><Button onClick={() => go('flags')}>Go to flags</Button></div>
    </div>
  );
}

/** The tab's title for each page, so tabs and history entries can be told apart. */
function titleFor([page, a, b]: string[], meta: Meta | null): string {
  const name: Record<string, string> = {
    flags: 'Flags', releases: 'Releases', compare: 'Compare', keys: 'API keys', tokens: 'Access tokens', history: 'History', settings: 'Settings', approvals: 'Approvals', migration: 'Migration', webhooks: 'Webhooks', join: 'Join',
  };
  const dim = page === 'dimensions' && a ? meta?.dimensions.find((d) => d.key === a) : undefined;
  const dimName = dim ? dimTitle(dim) : a;
  const title = page === 'flag' && a ? `${a} · Flags`
    : page === 'release' && a ? `${a} · Releases`
    : page === 'dimensions' && a && b ? `${meta ? entityLabel(meta.entities, b) : b} · ${dimName}`
    : page === 'dimensions' && a ? dimName ?? 'Page not found'
    : page === 'approvals' && a ? `Request #${a} · Approvals`
    : page === 'settings' && a && isSettingsKey(a) ? `${SETTINGS.find((s) => s.key === a)?.label} · Settings`
    : name[page] ?? 'Page not found';
  return `${title} · ${lookName()}`;
}

function useGuardedRoute(isDirty: () => boolean, confirmLeave: () => Promise<boolean>, load: (hash: string) => Promise<unknown>) {
  const [hash, setHash] = useState(currentHash);
  const [waiting, setWaiting] = useState(false);
  // a page whose code is still downloading keeps the old page on screen (and the progress line) until it's in
  const [switching, startSwitch] = useTransition();
  const current = useRef(hash);
  const skip = useRef(false);
  const seq = useRef(0);
  useEffect(() => {
    const on = async () => {
      const next = currentHash();
      if (skip.current) { skip.current = false; return; }
      if (next !== current.current && isDirty()) {
        // Stay put until the user decides. `replace` swaps the history entry instead of adding one, so going
        // back after "Discard changes" doesn't return to the page you just left.
        skip.current = true;
        location.replace(current.current);
        if (!(await confirmLeave())) return;
        skip.current = true;
        location.replace(next);
      }
      const mine = ++seq.current;
      setWaiting(true);
      await Promise.race([load(next), new Promise((r) => setTimeout(r, NAV_WAIT_MS))]);
      if (mine !== seq.current) return;              // another link was clicked meanwhile: that one wins
      current.current = next;
      setWaiting(false);
      startSwitch(() => setHash(next));
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, [isDirty, confirmLeave, load]);
  const route = useMemo(() => routeOf(hash), [hash]);
  return { route, waiting: waiting || switching };
}

// pages built as dense console pages (full width, sticky page bar); the rest sit in a centred column
const DENSE = new Set(['flags', 'flag', 'releases', 'release', 'dimensions', 'compare', 'approvals', 'keys', 'tokens', 'history', 'settings', 'migration']);
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

type Answer = { action: string | null; reason: string };
type OpenDialog = DialogOpts & { id: number; resolve: (r: Answer) => void };

// The first page needs /meta before anything else: ask for it while React is still starting, and the code of the page
// at this address (or, for someone who was signed out last time, the sign-in page's) at the same time.
let bootMeta: Promise<Meta> | null = api<Meta>('GET', '/meta');
bootMeta.catch(() => {});
const signedInBefore = lastSignedIn();
if (routeOf(currentHash())[0] === 'join' || routeOf(currentHash())[0] === 'reset' || signedInBefore === false) { SIGN_IN_CODE().catch(() => {}); signInInfo().catch(() => {}); }
else void loadPageCode(currentHash());
const fetchMeta = () => {
  const p = bootMeta ?? api<Meta>('GET', '/meta');
  bootMeta = null;
  return p;
};

function App() {
  useLook();                                   // the name in the tab's title follows Settings → Appearance
  const [meta, setMeta] = useState<Meta | null>(null);
  const [tick, setTick] = useState(0);
  const [pending, setPending] = useState(0);
  const [synced, setSynced] = useState(true);
  const pane = useRef<HTMLElement>(null);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const openDialog = useRef<OpenDialog | null>(null);
  const dialogSeq = useRef(0);
  const dirty = useRef(new Set<string>());
  const setDirty = useCallback((key: string, on: boolean) => { if (on) dirty.current.add(key); else dirty.current.delete(key); }, []);
  // One dialog at a time: a new question answers the open one with "no answer" (as if it was closed), so
  // nothing waits forever on a dialog that's gone.
  const ask = useCallback((o: DialogOpts) => new Promise<Answer>((resolve) => {
    openDialog.current?.resolve({ action: null, reason: '' });
    const d: OpenDialog = { ...o, id: ++dialogSeq.current, resolve };
    openDialog.current = d;
    setDialog(d);
  }), []);
  const closeDialog = useCallback((d: OpenDialog, r: Answer) => {
    d.resolve(r);
    if (openDialog.current === d) { openDialog.current = null; setDialog(null); }
  }, []);
  const isDirty = useCallback(() => dirty.current.size > 0, []);
  const confirmLeave = useCallback(async () => {
    const r = await ask({ title: 'Discard unsaved changes?', body: 'You have edits that are not saved. Leaving this page will lose them.',
      actions: [{ id: 'stay', label: 'Keep editing' }, { id: 'leave', label: 'Discard changes', tone: 'danger' }] });
    if (r.action === 'leave') { dirty.current.clear(); return true; }
    return false;
  }, [ask]);
  // what the next page needs first (its code, and its first answer: paths.ts), fetched before switching to it
  const metaRef = useRef<Meta | null>(null);
  useEffect(() => { metaRef.current = meta; }, [meta]);
  const loadPage = useCallback((hash: string) => Promise.all([
    loadPageCode(hash),
    metaRef.current ? preload(hash, metaRef.current) : undefined,
  ]), []);
  const { route, waiting } = useGuardedRoute(isDirty, confirmLeave, loadPage);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { if (dirty.current.size) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, []);

  // The first time, the app frame's placeholders stay until the page's code is in (so no placeholder of its own flashes
  // first), and for a moment for its first answer too, as navigation does (NAV_WAIT_MS).
  const opened = useRef(false);
  const reload = useCallback(async () => {
    const m = await fetchMeta();
    rememberSignedIn(true);
    writePersistent('shell.envs', m.environments.length);
    if (!opened.current) {
      opened.current = true;
      const hash = currentHash();
      await Promise.all([loadPageCode(hash), Promise.race([preload(hash, m), new Promise((r) => setTimeout(r, NAV_WAIT_MS))])]);
    }
    setMeta(m);
    // the sidebar's count: requests waiting that this person may approve (not their own, not approved by them yet)
    setPending(m.pendingApprovals);
  }, []);
  const [bootError, setBootError] = useState<{ message: string; status: number } | null>(null);
  useEffect(() => {
    reload().then(() => setBootError(null), (e) => {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 401) { rememberSignedIn(false); signInInfo().catch(() => {}); }
      setBootError({ message: e instanceof Error ? e.message : String(e), status });
    });
  }, [reload]);
  // the session ended (expired, or an admin removed access): show the sign-in page instead of failing every action
  useEffect(() => {
    const out = () => { rememberSignedIn(false); setMeta(null); setBootError({ message: 'not signed in', status: 401 }); };
    addEventListener(SIGNED_OUT_EVENT, out);
    return () => removeEventListener(SIGNED_OUT_EVENT, out);
  }, []);

  // Live updates. Bursts of revision events (one per environment) are combined; the app's data is reloaded
  // first and the pages after, so they render once with the new data. A failed connection (an HTTP error:
  // a restart, an expired session) is retried with backoff, and changes missed while it was down are caught up.
  const signedIn = meta !== null;
  useEffect(() => {
    if (!signedIn) return;
    let es: EventSource | null = null;
    let retryIn = 1000;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let burstTimer: ReturnType<typeof setTimeout> | undefined;
    let openedBefore = false;
    let stopped = false;
    const refresh = () => {
      invalidate();
      clearTimeout(burstTimer);
      burstTimer = setTimeout(() => { reload().catch(() => {}).finally(() => setTick((t) => t + 1)); }, 150);
    };
    const connect = () => {
      es = new EventSource('/api/events');
      es.addEventListener('revision', refresh);
      es.onopen = () => {
        setSynced(true);
        retryIn = 1000;
        if (openedBefore) refresh();               // back after an outage: catch up
        openedBefore = true;
      };
      es.onerror = () => {
        setSynced(false);
        // the browser retries a dropped connection itself, but gives up for good after an HTTP error
        if (es?.readyState === EventSource.CLOSED && !stopped) {
          es.close();
          es = null;
          retryTimer = setTimeout(connect, retryIn);
          retryIn = Math.min(retryIn * 2, 30_000);
        }
      };
    };
    connect();
    return () => { stopped = true; clearTimeout(retryTimer); clearTimeout(burstTimer); es?.close(); };
  }, [signedIn, reload]);

  // one toast at a time, at the bottom right of the main pane (the shared Toaster); errors in red
  // errors say what happened in a sentence and offer the next step (Nielsen 9): stale data → Reload, offline → Reload.
  // Which is which comes from the error's code (api.ts ErrorCode), never from its words.
  const toast = useCallback((m: string | Error, kind?: 'ok' | 'err', action?: { label: string; onClick: () => void }) => {
    const said = typeof m === 'string' ? m : m.message;
    if ((kind ?? (typeof m === 'string' ? 'ok' : 'err')) !== 'err') { notify(said, action); return; }
    const code = errorCode(m);
    const offline = code === 'offline';
    const stale = code === 'conflict' || code === 'stale';
    const sentence = /^[a-z]+\s/.test(said) ? said.charAt(0).toUpperCase() + said.slice(1) : said;   // never capitalise a key ("new_checkout …")
    const text = offline ? 'Can’t reach the server. Check that it’s running, then reload.' : sentence;
    const refresh = { label: 'Reload', onClick: () => { invalidate(); reload().catch(() => {}).finally(() => setTick((t) => t + 1)); } };
    notify(text, action ?? (offline || stale ? refresh : undefined), { tone: 'error', timeout: 10000 });
  }, [reload]);

  const page = route[0];
  const routeKey = route.join('/');
  // the window doesn't scroll, the main pane does: start each page at its top
  useEffect(() => { pane.current?.scrollTo({ top: 0 }); }, [routeKey]);

  // Search flags (sidebar, ⌘K on a Mac, Ctrl+K elsewhere): open the flag list and put the cursor in its search
  // box once that page is on screen (its code may still be downloading, or a "discard changes?" may be open).
  const wantSearch = useRef(false);
  const pageRef = useRef(page);
  useEffect(() => { pageRef.current = page; }, [page]);
  const focusSearch = useCallback(() => {
    let frames = 0;
    const tryFocus = () => {
      if (!wantSearch.current || pageRef.current !== 'flags') return;
      const box = document.querySelector<HTMLInputElement>('[data-search="flags"]');
      if (box) { box.focus(); box.select(); wantSearch.current = false; } else if (frames++ < 120) requestAnimationFrame(tryFocus);
    };
    tryFocus();
  }, []);
  const searchFlags = useCallback(() => {
    wantSearch.current = true;
    if (pageRef.current !== 'flags') go('flags'); else focusSearch();
  }, [focusSearch]);
  useEffect(() => {
    if (page === 'flags' && !waiting && wantSearch.current) focusSearch();
    if (page !== 'flags' && !waiting) wantSearch.current = false;
  }, [page, waiting, focusSearch]);
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      // Ctrl+K in a text field on a Mac deletes to the end of the line: leave it alone there
      if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || !(isMac ? e.metaKey : e.ctrlKey)) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      searchFlags();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [searchFlags]);

  const ctx = useMemo<AppCtx | null>(() => (meta ? {
    meta, reload, user: meta.me.key, revisionTick: tick, pendingApprovals: pending, toast, ask, setDirty,
  } : null), [meta, reload, tick, pending, toast, ask, setDirty]);
  const title = <title>{titleFor(route, meta)}</title>;

  // an invite link opens its own page, signed in or not; while their code downloads, the sign-in pages show their shape
  if (page === 'join' && route[1]) return <Suspense fallback={<JoinSkeleton />}>{title}<JoinPage token={route[1]} /></Suspense>;
  // a password reset link too: it works signed in or not
  if (page === 'reset' && route[1]) return <Suspense fallback={<ResetSkeleton />}><title>{`New password · ${lookName()}`}</title><ResetPage token={route[1]} /></Suspense>;
  if (!meta && bootError?.status === 401) return <Suspense fallback={<SignInSkeleton />}><title>{`Sign in · ${lookName()}`}</title><SignInPage /></Suspense>;
  if (!meta && bootError) {
    // which it is comes from the status: nothing answered (0), no access (403), or an answer that is an error
    const problem = bootProblem(bootError.status, bootError.message);
    return (
      <div role="alert" className="grid max-w-[560px] gap-3 p-12 text-sm text-ink-1">
        <p className="m-0 text-base font-medium text-ink">{problem.title}</p>
        <p className="m-0 text-ink-2">{problem.text}</p>
        <div>{bootError.status === 403 ? <Button variant="secondary" onClick={() => void signOut()}>Sign out</Button> : <Button onClick={() => location.reload()}>Reload</Button>}</div>
      </div>
    );
  }
  // While /meta answers (the first load): someone who was signed out last time most likely signs in now, so the
  // sign-in page's shape; someone who was signed in gets the console's frame with the page's shape in it (loading.tsx).
  // A browser that hasn't opened the console yet shows nothing until the server says which.
  if (!meta && signedInBefore === false) return <><title>{`Sign in · ${lookName()}`}</title><SignInSkeleton /></>;
  if (!meta && signedInBefore === null) return title;
  // nothing is set up yet: every page needs an environment, so Settings comes first
  const setUp = !meta || meta.environments.length > 0 || page === 'settings';
  // a flag's or a release's shape has its environment chip, once the console knows the environments
  const detailEnv = meta && (page === 'flag' || page === 'release') && route[1]
    ? meta.environments.some((e) => e.key === route[2]) ? route[2] : pageEnv(meta) : null;
  const skeleton = <RouteSkeleton route={route} env={meta && detailEnv ? <EnvChip meta={meta} env={detailEnv} to={(v) => `${page}/${route[1]}/${v}`} /> : undefined} />;

  return (
    <AppContext value={ctx}>
      {title}
      <AppFrame
        titleBar={<><Banner banner={meta?.banner} /><TitleBar synced={synced} /></>}
        sidebar={<Sidebar meta={meta} page={page} sub={route[1]} pending={pending} onSearch={searchFlags} className="max-md:hidden" />}
        footer={<><Footer meta={meta} /><MobileNav meta={meta} page={page} sub={route[1]} pending={pending} onSearch={searchFlags} /></>}>
          {/* on a phone the sidebar is hidden, so the page takes the frame's second row (the first stays empty) */}
          <MainPane id="main" wide fluid={DENSE.has(page)} key={meta?.me.key} ref={pane} aria-busy={waiting || !meta || undefined} className="max-md:row-start-2">
              {waiting && <div data-nav-progress aria-hidden
                className="sticky top-0 z-30 -mb-0.5 h-0.5 origin-left bg-tint [animation:nav-progress_.3s_ease-out_.12s_both]" />}
              {!meta ? skeleton : (
                // Outside the page's own boundary, so it stays the same one from page to page: a page whose code is still
                // downloading keeps the old page on screen (useGuardedRoute's transition). The first page shows its shape.
                <Suspense fallback={skeleton}>
                  {/* a crash in a page shows in its place; another address starts that page fresh */}
                  <ErrorBoundary key={routeKey} where={page}>
                    {!knownRoute(route) ? <NotFound /> : page === 'settings' ? <SettingsFrame sub={route[1]}>{route[1] === 'people' ? <People /> : <Settings section={route[1]} />}</SettingsFrame>
                      : page === 'tokens' ? <Tokens />
                      : page === 'webhooks' ? <Webhooks />
                      : !setUp ? <GetStarted /> : <>
                      {page === 'flags' && <Flags envKey={route[1]} tab={route[2]} />}
                      {page === 'flag' && route[1] && <FlagPage flagKey={route[1]} envKey={route[2]} />}
                      {page === 'releases' && <Releases envKey={route[1]} />}
                      {page === 'release' && route[1] && <ReleasePage flagKey={route[1]} envKey={route[2]} />}
                      {page === 'approvals' && <Approvals selected={route[1] ? Number(route[1]) : undefined} />}
                      {page === 'dimensions' && route[1] && !route[2] && <DimensionPage dimensionKey={route[1]} />}
                      {page === 'dimensions' && route[1] && route[2] && <EntityPage dimensionKey={route[1]} entityKey={route[2]} envKey={route[3]} view={route[4]} />}
                      {page === 'compare' && <Compare />}
                      {page === 'keys' && <Keys />}
                      {page === 'history' && <History />}
                      {page === 'migration' && <Migration />}
                    </>}
                  </ErrorBoundary>
                </Suspense>
              )}
          </MainPane>
      </AppFrame>
      {dialog && <DialogView key={dialog.id} d={dialog} onDone={(r) => closeDialog(dialog, r)} />}
      {meta && <DraftNotices />}
      <Toaster />
    </AppContext>
  );
}

/** What the person should hear about keeping their drafts, wherever they are in the console (useDraft.ts). */
function DraftNotices() {
  useDraftNotices();
  return null;
}

function DialogView({ d, onDone }: { d: DialogOpts; onDone: (r: Answer) => void }) {
  const [reason, setReason] = useState('');
  return (
    <Modal title={d.title} onClose={() => onDone({ action: null, reason })} footer={
      <Actions>
        {d.actions.map((a) => (
          <Button key={a.id} variant={a.tone === 'primary' ? 'default' : a.tone === 'danger' ? 'stop' : 'secondary'} disabled={a.needsReason && !reason.trim()}
            onClick={() => onDone({ action: a.id, reason: reason.trim() })}>{a.label}</Button>
        ))}
      </Actions>
    }>
      <div className="grid gap-2 text-sm text-ink-1 [&_p]:m-0">{d.body}</div>
      {d.reason && (
        <Field label={d.reason.label} hint={d.reason.hint}>
          <textarea rows={2} data-autofocus value={reason} placeholder={d.reason.placeholder} onChange={(e) => setReason(e.target.value)} className={textareaField} />
        </Field>
      )}
    </Modal>
  );
}

initTheme();
// the installation's look: as this browser last saw it at once, then as the server says now (appearanceKit.ts)
applyLook(currentLook());
void loadLook();
createRoot(document.getElementById('root')!, {
  onUncaughtError: (error, info) => console.error('Uncaught error', error, info.componentStack),
}).render(<ErrorBoundary where="app"><App /></ErrorBoundary>);

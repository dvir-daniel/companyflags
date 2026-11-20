import { use, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeftIcon, CaretLeftIcon } from '@phosphor-icons/react';
import { tableHeadClass, tableRowClass } from '@companyflags/ui/components/data-table';
import { FilterSelect, PageBar } from '@companyflags/ui/components/page-bar';
import { Panel } from '@companyflags/ui/components/panel';
import { cn } from '@companyflags/ui/lib/utils';
import { dimensionOf, title as titleOf, type Meta } from './api.ts';
import { AppContext, go } from './app.ts';
import { perWho } from './dimWords.ts';
import { HowItWorksLink } from './howItWorks.tsx';
import { FLAG_TABS, RELEASE_TABS } from './loadingKit.ts';
import { LADDER } from '../../server/release.ts';

/*
 * Loading, without anything moving. A page draws in its final shape at once: its bar and title, its tabs and filters,
 * its table head, and placeholders (bones) where the data goes, each the size of what replaces it. Rows are as tall as
 * real rows, and counts and pagers keep their room, so nothing below moves when the answer comes.
 *
 * Bones show only after a moment (index.css .bone), so a load that finishes sooner flashes nothing, and they pulse
 * only for people who haven't asked for less motion. A page you've seen opens with its last answer instead (api.ts
 * peek), and navigation waits briefly for the next page's first answer (main.tsx), so most of the time no bone shows.
 *
 * This module is part of the console's first download: the app frame shows these shapes while a page's own code
 * is still on its way (main.tsx RouteSkeleton), and the pages show the same ones while their data is.
 */

/** A placeholder for a piece of text or a control: a grey bar, `h-2.5` unless the class says otherwise. */
export function Bone({ className, style }: { className?: string; style?: CSSProperties }) {
  return <span aria-hidden data-bone className={cn('bone inline-block h-2.5 max-w-full bg-rule align-middle', className)} style={style} />;
}

// cell widths, so placeholder rows don't look like a striped wall
const WIDTHS = ['w-4', 'w-3/4', 'w-10', 'w-1/2', 'w-2/3', 'w-1/2', 'w-3/5', 'w-12'];

/**
 * Placeholder rows in a table's own grid. `rowClass` makes them as tall as the page's real rows (the same class the
 * real rows use), `cells` gives each cell's extra classes (the ones that hide columns on small screens). There are
 * enough of them to fill a tall window, so the first real rows land where the placeholders were.
 */
export function SkeletonRows({ cols, cells, rows = 14, rowClass, style }: { cols: string; cells: string[]; rows?: number; rowClass?: string; style?: CSSProperties }) {
  return (
    <div aria-hidden data-slot="table-skeleton">
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className={cn(cols, tableRowClass, 'hover:bg-transparent', rowClass)} style={style}>
          {cells.map((extra, c) => (
            <Bone key={c} className={cn('block', WIDTHS[c % WIDTHS.length], extra)} style={{ '--bone-delay': `${r * 60}ms` } as CSSProperties} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * A page bar's count ("73", "12 of 73"): a bone until it's known, in room for three characters either way, so the
 * filters after it stay put when it arrives.
 */
export function CountSlot({ text }: { text?: ReactNode }) {
  // the bone sits on a line of (invisible) text, so the title beside it stays on the same baseline as with the count
  return <span className="inline-block min-w-[3ch]">{text ?? <>{'​'}<Bone className="w-[3ch]" /></>}</span>;
}

/** A row of tabs (Tabs from the shared library) whose names aren't known yet. */
export function TabsSkeleton({ widths = ['w-12', 'w-16', 'w-14'] }: { widths?: string[] }) {
  return (
    <div className="border-b border-rule px-6 max-sm:px-4">
      <div aria-hidden className="flex h-11 items-center gap-6">{widths.map((w, i) => <Bone key={i} className={w} />)}</div>
    </div>
  );
}

/** A flag's or a release's environment chip, as its page draws it; `to`: the address of the same page in another one. */
export function EnvChip({ meta, env, to }: { meta: Meta; env: string; to: (env: string) => string }) {
  const name = (k: string) => meta.environments.find((e) => e.key === k)?.name || k;
  return (
    <FilterSelect label="Environment" value={env} display={name(env)} onChange={(v) => go(to(v))}
      options={meta.environments.map((e) => [e.key, name(e.key)] as [string, string])} />
  );
}

/** The back arrow at the left of a detail page's bar (a flag, a release). */
export function BackArrow({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} aria-label={label} className="-ml-2 inline-grid size-8 shrink-0 place-items-center text-ink-2 no-underline transition-colors duration-150 hover:bg-wash hover:text-ink">
      <ArrowLeftIcon className="size-4" />
    </a>
  );
}

/**
 * A flag's or a release's bar before the flag is in: the back arrow, the name and key as bones, the environment
 * (`env`: its chip, once the console knows its name) and the on/off state with its switch.
 */
export function DetailBarSkeleton({ back, backLabel, env, copy }: { back: string; backLabel: string; env?: ReactNode; copy?: boolean }) {
  return (
    <PageBar
      title={<span className="flex min-w-0 items-center gap-1.5"><BackArrow href={back} label={backLabel} /><Bone className="h-3.5 w-40 max-sm:w-24" /></span>}
      actions={<><Bone className="w-8" /><Bone className="h-8 w-[76px]" /></>}>
      <Bone className="w-28 max-sm:w-20" />
      {copy && <span className="-ml-2 inline-block size-8 shrink-0" />}
      {env ?? <Bone className="h-8 w-44" />}
    </PageBar>
  );
}

/** The flag page's Rules tab before the flag is in: the "check who gets what" strip and the three layers. */
export function FlagRulesSkeleton() {
  const bones = <><Bone className="w-56 max-w-[60%]" /></>;
  const dims = use(AppContext)?.meta.dimensions ?? [];
  return (
    <div aria-busy className="px-6 pb-10 max-sm:px-4">
      <section aria-label="Check who gets what" className="mt-6 border border-grid bg-panel px-5 py-3 max-sm:px-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {/* the page's own sentence, so it wraps as the page does at every width */}
          <p className="m-0 min-w-0 flex-1 basis-[260px] text-13 text-ink-2">Checked from the top. The first row that matches decides. <HowItWorksLink /></p>
          <span className="flex flex-wrap items-center gap-2 max-sm:w-full">
            <Bone className="h-8 w-[240px] max-sm:min-w-0 max-sm:flex-1" />
            <Bone className="h-8 w-24" />
          </span>
        </div>
      </section>
      <Panel n={1} title="Overrides" desc={bones} actions={<Bone className="h-8 w-28" />} />
      <Panel n={2} title={perWho(dims)} desc={bones} actions={<Bone className="h-8 w-28" />} />
      <Panel n={3} title="Rules for everyone" desc={bones} footer={<Bone className="h-8 w-24" />}>
        {/* the default's row: who gets it, then its value and the in-app default switch under it */}
        <div className="flex h-[81px] items-start gap-4 py-4"><Bone className="mt-3 w-40" /><span className="flex-1" /><Bone className="h-[34px] w-[260px] max-sm:w-32" /></div>
      </Panel>
    </div>
  );
}

/** A release's Rollout tab before the flag is in: the flag's facts, then the rollout card with its stages (always the same). */
export function RolloutSkeleton() {
  const stops = [...LADDER.map((p) => `${p}%`), 'Everyone'];
  return (
    <div aria-busy className="px-6 pb-10 max-sm:px-4">
      {/* the flag's facts: a line, two on a phone (FlagFacts) */}
      <p aria-hidden className="m-0 mt-4 grid h-6 content-center gap-3.5 max-sm:h-12"><Bone className="w-80 max-w-full" /><Bone className="hidden w-40 max-sm:inline-block" /></p>
      <section aria-hidden className="mt-5 max-w-[860px] border border-grid bg-panel">
        {/* where it is, then its next step's button: beside it, or under it in a narrow window (RolloutCard) */}
        <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4 px-5 pt-4">
          <div className="min-w-0 flex-1 basis-[320px]">
            <span className="flex h-[19.5px] items-center"><Bone className="w-36" /></span>
            <span className="mt-1.5 flex h-[32.5px] items-center"><Bone className="h-6 w-48" /></span>
            <span className="mt-1.5 flex h-[19.5px] items-center"><Bone className="w-72 max-w-full" /></span>
          </div>
          <Bone className="h-8 w-32" />
        </div>
        <div className="px-5 pt-5 pb-4">
          <ol className="m-0 grid list-none p-0" style={{ gridTemplateColumns: `repeat(${stops.length}, minmax(0, 1fr))` }}>
            {stops.map((s, i) => (
              <li key={s} className="relative grid min-w-0 gap-1.5 pr-1 text-13">
                <span className="relative flex h-3 items-center">
                  {i < stops.length - 1 && <span className="absolute top-1/2 left-1.5 h-0.5 w-full -translate-y-1/2 bg-rule" />}
                  <span className="relative size-3 border-2 border-rule-2 bg-panel" />
                </span>
                <span className="truncate text-ink-3">{s}</span>
                <span className="h-4" />
              </li>
            ))}
          </ol>
        </div>
        <div className="flex items-center border-t border-grid px-5 py-2.5"><span className="flex h-[19.5px] items-center"><Bone className="w-32" /></span></div>
      </section>
    </div>
  );
}

/** A flag's History tab while its code loads: the environment filter, the table head and rows (History.tsx FlagHistory). */
export function FlagHistorySkeleton() {
  return (
    <div aria-busy className="flex flex-col">
      <div className="flex h-[52px] items-center px-6 max-sm:px-4"><Bone className="h-8 w-44" /></div>
      <div className={cn('flex', tableHeadClass)}><Bone className="w-24" /></div>
      <SkeletonRows cols="grid grid-cols-[28px_120px_minmax(0,1fr)_minmax(0,1fr)] max-md:grid-cols-[28px_minmax(0,1fr)_80px]" cells={['', '', '', 'max-md:hidden']} rows={8} />
    </div>
  );
}

/** Lines of text still loading (a trace, a drawer's details). */
export function LinesSkeleton({ lines = 4, className }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={cn('grid', className)}>
      {Array.from({ length: lines }, (_, i) => <span key={i} className="flex h-9 items-center gap-3"><Bone className="size-3" /><Bone className={i % 2 ? 'w-1/3' : 'w-1/2'} /></span>)}
    </div>
  );
}

/** The sentence under an entity's name (its own settings, when it was added) until its row arrives: one line, two on
 *  a phone, where it wraps. */
export function EntitySentenceSkeleton() {
  return (
    <p aria-hidden className="m-0 mt-1 grid h-6 content-center gap-3.5 max-sm:h-12">
      <Bone className="w-96 max-w-full" /><Bone className="hidden w-48 max-sm:inline-block" />
    </p>
  );
}

/** An entity's header before the console knows the entity (the first load straight into its page). `back`: its
 *  dimension's list, with that dimension's plural ("Stores") once the console knows it. */
export function EntityHeaderSkeleton({ back }: { back?: { href: string; label: string } }) {
  return (
    <header className="px-6 pt-4 pb-5 max-sm:px-4">
      {back ? (
        <a href={back.href} className="-ml-1 inline-flex items-center gap-1 text-13 text-ink-3 no-underline hover:text-ink hover:no-underline">
          <CaretLeftIcon aria-hidden className="size-3.5" />{back.label}
        </a>
      ) : <div className="flex h-5 items-center"><Bone className="h-3.5 w-20" /></div>}
      <div className="mt-1.5 flex h-8 items-center"><Bone className="h-5 w-48" /></div>
      <EntitySentenceSkeleton />
    </header>
  );
}

const TITLES: Record<string, string> = {
  flags: 'Flags', releases: 'Releases', approvals: 'Approvals', compare: 'Compare',
  history: 'History', keys: 'API keys', settings: 'Settings',
};
/** the pages whose bar has a button (+ New flag, + Add …, Export…) */
const WITH_ACTIONS = new Set(['flags', 'releases', 'dimensions', 'keys', 'history']);
/** the pages whose filters sit in a row of their own under the bar, not in it */
const NO_BAR_FILTERS = new Set(['settings', 'history']);

/**
 * What the main pane shows while a page's code is on its way (the first load, or a page opened for the first time
 * on a slow connection): the top of that page as it will be, so the page grows below it instead of replacing a
 * placeholder. `env`: the environment chip of a flag's or a release's bar, once the console knows its name.
 */
export function RouteSkeleton({ route, env }: { route: string[]; env?: ReactNode }) {
  const [page, a, b] = route;
  // a dimension's words, once the console has them (the first load may come before)
  const dims = use(AppContext)?.meta.dimensions ?? [];
  const dim = page === 'dimensions' ? dimensionOf(dims, a) : undefined;
  if (page === 'flag' || page === 'release') {
    const flag = page === 'flag';
    return (
      <div aria-busy className="flex min-h-full flex-1 flex-col">
        <DetailBarSkeleton back={flag ? '#/flags' : '#/releases'} backLabel={flag ? 'Back to flags' : 'Back to releases'} env={env} copy={flag} />
        <TabsSkeleton widths={flag ? FLAG_TABS : RELEASE_TABS} />
        {flag ? <FlagRulesSkeleton /> : <RolloutSkeleton />}
      </div>
    );
  }
  // an entity's page (#/dimensions/<dimension>/<key>/…), or the old address of one
  if ((page === 'dimensions' && b) || page === 'customer') {
    const back = dim ? { href: `#/dimensions/${dim.key}`, label: titleOf(dim) } : undefined;
    return <div aria-busy className="flex min-h-full flex-1 flex-col"><EntityHeaderSkeleton back={back} /></div>;
  }
  if (page === 'approvals' && a) {
    return (
      <div aria-busy className="flex min-h-full flex-1 flex-col">
        <PageBar crumbs={<a href="#/approvals" className="text-ink-3 no-underline hover:text-ink hover:no-underline">Approvals</a>} title={<span className="font-mono">#{a}</span>} />
      </div>
    );
  }
  if (page === 'settings' && a === 'people') {
    return (
      <div aria-busy className="flex min-h-full flex-1 flex-col">
        <PageBar crumbs={<a href="#/settings" className="text-ink-3 no-underline hover:text-ink hover:no-underline">Settings</a>} title="People"
          count={<CountSlot />} actions={<Bone className="h-8 w-28" />} />
      </div>
    );
  }
  const title = page === 'dimensions' ? (dim ? titleOf(dim) : undefined) : TITLES[page];
  if (!title) return null;
  // the bar as the page draws it: its count, its filters and its button take their room (on a phone they wrap)
  return (
    <div aria-busy className="flex min-h-full flex-1 flex-col">
      <PageBar title={title} count={page === 'settings' ? undefined : <CountSlot />} actions={WITH_ACTIONS.has(page) ? <Bone className="h-8 w-28" /> : undefined}>
        {NO_BAR_FILTERS.has(page) ? undefined : <Bone className="h-8 w-40" />}
      </PageBar>
    </div>
  );
}

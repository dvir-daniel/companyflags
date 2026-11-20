import { use, useState, type ReactNode } from 'react';
import { InfoIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Drawer, DrawerSection } from '@companyflags/ui/components/drawer';
import { cn } from '@companyflags/ui/lib/utils';
import { capital, CHOICE_NAME, CHOICES, choiceText, type Dimensions } from './api.ts';
import { AppContext } from './app.ts';
import { listWords, perWho } from './dimWords.ts';
import { monoLabel } from './uiKit.ts';

/*
 * "How it works": how a flag decides what an app gets, layer by layer, in the console's own words (Overrides,
 * the own settings of each level, Rules for everyone, Default) and the order server/evaluator.ts follows, with this
 * installation's dimensions ("company › brand"). Opens beside the page.
 */

type Step = { title: string; tag?: string; body: ReactNode; example?: string };
function steps(dims: Dimensions): Step[] {
  const lower = dims.slice(1);
  return [
    { title: 'On or off', body: <>When a flag is off, nobody gets a value: every app uses the default written in its own code, the <b className="font-medium text-ink">in-app default</b>.</> },
    { title: 'Overrides', body: 'Rules for everyone that no one’s own settings can change. If a detail they check is missing, they still match, so they fail safe.', example: 'Android below 5.0 → off' },
    ...(dims.length ? [{ title: 'Its own settings', tag: perWho(dims), body: `Rules and a default set for one ${listWords(dims)}. They come before the rules for everyone, in one of three ways (below).`, example: 'Acme → on' }] : []),
    ...(lower.length ? [{ title: 'The settings above it', tag: capital(listWords(lower, 'and', true)),
      body: `${capital(listWords(lower, 'and', true))} follow the one above them where they have no settings of their own, and so on up to the top: ${dims.map((d) => d.singular).join(' › ')}.`,
      example: 'Acme 12 has nothing set → Acme’s rule decides' }] : []),
    { title: 'Rules for everyone', body: 'Rules everyone shares: a % of devices, a country, an app version…', example: '20% of devices → on' },
    { title: 'Default', body: dims.length ? 'When nothing above matched: the most specific default there is. Its own, then those above it, then everyone’s.' : 'When nothing above matched: everyone’s default.' },
  ];
}

/**
 * The "How it works" button, and the panel it opens. `compact` is the old way to ask for HowItWorksLink (kept for the
 * pages that still pass it).
 */
export function HowItWorks({ compact }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (compact) return <HowItWorksLink />;
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)} aria-haspopup="dialog"><InfoIcon aria-hidden className="size-3.5" />How it works</Button>
      <HowItWorksPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The same as a small text link, for a sentence on the page. */
export function HowItWorksLink() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog"
        className="inline-flex shrink-0 cursor-default items-center gap-1 border-0 bg-transparent p-0 text-13 text-ink-2 underline-offset-2 hover:text-ink hover:underline">
        <InfoIcon aria-hidden className="size-3.5" />How it works
      </button>
      <HowItWorksPanel open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function HowItWorksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const meta = use(AppContext)?.meta;
  const dims = meta?.dimensions ?? [];
  const STEPS = steps(dims);
  // how this server's apps read flags (server/plugin.ts); a server that doesn't say serves both
  const plugins = meta?.plugins;
  const ofrep = plugins?.includes('ofrep') ?? true;
  const files = plugins?.includes('app-files') ?? true;
  const cdn = plugins?.includes('cloudflare') ?? false;
  return (
    <Drawer open={open} onClose={onClose} title="How a flag decides" subtitle="What an app gets, layer by layer"
        footer={<Button variant="secondary" onClick={onClose}>Got it</Button>}>
        <p className="m-0 mb-5 text-sm text-ink-2">
          Each time an app asks for a flag, these layers are checked <b className="font-medium text-ink">from the top</b>.
          The first one that applies decides the value, and nothing below it is looked at.
        </p>

        <ol className="m-0 mb-6 grid list-none gap-0 p-0" aria-label="The layers, in order">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3">
              {/* the number, with a line down to the next layer */}
              <span className="flex flex-col items-center">
                <span className="grid size-7 shrink-0 place-items-center border border-rule bg-panel font-mono text-xs text-ink">{i + 1}</span>
                {i < STEPS.length - 1 && <span aria-hidden className="w-px flex-1 bg-rule" />}
              </span>
              <span className={cn('grid min-w-0 gap-1 pt-1', i < STEPS.length - 1 && 'pb-5')}>
                <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <b className="text-sm font-medium text-ink">{s.title}</b>
                  {s.tag && <span className={monoLabel}>{s.tag}</span>}
                </span>
                <span className="text-13 leading-5 text-ink-2">{s.body}</span>
                {s.example && <span className="font-mono text-xs text-ink-3">e.g. {s.example}</span>}
              </span>
            </li>
          ))}
        </ol>

        <DrawerSection title="Three ways own settings combine">
          <p className="m-0 mb-2 text-13 text-ink-2">How its own settings combine with the rest.{dims.length > 1 ? ' Below the top, the rest starts with the settings above it.' : ''}</p>
          {CHOICES.map((c) => (
            <div key={c} className="grid gap-0.5 border-b border-grid py-2.5 text-13 last:border-b-0">
              <b className="font-medium text-ink">{CHOICE_NAME[c]}</b>
              <span className="text-ink-2">{choiceText(c)}</span>
            </div>
          ))}
        </DrawerSection>

        <DrawerSection title="Where it’s worked out">
          <ul className="m-0 grid list-disc gap-1.5 pl-5 text-13 text-ink-2">
            {ofrep && <li>Apps ask with OpenFeature’s OFREP provider and send what the device knows (app version, platform, device ID). The server answers with values only, never the rules.</li>}
            {files && <li>With app files, the file carries the values and the checks only the device knows (app version, platform, a % of devices), and the app picks its line{cdn ? '. Your CDN serves the file' : ''}.</li>}
            <li>Nothing about anyone else reaches a device. Backend servers download the rules and decide in-process, the same way.</li>
          </ul>
        </DrawerSection>

        <DrawerSection title="See it for real">
          <ul className="m-0 grid list-disc gap-1.5 pl-5 text-13 text-ink-2">
            {dims.length > 0 && <li>Each {listWords(dims)} has a page that shows what it gets for every flag, and which layer decided (open a flag there for the full chain).</li>}
            <li>On a flag, <b className="font-medium text-ink">Check who gets what</b> marks the row that decides, and the <b className="font-medium text-ink">Debug</b> tab traces one request step by step.</li>
          </ul>
        </DrawerSection>
      </Drawer>
  );
}

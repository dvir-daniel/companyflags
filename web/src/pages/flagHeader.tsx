// Pieces shared by the flag page and other detail pages: the flag's facts as a sentence, and an
// environment as a place (used by a customer's page).
import type { ReactNode } from 'react';
import { CaretRightIcon } from '@phosphor-icons/react';
import { HelpTip } from '@companyflags/ui/components/tooltip';
import { cn } from '@companyflags/ui/lib/utils';
import { KIND_INFO, type FlagDetail } from '../api.ts';
import { fmtDate } from '../uiKit.ts';

/** What the flag is, as the start of a sentence. */
const NOUN: Record<string, string> = {
  release: 'A release flag', kill_switch: 'A kill switch', ops: 'An ops flag',
  experiment: 'An experiment', config: 'A config flag', permission: 'A permission flag',
};
/** What it sends, in words. */
const SENDS: Record<string, string> = { bool: 'true or false', string: 'text', number: 'a number', json: 'JSON' };
/** "Release — roll out a new feature…" → "Roll out a new feature…." */
const purpose = (kind: string) => {
  const s = (KIND_INFO[kind] ?? '').split(' — ')[1];
  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}.` : null;
};

/** The same facts as flowing text, with a "?" on the term it explains. */
export function FlagFacts({ flag, className }: { flag: FlagDetail; className?: string }) {
  const why = purpose(flag.kind);
  return (
    <p className={cn('m-0 max-w-[72ch] text-13 leading-6 text-ink-3', className)}>
      {NOUN[flag.kind] ?? 'A flag'}{why && <> <HelpTip>{why}</HelpTip></>} that sends {SENDS[flag.valueType] ?? flag.valueType}.{' '}
      {flag.owner ? <>Owned by <span className="text-ink-2">{flag.owner}</span>.</> : 'No owner yet.'}
      {flag.removeBy && <> Remove by <span className="text-ink-2">{fmtDate(flag.removeBy)}</span>.</>}
    </p>
  );
}

/**
 * An environment as a place on a detail page: the open one is outlined and may hold an action; the
 * others are links to the same page in that environment.
 */
export function EnvTile({ name, current, href, badge, children, action }: {
  name: string; current: boolean; href: string; badge?: ReactNode; children: ReactNode; action?: ReactNode;
}) {
  const text = (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-2"><span className="text-sm font-medium text-ink">{name}</span>{badge}</span>
      <span className="flex min-w-0 items-center gap-2 text-13">{children}</span>
    </span>
  );
  const box = 'flex w-[340px] min-w-0 items-center gap-4 border px-4 py-3 max-sm:w-full';
  if (current) return <section aria-current="true" aria-label={name} className={cn(box, 'border-ink bg-panel')}>{text}{action}</section>;
  return (
    // no aria-label: the link is named by what it shows (the name, its badge and its state), as people see it
    <a href={href}
      className={cn(box, 'border-rule-2 no-underline transition-colors duration-150 hover:border-ink-3 hover:bg-wash hover:no-underline')}>
      {text}
      <CaretRightIcon aria-hidden className="size-3.5 shrink-0 text-ink-4" />
    </a>
  );
}

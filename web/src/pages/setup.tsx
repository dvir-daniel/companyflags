import { CheckIcon } from '@phosphor-icons/react';
import { Button, buttonVariants } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { cn } from '@companyflags/ui/lib/utils';
import { useApp } from '../app.ts';
import { roleInfo } from '../../../server/policy.ts';
import { roleName } from './settingsKit.ts';
import { lookName } from '../appearanceKit.ts';
import { nextStep, setupSteps } from './setupKit.ts';

/*
 * The first-run checklist, built from /meta (setupKit.ts): each step shows a done mark or the way to do it. It is the
 * whole page until there is an environment (GetStarted), then it sits above the Flags list until apps can read flags
 * (a service and an entry exist).
 */

/** The steps, each with a done mark or its link. On the Flags list (`flags` known, `onNewFlag`) the flag step opens New flag.
 *  `lead`: the next step's link is the page's primary button (when the steps are the whole page; elsewhere the page
 *  has its own primary). */
export function SetupChecklist({ flags, onNewFlag, lead }: { flags?: number; onNewFlag?: () => void; lead?: boolean }) {
  const { meta } = useApp();
  const steps = setupSteps(meta, flags);
  const next = nextStep(steps);
  // every page needs an environment: until there is one, only that step has a way to go
  const blocked = !steps[0].done;
  return (
    <ol className="m-0 grid max-w-[760px] list-none gap-0 p-0" aria-label="Steps to set up">
      {steps.map((s, i) => {
        const current = s === next;
        const variant = lead && current ? 'default' : 'secondary';
        const canGo = !s.done && s.href && (!blocked || i === 0);
        return (
          <li key={s.key} aria-current={current ? 'step' : undefined}
            className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 border-t border-rule py-3 last:border-b max-sm:grid-cols-[28px_minmax(0,1fr)]">
            <span className={cn('font-mono text-13 leading-5', s.done ? 'text-ok' : 'text-ink-3')}>
              {s.done ? <CheckIcon aria-hidden className="mt-0.5 size-4" /> : String(i + 1).padStart(2, '0')}
            </span>
            <span className="grid gap-0.5">
              <span className={cn('text-13 font-medium', s.done ? 'text-ink-2' : 'text-ink')}>
                {s.title}{s.done && <span className="sr-only">: done</span>}
              </span>
              <span className="text-13 text-ink-2">{s.text}</span>
            </span>
            <span className="max-sm:col-start-2">
              {s.done ? <span aria-hidden className="font-mono text-11 tracking-[0.55px] text-ok uppercase">Done</span>
                : !canGo ? null
                : s.key === 'flag' && onNewFlag ? <Button variant={variant} onClick={onNewFlag}>{s.action}</Button>
                : <a href={s.href} data-slot="button" className={cn(buttonVariants({ variant }), 'no-underline hover:no-underline')}>{s.action}</a>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The whole page until there is an environment to work in: the steps to set up. */
export function GetStarted() {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  return (
    <div className="grid max-w-[760px] content-start gap-8 p-12 max-sm:p-6">
      <div className="grid gap-3">
        <h1 className="m-0 text-28 font-semibold text-ink">Welcome to {lookName()}</h1>
        <p className="m-0 text-15 text-subtitle">Five steps, and your apps read their first flag.</p>
      </div>
      {admin ? (
        <section className="grid gap-3">
          <SetupChecklist lead />
          <p className="m-0 text-13 text-ink-3">Moving from another system? Once these are done, the Migration page imports its flags, and both run side by side while you move them one at a time.</p>
        </section>
      ) : (
        <Callout>An admin needs to add the environments and services first. You’re signed in as {meta.me.key}, a {roleName(meta.me.role).toLowerCase()}.</Callout>
      )}
    </div>
  );
}

/** Above the Flags list until apps can read flags: what's left to set up. Admins get the steps, others one sentence. */
export function FinishSetup({ flags, onNewFlag }: { flags?: number; onNewFlag?: () => void }) {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  return (
    <section aria-labelledby="finish-setup" className="grid gap-3 border-b border-grid px-6 py-5 max-sm:px-4">
      <div className="grid gap-1">
        <h2 id="finish-setup" className="m-0 text-sm font-semibold text-ink">Finish setting up</h2>
        <p className="m-0 text-13 text-ink-2">{admin
          ? 'Apps can read flags once they have a service and an entry with an app link.'
          : 'Apps can’t read flags yet: an admin still needs to add a service and a first entry in Settings.'}</p>
      </div>
      {admin && <SetupChecklist flags={flags} onNewFlag={onNewFlag} />}
    </section>
  );
}

/** In a new flag's Services group while there are none: a flag in no service reaches no app, so say where to add one. */
export function NoServices({ what = 'this flag' }: { what?: string }) {
  return (
    <p className="m-0 py-1 text-13 text-ink-2">
      No services yet: apps can’t read {what} until it’s in one. <a href="#/settings">Add one in Settings</a>.
    </p>
  );
}

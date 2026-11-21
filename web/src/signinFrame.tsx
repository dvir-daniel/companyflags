import { useState, type ReactNode } from 'react';
import { BuildingsIcon, EyeIcon, EyeSlashIcon, GithubLogoIcon, GoogleLogoIcon, WindowsLogoIcon } from '@phosphor-icons/react';
import { Button } from '@companyflags/ui/components/button';
import { Input } from '@companyflags/ui/components/input';
import { cn } from '@companyflags/ui/lib/utils';
import { Bone } from './loading.tsx';
import { Brand } from './look.tsx';
import { lookName, useLook } from './appearanceKit.ts';
import { field, INVITE_ONLY, SETUP_HINT, type Provider } from './signinKit.ts';

/*
 * The sign-in pages' frame and their shapes while they load, without the sign-in library's client: the console shows them
 * from its first download, while signin.tsx (and the client it needs) is still on its way, so the page that follows
 * draws over the same card, fields and button instead of replacing a line of text.
 *
 * The look: the console's mark above a faint grid and one card, with "Sign in" and "Sign up" as folder tabs on its top
 * edge. The tabs switch the whole page, so they're buttons that say which page is current, not a tab widget. Pages
 * that are neither (a password reset, an invite that no longer works) have no tabs.
 */

export type Tab = 'signin' | 'signup';
const TABS: [Tab, string][] = [['signin', 'Sign in'], ['signup', 'Sign up']];

/** The sign-in pages' frame: the tabs (when `tab` is given), then a card with a title, a sentence, the form and a closing line. */
export function Frame({ tab, onTab, title, intro, footer, children }: {
  tab?: Tab; onTab?: (t: Tab) => void; title: ReactNode; intro?: ReactNode; footer?: ReactNode; children: ReactNode;
}) {
  return (
    <main className="relative grid min-h-dvh place-items-start justify-center overflow-hidden bg-background px-4 pt-[10vh] pb-12 text-ink">
      {/* a faint grid, fading out toward the edges */}
      <div aria-hidden className="pointer-events-none absolute inset-0 opacity-60 [mask-image:radial-gradient(ellipse_at_50%_35%,black_10%,transparent_70%)]"
        style={{ backgroundImage: 'linear-gradient(var(--rule) 1px, transparent 1px), linear-gradient(90deg, var(--rule) 1px, transparent 1px)', backgroundSize: '48px 48px' }} />
      <div className="relative w-full max-w-md">
        <Brand className="mb-4 text-ink" />
        {tab && (
          <div role="group" aria-label="Sign in or sign up" className="flex">
            {TABS.map(([t, label]) => (
              <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => onTab?.(t)} disabled={!onTab && tab !== t}
                className={cn('relative -mb-px h-10 cursor-pointer border border-b-0 px-5 text-sm font-medium disabled:cursor-default',
                  tab === t ? 'z-10 border-rule-2 bg-background text-ink' : 'border-transparent bg-transparent text-ink-3 hover:text-ink-2')}>
                {label}
              </button>
            ))}
          </div>
        )}
        <section className="grid gap-5 border border-rule-2 bg-background p-6 shadow-[0_24px_64px_var(--shadow-strong)] max-sm:p-5">
          <div className="grid gap-1.5">
            <h1 className="m-0 text-22 font-semibold">{title}</h1>
            {intro && <p className="m-0 text-13 text-ink-2">{intro}</p>}
          </div>
          {children}
          {footer && <p className="m-0 border-t border-rule pt-4 text-center text-13 text-ink-3">{footer}</p>}
        </section>
        <LookNote />
      </div>
    </main>
  );
}

/** Under the card: the installation's note (who may sign in, that use is logged) and its help link. */
function LookNote() {
  const { signInNote, helpUrl } = useLook();
  if (!signInNote && !helpUrl) return null;
  return (
    <div className="mt-4 grid gap-2 text-center text-13 text-ink-3">
      {signInNote && <p className="m-0 whitespace-pre-line">{signInNote}</p>}
      {helpUrl && <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="text-ink-2 underline decoration-ink-4 underline-offset-4 hover:text-ink">Get help</a>}
    </div>
  );
}

/** A field's label and its input: the label in plain words, with an optional link at its right ("Forgot your password?"). */
export function Labeled({ id, label, aside, hint, children }: { id: string; label: string; aside?: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="text-sm font-medium text-ink">{label}</label>
        {aside}
      </div>
      {children}
      {hint && <span className="text-13 text-ink-3">{hint}</span>}
    </div>
  );
}

/** A password field with a button that shows or hides what's typed. */
export function PasswordInput({ id, value, onChange, autoComplete, minLength, required, disabled }: {
  id: string; value?: string; onChange?: (v: string) => void; autoComplete?: string; minLength?: number; required?: boolean; disabled?: boolean;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input id={id} className={cn(field, 'pr-11')} type={shown ? 'text' : 'password'} value={value} onChange={(e) => onChange?.(e.target.value)}
        autoComplete={autoComplete} minLength={minLength} required={required} disabled={disabled} placeholder="password" />
      <button type="button" disabled={disabled} onClick={() => setShown(!shown)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}
        className="absolute inset-y-0 right-0 grid w-10 cursor-pointer place-items-center border-0 bg-transparent text-ink-3 hover:text-ink disabled:cursor-default">
        {shown ? <EyeSlashIcon size={18} /> : <EyeIcon size={18} />}
      </button>
    </div>
  );
}

const PROVIDER_ICON: Record<Provider, ReactNode> = {
  google: <GoogleLogoIcon size={18} weight="bold" />, github: <GithubLogoIcon size={18} weight="fill" />, microsoft: <WindowsLogoIcon size={18} weight="fill" />,
};
const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft' };

/** A button for signing in another way: a provider (with its logo) or single sign-on. */
export function WayButton({ way, label, busy, disabled, onClick }: { way: Provider | 'sso'; label: string; busy?: boolean; disabled?: boolean; onClick?: () => void }) {
  return (
    <Button type="button" variant="outline" disabled={disabled} onClick={onClick}
      className="h-10 w-full gap-2.5 text-sm font-medium normal-case tracking-normal">
      {way === 'sso' ? <BuildingsIcon size={18} /> : PROVIDER_ICON[way]}
      {busy ? 'Opening…' : `${label} ${way === 'sso' ? 'SSO' : PROVIDER_NAME[way]}`}
    </Button>
  );
}

/** The sign-in card's closing lines: how to join, and how a new server's admin account is made (its setup link). */
export function SignInFooter() {
  return <><span className="block">{INVITE_ONLY}</span><span className="mt-1 block">{SETUP_HINT}</span></>;
}

/** The sign-in page before its code is in: the usual form, not yet usable. */
export function SignInSkeleton() {
  return (
    <Frame tab="signin" title="Sign in" intro="Enter your email below to sign in to your account" footer={<SignInFooter />}>
      <form aria-busy className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
        <Labeled id="sk-email" label="Email"><Input id="sk-email" className={field} type="email" disabled placeholder="you@example.com" /></Labeled>
        <Labeled id="sk-password" label="Password"><PasswordInput id="sk-password" disabled /></Labeled>
        <Button type="submit" className="mt-1 h-10 w-full" disabled>Sign in</Button>
      </form>
    </Frame>
  );
}

/** A password reset link's page before its code is in (signin.tsx ResetPage), the same card. */
export function ResetSkeleton() {
  return (
    <Frame title="Choose a new password" intro="An admin made you this link. It works once, for a day." footer="Back to sign in">
      <form aria-busy className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
        <Labeled id="sk-reset" label="New password" hint="At least 10 characters."><PasswordInput id="sk-reset" disabled /></Labeled>
        <Button type="submit" className="mt-1 h-10 w-full" disabled>Set new password</Button>
      </form>
    </Frame>
  );
}

/** An invite link's page before the invite is in: who it's for is a bone, the fields wait. */
export function JoinSkeleton() {
  return (
    <Frame tab="signup" title={`Join ${lookName()}`} intro={<>You’re invited as <Bone className="w-40" />.</>}>
      <form aria-busy className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
        <Labeled id="sk-name" label="Your name"><Input id="sk-name" className={field} disabled placeholder="Sam Lee" /></Labeled>
        <Labeled id="sk-new" label="Choose a password" hint="At least 10 characters."><PasswordInput id="sk-new" disabled /></Labeled>
        <Button type="submit" className="mt-1 h-10 w-full" disabled>Create account</Button>
      </form>
    </Frame>
  );
}

import { useEffect, useState, type FormEvent } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { Input } from '@companyflags/ui/components/input';
import { authClient } from './authClient.ts';
import { Frame, JoinSkeleton, Labeled, PasswordInput, SignInSkeleton, WayButton, type Tab } from './signinFrame.tsx';
import { field, lastSignInInfo, rememberSignedIn, signInInfo, type Provider, type SignInInfo } from './signinKit.ts';

/*
 * Signing in, with Better Auth (server/betterAuth.ts): an email and password, single sign-on with the organization's
 * identity provider (SAML or OIDC, set up by an admin in Settings), or Google, GitHub or Microsoft when the server
 * has them set up. The very first person creates the admin account (Sign up); everyone after joins with single
 * sign-on, a provider at an allowed domain, or an invite link from an admin (#/join/<invite>).
 */

// what a refused sign-in comes back with (a provider sign-in returns to /?error=<code>)
const REFUSED: Record<string, string> = {
  invite_required: 'You need an invite to join. Ask an admin of CompanyFlags for an invite link.',
  access_removed: 'An admin removed your access to CompanyFlags.',
  INVALID_EMAIL_OR_PASSWORD: 'That email and password don’t match.',
  USER_ALREADY_EXISTS: 'There is already an account for this email. Sign in instead.',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'There is already an account for this email. Sign in instead.',
  PASSWORD_TOO_SHORT: 'Use at least 10 characters for your password.',
  sso_required: 'Your organization signs in with single sign-on: use “Sign in with SSO”.',
  SSO_REQUIRED: 'Your organization signs in with single sign-on: use “Sign in with SSO”.',
  'account not linked': 'There is already an account for this email, and your identity provider can’t sign in to it. Ask an admin.',
  NO_PROVIDER_FOUND: 'Your email’s domain has no single sign-on. Sign in with your password, or ask an admin.',
};
const ssoProblem = (m?: string) => (m && /provider not found|no provider|not found/i.test(m) ? REFUSED.NO_PROVIDER_FOUND : undefined);
const sentence = (m: string) => (m ? `${m.charAt(0).toUpperCase()}${m.slice(1)}${/[.!?]$/.test(m) ? '' : '.'}` : '');
const explain = (e: { code?: string; message?: string } | null | undefined) =>
  (e?.code && REFUSED[e.code]) || sentence(e?.message ?? '') || 'Something went wrong. Try again.';
/** A sign-in call that never got an answer (offline, the server down): said so, instead of spinning forever. */
const UNREACHABLE = 'Can’t reach the CompanyFlags server. Check your connection, then try again.';
const INVITE_ONLY = 'New here? Ask an admin for an invite link.';

/** Where a sign-in goes back to: the page that was open (not an invite link). */
const back = () => `/${location.hash.startsWith('#/join') ? '' : location.hash}`;

/** Off to the organization's identity provider for this email's domain; it sends the person back signed in. */
async function startSso(email: string, onError: (m: string) => void) {
  try {
    const { error } = await authClient.signIn.sso({ email, callbackURL: back(), errorCallbackURL: '/' });
    if (error) onError(ssoProblem(error.message) ?? explain(error));
  } catch {
    onError(UNREACHABLE);
  }
}

/** An error a provider sign-in came back with, once: it is taken out of the address. */
function takeReturnedError(): string | null {
  const q = new URLSearchParams(location.search);
  const code = q.get('error');
  if (!code) return null;
  history.replaceState(null, '', `${location.pathname}${location.hash}`);
  return REFUSED[code] ?? sentence(q.get('error_description') ?? code.replaceAll('_', ' '));
}

// the next load draws the console's frame straight away (signinKit.ts lastSignedIn)
const signedIn = () => { rememberSignedIn(true); location.hash = location.hash.startsWith('#/join') ? '#/flags' : location.hash; location.reload(); };

// the page opens with the ways to sign in this browser saw last time (signinKit.ts), while a fresh answer loads
function useSignInInfo() {
  const [info, setInfo] = useState<SignInInfo | null>(lastSignInInfo);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    signInInfo().then(setInfo, (e) => setError(`Can’t reach the CompanyFlags server. Check that it’s running, then reload. (${e.message})`));
  }, []);
  return { info, error };
}

/** Google, GitHub, Microsoft: one button each, with its logo. */
function Providers({ providers, label, onError }: { providers: Provider[]; label: string; onError: (m: string) => void }) {
  const [busy, setBusy] = useState<Provider | null>(null);
  if (!providers.length) return null;
  const go = async (provider: Provider) => {
    setBusy(provider);
    // back to the console either way; a refusal comes back as ?error=…. Only a success leaves the button busy: the
    // provider's page opens next
    let leaving = false;
    try {
      const { error } = await authClient.signIn.social({ provider, callbackURL: back(), errorCallbackURL: '/' });
      if (error) onError(explain(error)); else leaving = true;
    } catch {
      onError(UNREACHABLE);
    } finally {
      if (!leaving) setBusy(null);
    }
  };
  return (
    <div className="grid gap-2.5">
      {providers.map((p) => <WayButton key={p} way={p} label={label} busy={busy === p} disabled={!!busy} onClick={() => void go(p)} />)}
    </div>
  );
}

/** Shown when nobody is signed in: Sign in, or Sign up (the first person creates the admin account there). */
export function SignInPage() {
  const { info, error: unreachable } = useSignInInfo();
  const [tab, setTab] = useState<Tab | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [forgot, setForgot] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(takeReturnedError);

  if (unreachable) return <Frame tab="signin" title="Can’t sign in right now"><Callout tone="error">{unreachable}</Callout></Frame>;
  if (!info) return <SignInSkeleton />;
  if (info.kind !== 'better-auth') {
    return <Frame tab="signin" title="You’re not signed in"><Callout>This server signs people in another way ({info.kind}). Reload to try again.</Callout></Frame>;
  }
  const first = info.firstPerson;
  const shown: Tab = tab ?? (first ? 'signup' : 'signin');
  const switchTo = (t: Tab) => { setTab(t); setError(null); setForgot(false); };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    let done = false;   // signed in: the page reloads, so the button stays busy
    try {
      const { error: err } = shown === 'signup'
        ? await authClient.signUp.email({ email: email.trim(), name: name.trim() || email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password, rememberMe: remember });
      if (err) { setError(explain(err)); return; }
      done = true;
      signedIn();
    } catch {
      setError(UNREACHABLE);
    } finally {
      if (!done) setBusy(false);
    }
  };
  const sso = () => {
    if (!email.includes('@')) { setError('Type your work email above, then choose “Sign in with SSO”.'); return; }
    setBusy(true); setError(null);
    void startSso(email.trim(), (m) => { setBusy(false); setError(m); });
  };

  if (shown === 'signup' && !first) {
    // after the first account, a password account needs an invite: Sign up says how to get one
    return (
      <Frame tab="signup" onTab={switchTo} title="Sign up" intro="Accounts here are by invite."
        footer={<>Have an account? <button type="button" className="cursor-pointer border-0 bg-transparent p-0 text-ink underline" onClick={() => switchTo('signin')}>Sign in</button></>}>
        <p className="m-0 text-sm text-ink-2">
          Ask an admin of CompanyFlags to add you in Settings → People. They send you an invite link, where you choose your password.
        </p>
        {(info.providers.length > 0 || info.sso) && <>
          <p className="m-0 text-sm text-ink-2">
            {info.sso ? 'If your organization uses single sign-on, sign in with it and you join as a viewer. ' : ''}
            {info.providers.length > 0 ? 'People at your organization’s domains can also join with:' : ''}
          </p>
          <Providers providers={info.providers} label="Sign up with" onError={setError} />
        </>}
        {error && <Callout tone="error" role="alert">{error}</Callout>}
      </Frame>
    );
  }

  const signup = shown === 'signup';
  return (
    <Frame tab={shown} onTab={switchTo}
      title={signup ? 'Create the admin account' : 'Sign in'}
      intro={signup ? 'Nobody has an account here yet: the first one is the admin’s. The admin sets up environments and flag sets, and invites everyone else.'
        : 'Enter your email below to sign in to your account'}
      footer={signup ? 'If this server was used before, use your admin email.' : INVITE_ONLY}>
      <form className="grid gap-4" onSubmit={submit}>
        {signup && (
          <Labeled id="si-name" label="Your name">
            <Input id="si-name" className={field} value={name} autoComplete="name" onChange={(e) => setName(e.target.value)} placeholder="Lee Park" />
          </Labeled>
        )}
        <Labeled id="si-email" label="Email">
          <Input id="si-email" className={field} type="email" value={email} autoComplete="email" autoFocus required
            onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
        </Labeled>
        <Labeled id="si-password" label="Password" hint={signup ? 'At least 10 characters.' : undefined}
          aside={!signup && <button type="button" onClick={() => setForgot(!forgot)} aria-expanded={forgot}
            className="cursor-pointer border-0 bg-transparent p-0 text-13 text-ink underline-offset-2 hover:underline">Forgot your password?</button>}>
          <PasswordInput id="si-password" value={password} onChange={setPassword} autoComplete={signup ? 'new-password' : 'current-password'}
            minLength={signup ? 10 : undefined} required={signup} />
        </Labeled>
        {forgot && !signup && (
          <Callout role="status">
            Ask an admin of CompanyFlags for a password reset link: they make one from your row in Settings → People.
            It works once, for a day. {info.sso ? 'Or sign in with SSO below.' : ''}
          </Callout>
        )}
        {!signup && (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-ink-1">
            <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} />
            Remember me
            <span className="text-13 text-ink-3">{remember ? '' : '(signed out when you close the browser)'}</span>
          </label>
        )}
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <Button type="submit" className="mt-1 h-10 w-full" disabled={busy || !email.trim() || !password}>
          {busy ? (signup ? 'Creating…' : 'Signing in…') : signup ? 'Create admin account' : 'Sign in'}
        </Button>
        {!signup && (info.sso || info.providers.length > 0) && (
          <div className="grid gap-2.5">
            {info.sso && <WayButton way="sso" label="Sign in with" disabled={busy} onClick={sso} />}
            <Providers providers={info.providers} label="Sign in with" onError={setError} />
          </div>
        )}
      </form>
    </Frame>
  );
}

/** An invite link from an admin (#/join/<invite>): make a password, or sign in with a provider as the same email. */
export function JoinPage({ token }: { token: string }) {
  const { info } = useSignInInfo();
  const [invite, setInvite] = useState<{ email: string; name: string } | null | 'gone'>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(takeReturnedError);
  useEffect(() => {
    fetch(`/api/invites/${encodeURIComponent(token)}`).then(async (r) => {
      if (!r.ok) { setInvite('gone'); return; }
      const v = await r.json();
      setInvite(v); setName(v.name);
    }, () => setInvite('gone'));
  }, [token]);
  const toSignIn = (t: Tab) => { if (t === 'signin') { location.hash = '#/flags'; location.reload(); } };

  if (invite === null) return <JoinSkeleton />;
  if (invite === 'gone') {
    return (
      <Frame tab="signup" onTab={toSignIn} title="This invite link doesn’t work any more" intro="It has been used, or it has expired (links work for 7 days). Ask an admin for a new one.">
        <Button className="h-10 w-full" onClick={() => toSignIn('signin')}>Go to sign in</Button>
      </Frame>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    let done = false;   // joined: the page reloads, so the button stays busy
    try {
      const { error: err } = await authClient.signUp.email({
        email: invite.email, name: name.trim() || invite.email, password, fetchOptions: { headers: { 'x-invite': token } },
      });
      if (err) { setError(explain(err)); return; }
      done = true;
      signedIn();
    } catch {
      setError(UNREACHABLE);
    } finally {
      if (!done) setBusy(false);
    }
  };
  const providers = info?.kind === 'better-auth' ? info.providers : [];
  const sso = info?.kind === 'better-auth' && info.sso;
  return (
    <Frame tab="signup" onTab={toSignIn} title="Join CompanyFlags" intro={<>You’re invited as <strong className="font-medium text-ink">{invite.email}</strong>.</>}>
      <form className="grid gap-4" onSubmit={submit}>
        <Labeled id="jn-name" label="Your name">
          <Input id="jn-name" className={field} value={name} autoComplete="name" autoFocus onChange={(e) => setName(e.target.value)} placeholder="Sam Lee" />
        </Labeled>
        <Labeled id="jn-password" label="Choose a password" hint="At least 10 characters.">
          <PasswordInput id="jn-password" value={password} onChange={setPassword} autoComplete="new-password" required minLength={10} />
        </Labeled>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <Button type="submit" className="mt-1 h-10 w-full" disabled={busy || password.length < 10}>{busy ? 'Creating…' : 'Create account'}</Button>
      </form>
      {(providers.length > 0 || sso) && (
        <div className="grid gap-2.5">
          <p className="m-0 text-13 text-ink-3">Or sign in with an account for {invite.email}:</p>
          {sso && <WayButton way="sso" label="Sign in with" disabled={busy}
            onClick={() => { setBusy(true); setError(null); void startSso(invite.email, (m) => { setBusy(false); setError(m); }); }} />}
          <Providers providers={providers} label="Continue with" onError={setError} />
        </div>
      )}
    </Frame>
  );
}

/** A password reset link from an admin (#/reset/<token>): choose a new password. It works once, for a day, and signs
 *  the person out everywhere; then they sign in with the new password. */
export function ResetPage({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const toSignIn = () => { location.hash = '#/flags'; location.reload(); };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const { error: err } = await authClient.resetPassword({ newPassword: password, token });
      if (err) {
        setError(/token/i.test(err.message ?? '') || err.status === 400 && !/password/i.test(err.message ?? '')
          ? 'This reset link doesn’t work any more: it was used, or it’s more than a day old. Ask an admin for a new one.'
          : explain(err));
        return;
      }
      rememberSignedIn(false);
      setDone(true);
    } catch {
      setError(UNREACHABLE);
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <Frame tab="signin" onTab={toSignIn} title="Your password is changed" intro="You’re signed out everywhere. Sign in with your new password.">
        <Button className="h-10 w-full" onClick={toSignIn}>Go to sign in</Button>
      </Frame>
    );
  }
  return (
    <Frame tab="signin" onTab={toSignIn} title="Choose a new password" intro="An admin made you this link. It works once, for a day.">
      <form className="grid gap-4" onSubmit={submit}>
        <Labeled id="rs-password" label="New password" hint="At least 10 characters.">
          <PasswordInput id="rs-password" value={password} onChange={setPassword} autoComplete="new-password" required minLength={10} />
        </Labeled>
        {error && <Callout tone="error" role="alert">{error}</Callout>}
        <Button type="submit" className="mt-1 h-10 w-full" disabled={busy || password.length < 10}>{busy ? 'Saving…' : 'Set new password'}</Button>
      </form>
    </Frame>
  );
}

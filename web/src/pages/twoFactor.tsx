import { useCallback, useEffect, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { Drawer } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { api } from '../api.ts';
import { useApp } from '../app.ts';
import { Badge, ErrorList, Field } from '../ui.tsx';
import { copyText, useAsync } from '../uiKit.ts';
import { codeOf, isAppCode, setupKey, twoFactorCall, type Account, type Enabled } from './twoFactorKit.ts';

/*
 * Two-factor sign-in for a password account (server/betterAuth.ts, Better Auth's twoFactor plugin): after the
 * password, a code from an authenticator app (1Password, Google Authenticator, Authy…), or one of ten recovery codes,
 * each good once. Set up on the Access tokens page; an admin whose organization asks it of admins sets it up first
 * (TwoFactorGate) before anything else in the console. People who sign in with single sign-on or a provider have no
 * password here: their identity provider asks for any second factor.
 */

function useAccount() {
  const [account, setAccount] = useState<Account | null>(null);
  const load = useCallback(() => api<Account>('GET', '/account').then(setAccount, () => setAccount(null)), []);
  useEffect(() => { void load(); }, [load]);
  return { account, load };
}

/** On the Access tokens page: whether two-factor sign-in is on, and the buttons to set it up or turn it off. */
export function TwoFactorSection() {
  const { meta, toast } = useApp();
  const { account, load } = useAccount();
  const [open, setOpen] = useState<'setup' | 'off' | 'codes' | null>(null);
  if (meta.signIn !== 'better-auth' || !account) return null;
  if (!account.password) {
    return <p className="m-0 border-b border-grid px-6 py-3 text-13 text-ink-2 max-sm:px-4">Two-factor sign-in: you sign in with single sign-on or a provider, so your identity provider asks for any second factor.</p>;
  }
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-grid px-6 py-3 text-13 max-sm:px-4">
      <span className="flex min-w-0 flex-1 items-center gap-2 text-ink-2">
        <b className="font-medium text-ink">Two-factor sign-in</b>
        {account.twoFactor ? <Badge>on</Badge> : <Badge kind="warn">off</Badge>}
        <span>{account.twoFactor ? 'After your password, a code from your authenticator app.' : 'Add a code from an authenticator app after your password.'}</span>
      </span>
      {account.twoFactor ? <>
        <Button variant="secondary" onClick={() => setOpen('codes')}>New recovery codes</Button>
        <Button variant="secondary" onClick={() => setOpen('off')}>Turn off</Button>
      </> : <Button onClick={() => setOpen('setup')}>Set up</Button>}
      {open === 'setup' && <SetUpDrawer onClose={() => setOpen(null)} onDone={() => { setOpen(null); void load(); toast('Two-factor sign-in is on'); }} />}
      {open === 'off' && <PasswordDrawer title="Turn off two-factor sign-in" action="Turn off" busyText="Turning off…"
        intro="Your password alone signs you in again. If your organization asks admins for it, you’ll be asked to set it up again."
        onClose={() => setOpen(null)} run={(password) => twoFactorCall('disable', { password }).then(() => { setOpen(null); void load(); toast('Two-factor sign-in is off'); })} />}
      {open === 'codes' && <NewCodesDrawer onClose={() => setOpen(null)} />}
    </div>
  );
}

/** The whole page while an admin must set up two-factor sign-in first (server/access.ts needsTwoFactor). */
export function TwoFactorGate() {
  const [open, setOpen] = useState(false);
  return (
    <div className="grid max-w-[620px] content-start gap-4 p-12 max-sm:p-6">
      <h1 className="m-0 text-[28px] leading-tight font-semibold text-ink">Set up two-factor sign-in</h1>
      <p className="m-0 text-ink-2">
        Your organization asks admins who sign in with a password for a second step: a code from an authenticator app.
        Set it up to go on. It takes a minute.
      </p>
      <div><Button onClick={() => setOpen(true)}>Set up two-factor sign-in</Button></div>
      {open && <SetUpDrawer onClose={() => setOpen(false)} onDone={() => location.reload()} />}
    </div>
  );
}

/** Your password, then the authenticator app's setup key and your recovery codes, then a code from the app to finish. */
function SetUpDrawer({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { toast } = useApp();
  const [password, setPassword] = useState('');
  const [enabled, setEnabled] = useState<Enabled | null>(null);
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAsync();
  const start = async () => {
    const r = await run(() => twoFactorCall<Enabled>('enable', { password }));
    if (r) { setEnabled(r); setPassword(''); }
  };
  const finish = async () => {
    if (await run(() => twoFactorCall('verify-totp', { code: codeOf(code) }).then(() => true))) onDone();
  };
  return (
    <Drawer open onClose={onClose} title="Set up two-factor sign-in"
      subtitle={enabled ? 'Add CompanyFlags to your authenticator app, keep your recovery codes, then type a code.' : 'First, your password.'}
      footer={enabled ? <>
        <Button disabled={busy || !saved || !isAppCode(code)} onClick={() => void finish()}>{busy ? 'Checking…' : 'Turn on'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </> : <>
        <Button disabled={busy || !password} onClick={() => void start()}>{busy ? 'Starting…' : 'Next'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-4">
        {!enabled ? (
          <Field label="Your password">
            {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the step that just opened asks for one thing: the cursor starts there */}
            <Input type="password" className="h-[34px] text-13" value={password} autoComplete="current-password" autoFocus
              onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && password) void start(); }} />
          </Field>
        ) : <>
          <div className="grid gap-2">
            <span className="text-13 font-medium text-ink">1. In your authenticator app, add an account with this setup key</span>
            <code className="block border border-rule bg-wash px-3 py-2 font-mono text-sm tracking-wide break-all">{setupKey(enabled.totpURI)}</code>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => void copyText(setupKey(enabled.totpURI).replaceAll(' ', ''), 'the setup key', toast)}>Copy key</Button>
              <Button variant="secondary" onClick={() => void copyText(enabled.totpURI, 'the otpauth:// address', toast)}>Copy otpauth:// address</Button>
            </div>
            <span className="text-13 text-ink-3">Time-based, 6 digits, every 30 seconds. Password managers that keep one-time codes take the otpauth:// address.</span>
          </div>
          <div className="grid gap-2">
            <span className="text-13 font-medium text-ink">2. Keep your recovery codes</span>
            <span className="text-13 text-ink-2">If you lose your phone, each one signs you in once. They aren’t shown again.</span>
            <code className="grid grid-cols-2 gap-x-6 gap-y-1 border border-rule bg-wash px-3 py-2 font-mono text-13">
              {enabled.backupCodes.map((c) => <span key={c}>{c}</span>)}
            </code>
            <div><Button variant="secondary" onClick={() => { void copyText(enabled.backupCodes.join('\n'), 'the recovery codes', toast); setSaved(true); }}>Copy recovery codes</Button></div>
            <label className="flex cursor-pointer items-center gap-2 text-13 text-ink-1">
              <Checkbox checked={saved} onCheckedChange={(v) => setSaved(v === true)} /> I’ve kept them somewhere safe
            </label>
          </div>
          <Field label="3. The code your app shows now">
            <Input className="h-[34px] w-40 font-mono text-13 tracking-widest" inputMode="numeric" autoComplete="one-time-code" value={code}
              onChange={(e) => setCode(e.target.value)} placeholder="123456" />
          </Field>
        </>}
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

/** Asks for your password, then does what it's for. */
function PasswordDrawer({ title, intro, action, busyText, onClose, run: act }: {
  title: string; intro: string; action: string; busyText: string; onClose: () => void; run: (password: string) => Promise<unknown>;
}) {
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAsync();
  const go = () => void run(() => act(password));
  return (
    <Drawer open onClose={onClose} title={title} subtitle={intro}
      footer={<><Button variant="stop" disabled={busy || !password} onClick={go}>{busy ? busyText : action}</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></>}>
      <div className="grid gap-4">
        <Field label="Your password">
          {/* oxlint-disable-next-line jsx-a11y/no-autofocus -- the step that just opened asks for one thing: the cursor starts there */}
          <Input type="password" className="h-[34px] text-13" value={password} autoComplete="current-password" autoFocus
            onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && password) go(); }} />
        </Field>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

/** New recovery codes: the old ones stop working. */
function NewCodesDrawer({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!codes) {
    return <PasswordDrawer title="New recovery codes" action="Make new codes" busyText="Making…" onClose={onClose}
      intro="Your old recovery codes stop working, and ten new ones are shown once."
      run={(password) => twoFactorCall<{ backupCodes: string[] }>('generate-backup-codes', { password }).then((r) => setCodes(r.backupCodes))} />;
  }
  return (
    <Drawer open onClose={onClose} title="Your new recovery codes" subtitle="Each one signs you in once. They aren’t shown again."
      footer={<><Button onClick={() => void copyText(codes.join('\n'), 'the recovery codes', toast)}>Copy</Button><Button variant="secondary" onClick={onClose}>Done</Button></>}>
      <Callout>Keep them somewhere safe, away from your phone.</Callout>
      <code className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 border border-rule bg-wash px-3 py-2 font-mono text-13">
        {codes.map((c) => <span key={c}>{c}</span>)}
      </code>
    </Drawer>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Drawer, DrawerSection } from '@companyflags/ui/components/drawer';
import { Input } from '@companyflags/ui/components/input';
import { Segmented } from '@companyflags/ui/components/segmented';
import { BrandMark } from '@companyflags/ui/components/app-frame';
import { cn } from '@companyflags/ui/lib/utils';
import { api } from '../api.ts';
import { useApp } from '../app.ts';
import { Bone } from '../loading.tsx';
import { ErrorList, Field, Heading, When } from '../ui.tsx';
import { textareaField, useAsync } from '../uiKit.ts';
import { applyLook, currentLook, fileAsDataUrl, loadLook } from '../appearanceKit.ts';
import { roleInfo } from '../../../server/policy.ts';
import {
  ACCENTS, accentColors, DEFAULT_NAME, EMPTY, imageOf, knownAccent, LIMITS, linkProblem, lowContrast, MODES, nearMeaning, TONES,
  type Accent, type Appearance, type Mode, type Source, type Tone,
} from '../../../server/appearance.ts';

/*
 * Settings → Appearance (server/appearance.ts): how the console looks for everyone here. Its name and logo, the
 * browser tab's icon, an accent color, light or dark for people who haven't chosen, a notice at the top of every page,
 * a note on the sign-in page, a help link and links in the footer. Set in companyflags.config.ts, it shows read-only.
 * While the form is open the accent and the default look show on the page itself; Cancel puts them back.
 */

type Saved = Appearance & { source: Source; updatedAt: string | null; updatedBy: string | null };
const PATH = '/appearance/settings';

export function AppearanceSection() {
  const { meta } = useApp();
  const admin = roleInfo(meta.me.role).changesSettings;
  const [saved, setSaved] = useState<Saved | null>(null);
  const [editing, setEditing] = useState(false);
  const { error, setError } = useAsync();
  const load = () => api<Saved>('GET', PATH).then(setSaved, (e) => setError({ message: e.message }));
  useEffect(() => { void load(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const fromServer = saved?.source === 'server';
  const changed = saved && JSON.stringify({ ...saved, source: undefined, updatedAt: undefined, updatedBy: undefined }) !== JSON.stringify({ ...EMPTY, source: undefined, updatedAt: undefined, updatedBy: undefined });
  return (
    <section aria-labelledby="s-look" className="grid gap-3">
      <Heading id="s-look" title="Appearance" quiet action={admin && saved && !fromServer && <Button onClick={() => setEditing(true)}>Change</Button>}>
        Your name, logo and colors in the console and on the sign-in page, a notice for everyone, and your own links.
      </Heading>
      <ErrorList error={error} />
      {!saved ? (error ? null : <div aria-hidden className="flex h-[46px] items-center border border-grid px-4"><Bone className="w-2/3" /></div>) : (
        <div className="grid gap-3 border border-grid p-4">
          <dl className="m-0 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-2 text-13">
            <dt className="text-ink-3">Name</dt><dd className="m-0 min-w-0 truncate">{saved.name ?? <span className="text-ink-3">{DEFAULT_NAME}</span>}</dd>
            <dt className="text-ink-3">Logo</dt>
            <dd className="m-0 flex items-center gap-3">
              {saved.logo ? <Preview src={saved.logo} label="Logo" /> : <span className="flex items-center gap-2 text-ink-3"><BrandMark /> Ours</span>}
              {saved.logoDark && <Preview src={saved.logoDark} label="Logo on dark" dark />}
            </dd>
            <dt className="text-ink-3">Accent</dt><dd className="m-0 flex items-center gap-2"><Swatch a={saved} />{ACCENTS[knownAccent(saved.accent)].label}{saved.accent === 'custom' && <span className="font-mono text-ink-2">{saved.accentColor}</span>}</dd>
            <dt className="text-ink-3">Light or dark</dt><dd className="m-0">{MODES[saved.mode]}<span className="text-ink-3">, until a person chooses</span></dd>
            <dt className="text-ink-3">Notice</dt><dd className="m-0 min-w-0 truncate">{saved.banner ? <>{TONES[saved.banner.tone]}: {saved.banner.text}</> : <span className="text-ink-3">None</span>}</dd>
            <dt className="text-ink-3">Sign-in note</dt><dd className="m-0 min-w-0 truncate">{saved.signInNote ?? <span className="text-ink-3">None</span>}</dd>
            <dt className="text-ink-3">Links</dt>
            <dd className="m-0 min-w-0 truncate">{[...saved.links.map((l) => l.label), ...(saved.helpUrl ? ['Get help'] : [])].join(', ') || <span className="text-ink-3">None</span>}</dd>
            <dt className="text-ink-3">Set</dt>
            <dd className="m-0 text-ink-2">
              {fromServer ? 'On the server, in companyflags.config.ts (appearance). Change it there.'
                : saved.updatedBy ? <>By {meta.users.find((u) => u.key === saved.updatedBy)?.name ?? saved.updatedBy}{saved.updatedAt && <>, <When iso={saved.updatedAt} /></>}</>
                : 'Not changed: CompanyFlags’s own look.'}
            </dd>
          </dl>
          {admin && !fromServer && changed && <div><ResetButton onDone={(s) => setSaved(s)} /></div>}
        </div>
      )}
      {saved && editing && <AppearanceDrawer saved={saved} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void load(); }} />}
    </section>
  );
}

function ResetButton({ onDone }: { onDone: (s: Saved) => void }) {
  const { ask, toast, reload } = useApp();
  const { busy, run } = useAsync();
  const reset = async () => {
    const { action } = await ask({
      title: 'Go back to CompanyFlags’s own look?',
      body: <p>The name, logo, icon, accent, notice, sign-in note and links are removed for everyone.</p>,
      actions: [{ id: 'cancel', label: 'Cancel' }, { id: 'reset', label: 'Go back', tone: 'danger' }],
    });
    if (action !== 'reset') return;
    if (!(await run(() => api('DELETE', '/appearance')))) return;
    await loadLook(true);
    void reload();
    onDone(await api<Saved>('GET', PATH));
    toast('Appearance is back to the default');
  };
  return <Button variant="secondary" disabled={busy} onClick={() => void reset()}>Back to default</Button>;
}

const Preview = ({ src, label, dark }: { src: string; label: string; dark?: boolean }) => (
  <span className={cn('inline-flex h-8 items-center border border-rule px-2', dark ? 'bg-black' : 'bg-white')}>
    <img src={src} alt={label} className="h-5 max-w-40 object-contain" />
  </span>
);

function Swatch({ a, className }: { a: Pick<Appearance, 'accent' | 'accentColor'>; className?: string }) {
  const c = accentColors(a);
  return c ? (
    <span aria-hidden className={cn('inline-flex size-4 shrink-0 border border-rule-2', className)}>
      <i className="flex-1" style={{ background: c.light }} /><i className="flex-1" style={{ background: c.dark }} />
    </span>
  ) : <span aria-hidden className={cn('inline-flex size-4 shrink-0 border border-rule-2', className)}><i className="flex-1 bg-black" /><i className="flex-1 bg-white" /></span>;
}

/** The form. The accent and the default look show on the page while it's open. */
function AppearanceDrawer({ saved, onClose, onSaved }: { saved: Saved; onClose: () => void; onSaved: () => void }) {
  const { toast, reload } = useApp();
  const first = useRef<HTMLInputElement>(null);
  const [a, setA] = useState<Appearance>(() => {
    const { source: _, updatedAt: __, updatedBy: ___, ...rest } = saved;
    return { ...EMPTY, ...rest, accent: knownAccent(rest.accent) };
  });
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => setA((x) => ({ ...x, [k]: v }));
  const { busy, error, run } = useAsync();

  // the page shows the accent and the default look as they're picked; closing without saving puts them back
  useEffect(() => { applyLook({ ...a, icon: a.icon }); }, [a]);
  useEffect(() => () => { applyLook(currentLook()); }, []);

  const linkErrors = a.links.map((l) => (l.url && linkProblem(l.url) ? `${l.label || 'This link'} ${linkProblem(l.url)}` : null));
  const helpError = a.helpUrl && linkProblem(a.helpUrl);
  const ready = !linkErrors.some(Boolean) && !helpError && !(a.accent === 'custom' && !a.accentColor);
  const hard = lowContrast(a);
  const shades = accentColors(a);
  const meaning = a.accent === 'custom' && a.accentColor ? nearMeaning(a.accentColor) : null;

  const save = async () => {
    const body = { ...a, links: a.links.filter((l) => l.label.trim() || l.url.trim()), banner: a.banner?.text.trim() ? a.banner : null };
    if (!(await run(() => api('PUT', '/appearance', body)))) return;
    await loadLook(true);
    void reload();                               // the notice is in /meta
    toast('Appearance saved: everyone sees it on their next page');
    onSaved();
  };

  return (
    <Drawer open onClose={onClose} title="Appearance" initialFocus={first} width={640}
      subtitle="How the console and the sign-in page look for everyone on this server."
      footer={<>
        <Button disabled={busy || !ready} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
      </>}>
      <div className="grid gap-6">
        <DrawerSection title="Name and logo">
          <div className="grid gap-4">
            <Field label="Name" hint={`In the title bar, the browser tab and on the sign-in page. Empty: ${DEFAULT_NAME}.`}>
              <Input ref={first} className="h-[34px] text-13" value={a.name ?? ''} maxLength={LIMITS.name} placeholder={DEFAULT_NAME}
                onChange={(e) => set('name', e.target.value || null)} />
            </Field>
            <ImageField label="Logo" hint="Shown 20 pixels high, before the name. PNG or SVG, up to 200 KB. With a logo and no name, the logo is shown alone."
              value={a.logo} max={LIMITS.image} onChange={(v) => set('logo', v)} />
            <ImageField label="Logo on dark" hint="Optional: for the dark look, if your logo doesn’t read on black." dark
              value={a.logoDark} max={LIMITS.image} onChange={(v) => set('logoDark', v)} />
            <ImageField label="Browser tab icon" hint="A square image: SVG, PNG or ICO, up to 50 KB." value={a.icon} max={LIMITS.icon} onChange={(v) => set('icon', v)} square />
          </div>
        </DrawerSection>

        <DrawerSection title="Colors">
          <div className="grid gap-4">
            <Field label="Accent" htmlFor="appearance-accent" hint="Primary buttons and the selected page take this color. Switches and focus rings stay black and white, and red, green, amber and purple are kept for what they mean.">
              {/* buttons that stay pressed: each is its own Tab stop, so they're not a radio group (that needs arrow keys) */}
              <div id="appearance-accent" role="group" aria-label="Accent" className="flex flex-wrap gap-2">
                {(Object.keys(ACCENTS) as Accent[]).map((k) => (
                  <button key={k} type="button" aria-pressed={a.accent === k}
                    onClick={() => setA((x) => ({ ...x, accent: k, accentColor: k === 'custom' ? x.accentColor ?? '#2563eb' : null }))}
                    className={cn('flex h-8 cursor-default items-center gap-2 border px-2.5 text-13',
                      a.accent === k ? 'border-tint text-ink' : 'border-rule-2 text-ink-2 hover:border-ink-3 hover:text-ink')}>
                    <Swatch a={{ accent: k, accentColor: k === 'custom' ? a.accentColor ?? '#2563eb' : null }} />
                    {ACCENTS[k].label}
                  </button>
                ))}
              </div>
            </Field>
            {a.accent === 'custom' && (
              <Field label="Your color" hint="Used as it is where it reads at 4.5:1, and made darker on the light page or lighter on the dark page where it doesn’t. Text on it is black or white, whichever reads better.">
                <div className="flex items-center gap-2">
                  <input type="color" aria-label="Pick a color" value={a.accentColor ?? '#2563eb'} onChange={(e) => set('accentColor', e.target.value)}
                    className="h-[34px] w-12 cursor-default border border-rule-2 bg-background p-0.5" />
                  <Input className="h-[34px] w-32 font-mono text-13" value={a.accentColor ?? ''} maxLength={7}
                    onChange={(e) => set('accentColor', e.target.value.trim().toLowerCase() || null)} placeholder="#2563eb" />
                </div>
              </Field>
            )}
            {hard.length > 0 && shades && (
              <Callout tone="warn">
                This color is hard to read on the {hard.join(' and ')} page, so the console uses <span className="font-mono">{hard.map((m) => shades[m]).join(' and ')}</span> there.
                Pick a {hard.includes('dark') ? 'lighter' : 'darker'} one to keep it as it is.
              </Callout>
            )}
            {meaning && <Callout tone="warn">This color looks like {meaning}, which the console keeps for what it means (production and danger, on, waiting, agents). People may misread buttons in it.</Callout>}
            <Field label="Light or dark" hint="For people who haven’t chosen themselves. Anyone can still switch in the title bar.">
              <Segmented label="Light or dark" value={a.mode} onChange={(v: Mode) => set('mode', v)}
                options={(Object.keys(MODES) as Mode[]).map((m) => ({ value: m, label: m === 'device' ? 'Device' : MODES[m] }))} />
            </Field>
          </div>
        </DrawerSection>

        <DrawerSection title="Words for everyone">
          <div className="grid gap-4">
            <Field label="Notice" hint="Across the top of every page, for everyone signed in: a freeze, planned work, where to ask. Empty: none.">
              <textarea className={textareaField} rows={2} maxLength={LIMITS.banner} value={a.banner?.text ?? ''}
                placeholder="Release freeze until Monday: production changes need two approvals."
                onChange={(e) => set('banner', { text: e.target.value, tone: a.banner?.tone ?? 'info' })} />
            </Field>
            {a.banner?.text.trim() && (
              <Segmented label="How the notice looks" value={a.banner.tone} onChange={(t: Tone) => set('banner', { text: a.banner!.text, tone: t })}
                options={(Object.keys(TONES) as Tone[]).map((t) => ({ value: t, label: TONES[t] }))} />
            )}
            <Field label="Sign-in note" hint="Under the sign-in form: who may sign in, or that use is logged.">
              <textarea className={textareaField} rows={2} maxLength={LIMITS.signInNote} value={a.signInNote ?? ''}
                placeholder="For Acme Corp staff only. Sign in with your work account."
                onChange={(e) => set('signInNote', e.target.value || null)} />
            </Field>
          </div>
        </DrawerSection>

        <DrawerSection title="Links">
          <div className="grid gap-4">
            <Field label="Help link" hint="“Get help” on the sign-in page, in the account menu and the footer: your team’s channel, wiki or an email (mailto:).">
              <Input className="h-[34px] text-13" value={a.helpUrl ?? ''} maxLength={LIMITS.url} placeholder="https://wiki.acme.example/flags"
                aria-invalid={!!helpError || undefined} onChange={(e) => set('helpUrl', e.target.value.trim() || null)} />
            </Field>
            {helpError && <p className="-mt-2 m-0 text-13 text-live">The help link {helpError}.</p>}
            <div className="grid gap-2">
              <span className="text-13 font-medium text-ink">Footer links</span>
              <span className="-mt-1 text-13 text-ink-2">Up to {LIMITS.links}: privacy, terms of use, an internal page.</span>
              {a.links.map((l, i) => (
                <div key={i} className="grid grid-cols-[minmax(0,0.8fr)_minmax(0,1.6fr)_auto] gap-2 max-sm:grid-cols-1">
                  <Input className="h-[34px] text-13" aria-label={`Link ${i + 1} label`} value={l.label} maxLength={LIMITS.linkLabel} placeholder="Privacy"
                    onChange={(e) => set('links', a.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                  <Input className="h-[34px] text-13" aria-label={`Link ${i + 1} address`} value={l.url} maxLength={LIMITS.url} placeholder="https://acme.example/privacy"
                    aria-invalid={!!linkErrors[i] || undefined}
                    onChange={(e) => set('links', a.links.map((x, j) => (j === i ? { ...x, url: e.target.value.trim() } : x)))} />
                  <Button variant="secondary" className="h-[34px]" aria-label={`Remove link ${i + 1}`} onClick={() => set('links', a.links.filter((_, j) => j !== i))}>Remove</Button>
                  {linkErrors[i] && <p className="col-span-full m-0 text-13 text-live">{linkErrors[i]}.</p>}
                </div>
              ))}
              {a.links.length < LIMITS.links && (
                <div><Button variant="secondary" onClick={() => set('links', [...a.links, { label: '', url: '' }])}>+ Add link</Button></div>
              )}
            </div>
          </div>
        </DrawerSection>
        <ErrorList error={error} />
      </div>
    </Drawer>
  );
}

/** Picking an image: its preview, a file button and Remove. Checked here first (type, size), and again by the server. */
function ImageField({ label, hint, value, max, onChange, dark, square }: {
  label: string; hint: string; value: string | null; max: number; onChange: (v: string | null) => void; dark?: boolean; square?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProblem(null);
    try {
      const url = await fileAsDataUrl(file);
      imageOf(url, max);
      onChange(url);
    } catch (e) { setProblem((e as Error).message); }
    if (input.current) input.current.value = '';
  };
  return (
    <Field label={label} hint={hint}>
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('inline-flex h-[34px] items-center justify-center border border-rule px-2', dark ? 'bg-black' : 'bg-white', square ? 'w-[34px]' : 'min-w-24')}>
            {value ? <img src={value} alt={`${label} preview`} className={cn('object-contain', square ? 'size-5' : 'h-5 max-w-40')} /> : <span className={cn('text-11', dark ? 'text-white/50' : 'text-black/40')}>None</span>}
          </span>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} accept="image/png,image/svg+xml,image/webp,image/jpeg,image/gif,image/x-icon,.ico"
            onChange={(e) => void pick(e.target.files?.[0])} />
          <Button variant="secondary" className="h-[34px]" onClick={() => input.current?.click()}>{value ? 'Replace' : 'Choose file'}</Button>
          {value && <Button variant="secondary" className="h-[34px]" onClick={() => onChange(null)}>Remove</Button>}
        </div>
        {problem && <p className="m-0 text-13 text-live">{problem[0].toUpperCase() + problem.slice(1)}.</p>}
      </div>
    </Field>
  );
}

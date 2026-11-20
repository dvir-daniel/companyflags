'use client';
// The landing page, in the look of the console and of better-auth.com: a fixed hero on the left, README-style
// sections on the right, 1px rules, mono uppercase labels, square corners.
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { IllusHowItWorks } from '../illus/how-it-works';
import './landing.css';

const repo = 'https://github.com/dvir-daniel/companyflags';

const install = {
  Docker: [
    'docker run -d --name companyflags -p 8787:8787 -v companyflags:/data \\',
    '  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \\',
    '  -e BETTER_AUTH_URL=http://localhost:8787 \\',
    '  ghcr.io/dvir-daniel/companyflags',
  ],
  Compose: [
    'curl -O https://raw.githubusercontent.com/dvir-daniel/companyflags/main/docker-compose.yml',
    'echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env',
    'docker compose up -d',
  ],
  Source: [
    'git clone https://github.com/dvir-daniel/companyflags.git',
    'cd companyflags && corepack enable && pnpm install',
    'pnpm serve',
  ],
} satisfies Record<string, string[]>;
type InstallTab = keyof typeof install;
const installTabs = Object.keys(install) as InstallTab[];

const usage = {
  'Web app': {
    file: 'flags.ts',
    lines: [
      "import { OpenFeature } from '@openfeature/web-sdk'",
      "import { OFREPWebProvider } from '@openfeature/ofrep-web-provider'",
      '',
      'await OpenFeature.setContext({',
      '  targetingKey: installId,',
      "  app: { version: '6.0.0' },",
      '})',
      'await OpenFeature.setProviderAndWait(new OFREPWebProvider({',
      "  baseUrl: 'https://flags.example.com',",
      "  headers: [['Authorization', 'Bearer ff_prod_web_…']], // the web service’s key: public",
      '}))',
      '',
      "OpenFeature.getClient().getBooleanValue('new_checkout', false)",
    ],
  },
  Backend: {
    file: 'server.ts',
    lines: [
      "import { OpenFeature } from '@openfeature/server-sdk'",
      "import { OFREPProvider } from '@openfeature/ofrep-provider'",
      '',
      'await OpenFeature.setProviderAndWait(new OFREPProvider({',
      "  baseUrl: 'https://flags.example.com',",
      "  headers: [['Authorization', `Bearer ${process.env.FLAGS_API_KEY}`]],",
      '}))',
      '',
      '// name the entity by its dimension, as your rules do',
      'const limit = await OpenFeature.getClient().getNumberValue(',
      "  'max_upload_mb', 100, { company: 'acme', targetingKey: userId },",
      ')',
    ],
  },
  flagd: {
    file: 'terminal',
    lines: [
      '# flagd downloads one entity’s rules and answers in memory',
      'flagd start --sources=\'[{',
      '  "uri": "https://flags.example.com/sdk/v1/flagd/company/acme",',
      '  "provider": "http",',
      '  "authHeader": "Bearer ff_prod_api_…",',
      '  "interval": 30',
      '}]\'',
    ],
  },
} satisfies Record<string, { file: string; lines: string[] }>;
type UsageTab = keyof typeof usage;
const usageTabs = Object.keys(usage) as UsageTab[];

// The live answer under the mark: what the server answers for one flag and one context, one after another
const answers: { flag: string; ctx: string; value: string; why: string }[] = [
  { flag: 'new_checkout', ctx: 'acme · ios 6.2', value: 'true', why: 'RULE · 25%' },
  { flag: 'max_upload_mb', ctx: 'globex', value: '500', why: 'OWN SETTING' },
  { flag: 'ai_model', ctx: 'lumen · web', value: '"fast-v2"', why: 'SPLIT · B' },
  { flag: 'dark_mode', ctx: 'bolt · android', value: 'false', why: 'OVERRIDE' },
];

// the flags that run through the mark's bars, and the languages OpenFeature reads them in
const keys = ['new_checkout', 'max_upload_mb', 'ai_model', 'dark_mode', 'search_v2', 'kill_payments', 'onboarding_steps', 'prompt_config', 'rate_limit', 'beta_banner'];
const rows = [keys, [...keys].reverse(), keys.slice(3).concat(keys.slice(0, 3))];
const languages = ['Web', 'React', 'Angular', 'Node.js', 'Go', 'Java', 'Python', '.NET', 'PHP', 'Ruby', 'Rust', 'Kotlin', 'Swift', 'Android', 'iOS', 'flagd'];

const features: { title: string; text: string; chips: string[] }[] = [
  { title: 'Your own dimensions.', text: 'Serve config per region › store, per team, per customer, or whatever your product is made of. Up to four levels, in your words.', chips: ['region › store', 'team', 'customer'] },
  { title: 'Settings per entity.', text: 'Any region, store or team can have settings of its own, inherited down the chain, under rules for everyone.', chips: ['inherit', 'own settings'] },
  { title: 'Locked rules.', text: 'Overrides apply to everyone, always, and fail closed when a value is missing. No entity can change them.', chips: ['override', 'fail closed'] },
  { title: 'OpenFeature, no SDK of ours.', text: 'OFREP for OpenFeature’s web, Android, iOS and server providers; flagd JSON for in-process backends.', chips: ['OFREP', 'flagd', 'React'] },
  { title: 'Move over one flag at a time.', text: 'Run it next to the system you have now. Import its values; apps read the old one for every flag not moved yet.', chips: ['import', 'side by side', 'JSONata'] },
  { title: 'Releases.', text: 'Early access, then 1% → 5% → 25% → 50% of devices, then everyone; or versions 1.0.0 → 1.0.1. On call rolls back.', chips: ['1%', '5%', '25%', '1.0.1'] },
  { title: 'Made for AI.', text: 'AI-written code ships off, then to a few, with a kill switch. Models and prompts are JSON flags you roll out and roll back.', chips: ['kill switch', 'model', 'prompt'] },
  { title: 'Reviewed changes.', text: 'Production can require an approval for every change, with scheduling and break-glass for on call.', chips: ['approve', 'schedule', 'break-glass'] },
  { title: 'History and restore.', text: 'An append-only history, versions of every environment, restore, and two entities compared flag by flag.', chips: ['history', 'restore', 'compare'] },
  { title: 'Your sign-in.', text: 'Email and password, Google, GitHub, Microsoft, and single sign-on with SAML or OIDC, through Better Auth.', chips: ['SAML', 'OIDC', 'invites'] },
  { title: 'Webhooks out and in.', text: 'Each change to Slack, CI or the old system, signed; and the old system’s changes in, while both run.', chips: ['Slack', 'signed', 'JSONata'] },
  { title: 'Flags as code, and plugins.', text: 'Keep flags in a file reviewed with your code, and run only the plugins you need, from one typed config file.', chips: ['pull', 'plan', 'push'] },
];

const runIt: { label: string; text: string }[] = [
  { label: 'One image', text: 'The server, the console and the app files in one container, with health checks.' },
  { label: 'Postgres', text: 'Your own Postgres 15+, or an embedded one to try it. Migrations run at start.' },
  { label: 'Any scale', text: 'Several instances on one database, and a CDN-cached file per entity for very large fleets.' },
];

type Bar = { x: number; w: number };
type Swapped = { answer: boolean; install: boolean; usage: boolean };

const still = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// where the chosen tab sits in its row, for the line under it
function measure(row: HTMLElement | null): Bar | undefined {
  const on = row?.querySelector<HTMLElement>('button.on');
  return on ? { x: on.offsetLeft, w: on.offsetWidth } : undefined;
}

export function Landing() {
  const [installTab, setInstallTab] = useState<InstallTab>('Docker');
  const [usageTab, setUsageTab] = useState<UsageTab>('Web app');
  const usageNow = usage[usageTab];
  const installLines: string[] = install[installTab];

  // a content swaps in with a short fade only once it has changed (not on the first render)
  const [swapped, setSwapped] = useState<Swapped>({ answer: false, install: false, usage: false });
  const swap = (k: keyof Swapped) => setSwapped((s) => (s[k] ? s : { ...s, [k]: true }));

  // the tabs' underline slides to the chosen tab
  const installRow = useRef<HTMLDivElement>(null);
  const usageRow = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ install?: Bar; usage?: Bar }>({});
  useLayoutEffect(() => {
    setBar({ install: measure(installRow.current), usage: measure(usageRow.current) });
  }, [installTab, usageTab]);
  useEffect(() => {
    const measureAll = () => setBar({ install: measure(installRow.current), usage: measure(usageRow.current) });
    addEventListener('resize', measureAll);
    return () => removeEventListener('resize', measureAll);
  }, []);

  // the request typed out, one flag after another
  const [at, setAt] = useState(0);
  const [typed, setTyped] = useState(0);
  useEffect(() => {
    if (still()) { setTyped(answers[0]!.flag.length); return; }
    let i = 0;
    let n = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const step = () => {
      const a = answers[i]!;
      if (n < a.flag.length) { n++; setTyped(n); timer = setTimeout(step, 45); return; }
      timer = setTimeout(() => {
        i = (i + 1) % answers.length;
        n = 0;
        setAt(i);
        setTyped(0);
        setSwapped((s) => (s.answer ? s : { ...s, answer: true }));
        step();
      }, 2600);
    };
    timer = setTimeout(step, 900);
    return () => clearTimeout(timer);
  }, []);
  const answer = answers[at]!;

  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(copiedTimer.current), []);
  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(installLines.join('\n'));
      setCopied(true);
      clearTimeout(copiedTimer.current);
      copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* no clipboard here */ }
  }

  return (
    <div className="cf-landing">
      <aside className="hero">
        <div className="hero-art" aria-hidden="true">
          <div className="mark">
            {rows.map((r, i) => (
              <div key={i} className={`bar b${i}`}>
                <div className="ticker">{[...r, ...r].map((k, j) => <span key={j}>{k}</span>)}</div>
              </div>
            ))}
            <div className="answer">
              <p className="ask"><span className="p">GET</span> /ofrep/v1/evaluate/flags/<b>{answer.flag.slice(0, typed)}</b><i className="caret" /></p>
              <p key={at} className={swapped.answer ? 'got swap' : 'got'}><span className="ctx">{answer.ctx}</span><span className="val">{answer.value}</span><span className="why">{answer.why}</span></p>
            </div>
          </div>
        </div>
        <div className="hero-body">
          <Link className="pill in-1" href="/guide/introduction"><span className="tri">▲</span> Open source <b>| MIT licensed, self-hosted</b> <span>→</span></Link>
          <h1 className="in-2">The most comprehensive feature flag framework</h1>
          <div className="actions in-3">
            <Link className="btn primary" href="/guide/quickstart"><span>Get Started</span></Link>
            <a className="btn ghost" href={repo}>GitHub<i className="corner tl" /><i className="corner br" /></a>
          </div>
        </div>
        <footer className="hero-foot">
          <Link href="/guide/introduction">Docs</Link><span>/</span>
          <a href={`${repo}/blob/main/CHANGELOG.md`}>Changelog</a><span>/</span>
          <a href={`${repo}/blob/main/SECURITY.md`}>Security</a>
        </footer>
      </aside>

      <main className="body">
        <section>
          <h2 className="label"><span>README</span></h2>
          <p className="lead">
            Everything feature flags need in <b>one server</b>: rules and releases, reviewed changes and history, settings
            per any dimension you define, read with <b>OpenFeature</b>, and run on <b>your own servers</b>. Move over from the
            system you have now <b>one flag at a time</b>. Made for code written with AI: ship it <b>behind a flag</b>, to a
            few first, and change models and prompts without a deploy.
          </p>
          <div className="code">
            <div ref={installRow} className="tabs" role="tablist">
              {installTabs.map((t) => (
                <button key={t} type="button" role="tab" aria-selected={installTab === t} className={installTab === t ? 'on' : undefined} onClick={() => { if (t !== installTab) { setInstallTab(t); swap('install'); } }}>{t}</button>
              ))}
              {bar.install && <span className="slide" style={{ transform: `translateX(${bar.install.x}px)`, width: `${bar.install.w}px` }} />}
            </div>
            <div className="cmd">
              <pre key={installTab} className={swapped.install ? 'swap' : undefined}><code>{installLines.map((l, i) => (
                <Fragment key={i}>{(i === 0 || !installLines[i - 1]!.endsWith('\\')) && <span className="prompt">$ </span>}{l}{'\n'}</Fragment>
              ))}</code></pre>
              <button type="button" className={copied ? 'copy done' : 'copy'} aria-label={copied ? 'Copied' : 'Copy'} onClick={copyInstall}>
                <svg viewBox="0 0 16 16" aria-hidden="true">{copied ? <path key="done" d="M3 8.5l3 3 7-7" /> : <path key="copy" d="M5.5 5.5V3h7.5v7.5h-2.5M3 5.5h7.5V13H3z" />}</svg>
                {copied ? 'COPIED' : 'COPY'}
              </button>
            </div>
          </div>
          <div className="marquee" aria-label="OpenFeature reads the flags in">
            <span className="mq-label">Works with OpenFeature</span>
            <div className="mq-window"><div className="mq-track">{[...languages, ...languages].map((l, i) => <span key={i} aria-hidden={i >= languages.length || undefined}>{l}</span>)}</div></div>
          </div>
          <p className="note">Then open the setup link the server prints in its log, and create the admin account. The console walks you through four steps to an app reading its first flag.</p>
        </section>

        <section>
          <h2 className="title"><span>Features</span></h2>
          <div className="grid">
            {features.map((f, i) => (
              <article key={f.title} className="cell">
                <i className="corner tl" /><i className="corner br" />
                <p className="num">{String(i + 1).padStart(2, '0')}</p>
                <h3>{f.title}</h3>
                <p>{f.text}</p>
                <div className="chips">{f.chips.map((c, j) => <span key={c} style={{ '--i': j, '--n': f.chips.length } as CSSProperties}>{c}</span>)}</div>
              </article>
            ))}
          </div>
        </section>

        <section>
          <h2 className="title"><span>Read flags with OpenFeature</span></h2>
          <div className="code split">
            <div className="editor">
              <div ref={usageRow} className="tabs" role="tablist">
                {usageTabs.map((t) => (
                  <button key={t} type="button" role="tab" aria-selected={usageTab === t} className={usageTab === t ? 'on' : undefined} onClick={() => { if (t !== usageTab) { setUsageTab(t); swap('usage'); } }}>{t}</button>
                ))}
                {bar.usage && <span className="slide" style={{ transform: `translateX(${bar.usage.x}px)`, width: `${bar.usage.w}px` }} />}
                <span className="file">{usageNow.file}</span>
              </div>
              <pre key={usageTab} className={swapped.usage ? 'numbered swap' : 'numbered'}><code>{usageNow.lines.map((l, i) => (
                <span key={i} className="line" style={{ '--l': i } as CSSProperties}>{l}{'\n'}</span>
              ))}</code></pre>
            </div>
            <div className="side">
              <Link href="/sdk/openfeature#web-apps" className={usageTab === 'Web app' ? 'on' : undefined}>Apps: OFREP</Link>
              <Link href="/sdk/openfeature#backends" className={usageTab === 'Backend' ? 'on' : undefined}>Backends: OFREP</Link>
              <Link href="/guide/backends" className={usageTab === 'flagd' ? 'on' : undefined}>Backends: flagd</Link>
              <p>No SDK of ours: OpenFeature’s own providers, on the web, Android, iOS and servers. An app reads with its service’s public key; a backend keeps its own key secret.</p>
            </div>
          </div>
        </section>

        <section>
          <h2 className="title"><span>How it works</span></h2>
          <IllusHowItWorks />
          <p className="lead small">
            One evaluator decides every answer, and the console traces it step by step. A device gets values only: never the
            rules or a list of entities.
          </p>
        </section>

        <section>
          <h2 className="title"><span>Run it yourself</span></h2>
          <div className="grid three">
            {runIt.map((r) => (
              <article key={r.label} className="cell">
                <i className="corner tl" /><i className="corner br" />
                <p className="num">{r.label}</p>
                <p>{r.text}</p>
              </article>
            ))}
          </div>
          <div className="links">
            <Link href="/self-hosting/docker">Docker →</Link>
            <Link href="/self-hosting/production">Production checklist →</Link>
            <Link href="/guide/security">Security model →</Link>
          </div>
        </section>

        <section className="cta">
          <h2>From one command to your first flag in minutes.</h2>
          <div className="actions">
            <Link className="btn primary" href="/guide/quickstart"><span>Quickstart</span></Link>
            <Link className="btn ghost" href="/guide/concepts">How it fits together<i className="corner tl" /><i className="corner br" /></Link>
          </div>
        </section>
      </main>
    </div>
  );
}

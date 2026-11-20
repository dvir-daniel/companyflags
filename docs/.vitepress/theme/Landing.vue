<script setup lang="ts">
// The landing page, in the look of the console and of better-auth.com: a fixed hero on the left, README-style
// sections on the right, 1px rules, mono uppercase labels, square corners.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { withBase } from 'vitepress';
import IllusHowItWorks from './IllusHowItWorks.vue';

const repo = 'https://github.com/dvir-daniel/companyflags';

const install: Record<string, string[]> = {
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
};
const installTab = ref('Docker');

const usage: Record<string, { file: string; lines: string[] }> = {
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
};
const usageTab = ref('Web app');
const usageNow = computed(() => usage[usageTab.value]);

// the tabs' underline slides to the chosen tab
const rowEls: Record<'install' | 'usage', HTMLElement | undefined> = { install: undefined, usage: undefined };
const bar = ref<Record<string, { x: number; w: number }>>({});
function measure(row: HTMLElement | undefined, key: string) {
  const on = row?.querySelector<HTMLElement>('button.on');
  if (on) bar.value = { ...bar.value, [key]: { x: on.offsetLeft, w: on.offsetWidth } };
}
const measureAll = () => { measure(rowEls.install, 'install'); measure(rowEls.usage, 'usage'); };
watch([installTab, usageTab], () => nextTick(measureAll));

// The live answer under the mark: what the server answers for one flag and one context, one after another
const answers = [
  { flag: 'new_checkout', ctx: 'acme · ios 6.2', value: 'true', why: 'RULE · 25%' },
  { flag: 'max_upload_mb', ctx: 'globex', value: '500', why: 'OWN SETTING' },
  { flag: 'ai_model', ctx: 'lumen · web', value: '"fast-v2"', why: 'SPLIT · B' },
  { flag: 'dark_mode', ctx: 'bolt · android', value: 'false', why: 'OVERRIDE' },
];
const at = ref(0);
const typed = ref(0);
let timer: ReturnType<typeof setTimeout> | undefined;
function step() {
  const a = answers[at.value];
  if (typed.value < a.flag.length) { typed.value++; timer = setTimeout(step, 45); return; }
  timer = setTimeout(() => { at.value = (at.value + 1) % answers.length; typed.value = 0; step(); }, 2600);
}
const still = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
onMounted(() => {
  measureAll();
  addEventListener('resize', measureAll);
  if (still()) typed.value = answers[0].flag.length; else timer = setTimeout(step, 900);
});
onBeforeUnmount(() => { clearTimeout(timer); removeEventListener('resize', measureAll); });
const answer = computed(() => answers[at.value]);

// the flags that run through the mark's bars, and the languages OpenFeature reads them in
const keys = ['new_checkout', 'max_upload_mb', 'ai_model', 'dark_mode', 'search_v2', 'kill_payments', 'onboarding_steps', 'prompt_config', 'rate_limit', 'beta_banner'];
const rows = [keys, [...keys].reverse(), keys.slice(3).concat(keys.slice(0, 3))];
const languages = ['Web', 'React', 'Angular', 'Node.js', 'Go', 'Java', 'Python', '.NET', 'PHP', 'Ruby', 'Rust', 'Kotlin', 'Swift', 'Android', 'iOS', 'flagd'];

const copied = ref(false);
async function copyInstall() {
  try {
    await navigator.clipboard.writeText(install[installTab.value].join('\n'));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch { /* no clipboard here */ }
}

const features = [
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

const runIt = [
  { label: 'One image', text: 'The server, the console and the app files in one container, with health checks.' },
  { label: 'Postgres', text: 'Your own Postgres 15+, or an embedded one to try it. Migrations run at start.' },
  { label: 'Any scale', text: 'Several instances on one database, and a CDN-cached file per entity for very large fleets.' },
];
</script>

<template>
  <div class="cf-landing">
    <aside class="hero">
      <div class="hero-art" aria-hidden="true">
        <div class="mark">
          <div v-for="(r, i) in rows" :key="i" class="bar" :class="`b${i}`">
            <div class="ticker"><span v-for="(k, j) in [...r, ...r]" :key="j">{{ k }}</span></div>
          </div>
          <div class="answer">
            <p class="ask"><span class="p">GET</span> /ofrep/v1/evaluate/flags/<b>{{ answer.flag.slice(0, typed) }}</b><i class="caret" /></p>
            <Transition name="swap" mode="out-in">
              <p :key="at" class="got"><span class="ctx">{{ answer.ctx }}</span><span class="val">{{ answer.value }}</span><span class="why">{{ answer.why }}</span></p>
            </Transition>
          </div>
        </div>
      </div>
      <div class="hero-body">
        <a class="pill in-1" :href="withBase('/guide/introduction')"><span class="tri">▲</span> Open source <b>| MIT licensed, self-hosted</b> <span>→</span></a>
        <h1 class="in-2">The most comprehensive feature flag framework</h1>
        <div class="actions in-3">
          <a class="btn primary" :href="withBase('/guide/quickstart')"><span>Get Started</span></a>
          <a class="btn ghost" :href="repo">GitHub<i class="corner tl" /><i class="corner br" /></a>
        </div>
      </div>
      <footer class="hero-foot">
        <a :href="withBase('/guide/introduction')">Docs</a><span>/</span>
        <a :href="`${repo}/blob/main/CHANGELOG.md`">Changelog</a><span>/</span>
        <a :href="`${repo}/blob/main/SECURITY.md`">Security</a>
      </footer>
    </aside>

    <main class="body">
      <section>
        <h2 class="label"><span>README</span></h2>
        <p class="lead">
          Everything feature flags need in <b>one server</b>: rules and releases, reviewed changes and history, settings
          per any dimension you define, read with <b>OpenFeature</b>, and run on <b>your own servers</b>. Move over from the
          system you have now <b>one flag at a time</b>. Made for code written with AI: ship it <b>behind a flag</b>, to a
          few first, and change models and prompts without a deploy.
        </p>
        <div class="code">
          <div :ref="(el) => { rowEls.install = el as HTMLElement }" class="tabs" role="tablist">
            <button v-for="t in Object.keys(install)" :key="t" role="tab" :aria-selected="installTab === t" :class="{ on: installTab === t }" @click="installTab = t">{{ t }}</button>
            <span v-if="bar.install" class="slide" :style="{ transform: `translateX(${bar.install.x}px)`, width: `${bar.install.w}px` }" />
          </div>
          <div class="cmd">
            <Transition name="swap" mode="out-in">
              <pre :key="installTab"><code><template v-for="(l, i) in install[installTab]" :key="i"><span v-if="i === 0 || !install[installTab][i - 1].endsWith('\\')" class="prompt">$ </span>{{ l }}
</template></code></pre>
            </Transition>
            <button class="copy" :class="{ done: copied }" :aria-label="copied ? 'Copied' : 'Copy'" @click="copyInstall">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path v-if="!copied" d="M5.5 5.5V3h7.5v7.5h-2.5M3 5.5h7.5V13H3z" /><path v-else d="M3 8.5l3 3 7-7" /></svg>
              {{ copied ? 'COPIED' : 'COPY' }}
            </button>
          </div>
        </div>
        <div class="marquee" aria-label="OpenFeature reads the flags in">
          <span class="mq-label">Works with OpenFeature</span>
          <div class="mq-window"><div class="mq-track"><span v-for="(l, i) in [...languages, ...languages]" :key="i" :aria-hidden="i >= languages.length || undefined">{{ l }}</span></div></div>
        </div>
        <p class="note">Then open the setup link the server prints in its log, and create the admin account. The console walks you through four steps to an app reading its first flag.</p>
      </section>

      <section>
        <h2 v-reveal class="title"><span>Features</span></h2>
        <div class="grid">
          <article v-for="(f, i) in features" :key="f.title" v-reveal="i % 3" class="cell">
            <i class="corner tl" /><i class="corner br" />
            <p class="num">{{ String(i + 1).padStart(2, '0') }}</p>
            <h3>{{ f.title }}</h3>
            <p>{{ f.text }}</p>
            <div class="chips"><span v-for="(c, j) in f.chips" :key="c" :style="{ '--i': j, '--n': f.chips.length }">{{ c }}</span></div>
          </article>
        </div>
      </section>

      <section>
        <h2 v-reveal class="title"><span>Read flags with OpenFeature</span></h2>
        <div v-reveal class="code split">
          <div class="editor">
            <div :ref="(el) => { rowEls.usage = el as HTMLElement }" class="tabs" role="tablist">
              <button v-for="t in Object.keys(usage)" :key="t" role="tab" :aria-selected="usageTab === t" :class="{ on: usageTab === t }" @click="usageTab = t">{{ t }}</button>
              <span v-if="bar.usage" class="slide" :style="{ transform: `translateX(${bar.usage.x}px)`, width: `${bar.usage.w}px` }" />
              <span class="file">{{ usageNow.file }}</span>
            </div>
            <Transition name="swap" mode="out-in">
              <pre :key="usageTab" class="numbered"><code><span v-for="(l, i) in usageNow.lines" :key="i" class="line" :style="{ '--l': i }">{{ l }}
</span></code></pre>
            </Transition>
          </div>
          <div class="side">
            <a :href="withBase('/sdk/openfeature#web-apps')" :class="{ on: usageTab === 'Web app' }">Apps: OFREP</a>
            <a :href="withBase('/sdk/openfeature#backends')" :class="{ on: usageTab === 'Backend' }">Backends: OFREP</a>
            <a :href="withBase('/guide/backends')" :class="{ on: usageTab === 'flagd' }">Backends: flagd</a>
            <p>No SDK of ours: OpenFeature’s own providers, on the web, Android, iOS and servers. An app reads with its service’s public key; a backend keeps its own key secret.</p>
          </div>
        </div>
      </section>

      <section>
        <h2 v-reveal class="title"><span>How it works</span></h2>
        <IllusHowItWorks v-reveal />
        <p class="lead small">
          One evaluator decides every answer, and the console traces it step by step. A device gets values only: never the
          rules or a list of entities.
        </p>
      </section>

      <section>
        <h2 v-reveal class="title"><span>Run it yourself</span></h2>
        <div class="grid three">
          <article v-for="(r, i) in runIt" :key="r.label" v-reveal="i" class="cell">
            <i class="corner tl" /><i class="corner br" />
            <p class="num">{{ r.label }}</p>
            <p>{{ r.text }}</p>
          </article>
        </div>
        <div class="links">
          <a :href="withBase('/self-hosting/docker')">Docker →</a>
          <a :href="withBase('/self-hosting/production')">Production checklist →</a>
          <a :href="withBase('/guide/security')">Security model →</a>
        </div>
      </section>

      <section v-reveal class="cta">
        <h2>From one command to your first flag in minutes.</h2>
        <div class="actions">
          <a class="btn primary" :href="withBase('/guide/quickstart')"><span>Quickstart</span></a>
          <a class="btn ghost" :href="withBase('/guide/concepts')">How it fits together<i class="corner tl" /><i class="corner br" /></a>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.cf-landing {
  display: grid;
  grid-template-columns: minmax(360px, 38%) 1fr;
  min-height: calc(100vh - var(--vp-nav-height));
  background: var(--cf-page);
  color: var(--cf-ink);
}
a { text-decoration: none; color: inherit; }

/* ---- the hero, fixed on the left */
.hero {
  position: sticky;
  top: var(--vp-nav-height);
  height: calc(100vh - var(--vp-nav-height));
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--cf-rule);
  overflow: hidden;
}
.hero-art { position: absolute; inset: 0; }
/* the dotted ground, fading out toward the edges, drifting slowly */
.hero-art::before {
  content: ''; position: absolute; inset: -24px;
  background-image: radial-gradient(var(--cf-grid) 1px, transparent 1px);
  background-size: 12px 12px;
  mask-image: radial-gradient(ellipse 70% 55% at 45% 40%, #000 30%, transparent 75%);
  animation: drift 24s linear infinite;
}
@keyframes drift { to { transform: translate(12px, 12px); } }
.hero-art { animation: art-in 900ms var(--cf-ease) both; }
@keyframes art-in { from { opacity: 0; } }

/* the mark: three stepped bars (the layers, from the defaults down to one entity) that snap in from the left, with
   flag keys running through them, and spread apart when pointed at */
.mark { position: absolute; left: 20%; top: 16%; display: grid; gap: 14px; pointer-events: auto; }
.bar {
  position: relative; height: 46px; overflow: hidden;
  background: linear-gradient(90deg, var(--cf-rule-2), var(--cf-rule)); border: 1px solid var(--cf-rule-2);
  transition: transform 450ms var(--cf-ease);
  animation: snap 700ms var(--cf-ease) both;
}
.b0 { width: 220px; animation-delay: 150ms; }
.b1 { width: 156px; animation-delay: 260ms; }
.b2 { width: 92px; animation-delay: 370ms; }
@keyframes snap { from { opacity: 0; transform: translateX(-28px) rotate(-3deg); } to { opacity: 1; transform: none; } }
.mark:hover .b0 { transform: translateX(-10px); }
.mark:hover .b1 { transform: translateX(8px); }
.mark:hover .b2 { transform: translateX(26px); }
.ticker {
  position: absolute; inset: 0; display: flex; align-items: center; gap: 18px; width: max-content; padding-left: 10px;
  font-family: var(--vp-font-family-mono); font-size: 10px; letter-spacing: 0.4px; color: var(--cf-ink-3); opacity: 0.55;
  animation: tick 38s linear infinite;
}
.b1 .ticker { animation-direction: reverse; animation-duration: 30s; }
.b2 .ticker { animation-duration: 24s; }
.mark:hover .ticker { opacity: 0.9; }
@keyframes tick { to { transform: translateX(-50%); } }

/* the live answer: a request typed out, and the server's answer for it */
.answer {
  width: 340px; margin-top: 18px; padding: 10px 12px; border: 1px solid var(--cf-rule); background: var(--cf-page);
  font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-3);
  box-shadow: 0 18px 40px -24px rgba(0, 0, 0, 0.35); animation: snap 700ms var(--cf-ease) 520ms both;
}
.answer p { margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.answer .p { color: var(--cf-accent); }
.answer b { color: var(--cf-ink); font-weight: 400; }
.caret { display: inline-block; width: 1px; height: 11px; margin-left: 1px; vertical-align: -1px; background: var(--cf-ink-2); animation: blink 1s steps(2) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.got { display: flex; gap: 10px; margin-top: 8px !important; padding-top: 8px; border-top: 1px dashed var(--cf-rule); }
.got .val { color: var(--cf-ink); }
.got .why { margin-left: auto; color: #16a34a; letter-spacing: 0.5px; }
:global(.dark) .got .why { color: #4ade80; }

/* the hero's words rise in, one after the other */
.in-1, .in-2, .in-3 { animation: rise 700ms var(--cf-ease) both; }
.in-1 { animation-delay: 100ms; }
.in-2 { animation-delay: 200ms; }
.in-3 { animation-delay: 300ms; }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }

/* swapping one tab's content for another's */
.swap-enter-active { transition: opacity 220ms var(--cf-ease), transform 260ms var(--cf-ease); }
.swap-leave-active { transition: opacity 100ms ease-in; }
.swap-enter-from { opacity: 0; transform: translateY(4px); }
.swap-leave-to { opacity: 0; }
.hero-body { position: relative; margin-top: auto; padding: 0 32px 24px; }
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 14px; margin-bottom: 18px;
  font-size: 13px; color: var(--cf-ink-2);
  border: 1px solid var(--cf-rule); background: var(--cf-panel); border-radius: 999px;
}
.pill { transition: border-color 200ms, background-color 200ms; }
.pill:hover { border-color: var(--cf-rule-2); }
.pill > span:last-child { display: inline-block; transition: transform 250ms var(--cf-ease); }
.pill:hover > span:last-child { transform: translateX(3px); }
.pill b { color: var(--cf-ink); font-weight: 500; }
.pill .tri { font-size: 10px; color: var(--cf-ink); }
h1 { margin: 0 0 24px; font-size: clamp(30px, 2.7vw, 40px); line-height: 1.15; font-weight: 400; letter-spacing: -0.03em; max-width: 13em; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
.btn { position: relative; display: inline-flex; align-items: center; height: 38px; padding: 0 20px; font-size: 14px; font-weight: 500; }
.btn { transition: background-color 200ms, transform 200ms var(--cf-ease); }
.btn:active { transform: translateY(1px); }
/* the main button: a light sweeps across it when pointed at */
.btn.primary { overflow: hidden; background: var(--cf-ink); color: var(--cf-page); }
.btn.primary span { position: relative; z-index: 1; }
.btn.primary::after {
  content: ''; position: absolute; inset: 0; transform: translateX(-110%);
  background: linear-gradient(100deg, transparent 20%, color-mix(in srgb, var(--cf-page) 28%, transparent) 50%, transparent 80%);
}
.btn.primary:hover::after { transform: translateX(110%); transition: transform 700ms var(--cf-ease); }
.btn.ghost { border: 1px solid var(--cf-rule-2); color: var(--cf-ink); }
.btn.ghost:hover { background: var(--cf-wash); }
/* the corner marks step out when pointed at */
.corner { position: absolute; width: 7px; height: 7px; border-color: var(--cf-ink-3); border-style: solid; transition: transform 250ms var(--cf-ease), border-color 200ms; }
.btn.ghost:hover .corner.tl, .cell:hover .corner.tl { transform: translate(-2px, -2px); border-color: var(--cf-ink); }
.btn.ghost:hover .corner.br, .cell:hover .corner.br { transform: translate(2px, 2px); border-color: var(--cf-ink); }
.corner.tl { top: -4px; left: -4px; border-width: 1px 0 0 1px; }
.corner.br { bottom: -4px; right: -4px; border-width: 0 1px 1px 0; }
.hero-foot {
  position: relative; display: flex; gap: 10px; padding: 18px 32px; margin-top: 48px;
  font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-3);
}
.hero-foot a { transition: color 150ms; }
.hero-foot a:hover { color: var(--cf-ink); }
.hero-foot { animation: rise 700ms var(--cf-ease) 400ms both; }

/* ---- the README side */
.body { min-width: 0; }
section { padding: 40px 40px 8px; max-width: 980px; }
.label, .title {
  display: flex; align-items: center; gap: 16px; margin: 0 0 22px; border: 0; padding: 0;
}
.label::after, .title::after { content: ''; flex: 1; height: 1px; background: var(--cf-rule); transform-origin: left; }
/* a section's rule draws itself as the section rises in */
.title:global(.cf-reveal)::after { transform: scaleX(0); }
.title:global(.cf-reveal.cf-in)::after { transform: scaleX(1); transition: transform 900ms var(--cf-ease) 150ms; }
.label span { font-family: var(--vp-font-family-mono); font-size: 14px; font-weight: 400; letter-spacing: 0.4px; }
.title span { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
.lead { margin: 0 0 22px; font-size: 16px; line-height: 1.75; color: var(--cf-ink-2); max-width: 46em; }
.lead b { color: var(--cf-ink); font-weight: 500; }
.lead.small { font-size: 15px; margin-top: 18px; }
.note { font-size: 13px; color: var(--cf-ink-3); margin: 12px 0 0; }
.note code, .lead code { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-2); }

.code { border: 1px solid var(--cf-rule); background: var(--cf-panel); }
.tabs { position: relative; display: flex; align-items: stretch; gap: 0; border-bottom: 1px solid var(--cf-rule); padding: 0 8px; }
.tabs button { padding: 11px 14px; font-size: 13px; color: var(--cf-ink-3); background: none; border: 0; cursor: pointer; transition: color 150ms; }
.tabs button:hover { color: var(--cf-ink); }
.tabs button.on { color: var(--cf-ink); }
/* the chosen tab's line slides from one tab to the next */
.tabs .slide { position: absolute; left: 0; bottom: -1px; height: 2px; background: var(--cf-ink-nav); transition: transform 320ms var(--cf-ease), width 320ms var(--cf-ease); }
.tabs .file { margin-left: auto; align-self: center; padding-right: 8px; font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-3); }
.cmd { position: relative; }
pre { margin: 0; padding: 18px 20px; overflow-x: auto; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.7; color: var(--cf-ink); }
pre code { font-family: inherit; }
.prompt { color: var(--cf-accent); user-select: none; }
.copy {
  position: absolute; right: 12px; top: 12px; display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px;
  font-family: var(--vp-font-family-mono); font-size: 11px; letter-spacing: 0.6px; color: var(--cf-ink-3);
  background: var(--cf-page); border: 1px solid var(--cf-rule); cursor: pointer;
  transition: color 150ms, border-color 150ms, transform 200ms var(--cf-ease);
}
.copy svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
.copy:hover { color: var(--cf-ink); border-color: var(--cf-rule-2); }
.copy:active { transform: scale(0.96); }
.copy.done { color: #16a34a; border-color: color-mix(in srgb, #16a34a 40%, transparent); }
.copy.done svg { animation: pop 300ms var(--cf-ease); }
@keyframes pop { from { transform: scale(0.4); opacity: 0; } }

/* the languages OpenFeature reads flags in, running past, slower when pointed at */
.marquee { display: flex; align-items: center; gap: 16px; margin-top: 18px; padding: 10px 0; border-top: 1px solid var(--cf-rule); border-bottom: 1px solid var(--cf-rule); }
.mq-label { flex: none; font-family: var(--vp-font-family-mono); font-size: 11px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--cf-ink-3); }
.mq-window { flex: 1; min-width: 0; overflow: hidden; mask-image: linear-gradient(90deg, transparent, #000 10%, #000 90%, transparent); }
.mq-track { display: flex; gap: 34px; width: max-content; animation: tick 40s linear infinite; }
.mq-track span { font-size: 14px; font-weight: 500; color: var(--cf-ink-2); white-space: nowrap; transition: color 150ms; }
.mq-track span:hover { color: var(--cf-ink); }
.marquee:hover .mq-track { animation-play-state: paused; }

.grid { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--cf-rule); border-left: 1px solid var(--cf-rule); }
.grid.three { grid-template-columns: repeat(3, 1fr); }
.cell { position: relative; padding: 20px 20px 22px; border-right: 1px solid var(--cf-rule); border-bottom: 1px solid var(--cf-rule); min-width: 0; transition: background-color 250ms; }
.cell:hover { background: var(--cf-wash); }
.cell .corner { opacity: 0; }
.cell:hover .corner { opacity: 1; }
.cell .corner.tl { top: -1px; left: -1px; }
.cell .corner.br { bottom: -1px; right: -1px; }
.num { transition: color 200ms, letter-spacing 300ms var(--cf-ease); }
.cell:hover .num { color: var(--cf-ink); letter-spacing: 1.2px; }
.num { margin: 0 0 10px; font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-3); letter-spacing: 0.4px; }
.cell h3 { margin: 0 0 8px; font-size: 15px; font-weight: 500; }
.cell p:not(.num) { margin: 0; font-size: 14px; line-height: 1.6; color: var(--cf-ink-2); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.chips span { padding: 2px 7px; font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-2); border: 1px solid var(--cf-rule); background: var(--cf-page); transition: transform 250ms var(--cf-ease), border-color 200ms, color 200ms; }
/* pointed at, a card's chips light up one after the other, the way a release steps */
.cell:hover .chips span { animation: chip 0.6s var(--cf-ease) calc(var(--i) * 90ms) both; }
@keyframes chip { 40% { transform: translateY(-3px); border-color: var(--cf-ink-3); color: var(--cf-ink); } 100% { transform: none; border-color: var(--cf-rule-2); color: var(--cf-ink); } }

.split { display: grid; grid-template-columns: 1fr 230px; }
.editor { min-width: 0; border-right: 1px solid var(--cf-rule); }
.numbered { counter-reset: line; }
.numbered .line { counter-increment: line; }
.numbered .line::before { content: counter(line); display: inline-block; width: 2.2em; margin-right: 14px; text-align: right; color: var(--cf-ink-3); opacity: 0.6; user-select: none; }
.side { display: flex; flex-direction: column; }
.side a {
  padding: 13px 16px; border-bottom: 1px solid var(--cf-rule); font-family: var(--vp-font-family-mono); font-size: 11px;
  letter-spacing: 0.6px; text-transform: uppercase; color: var(--cf-ink-3);
}
.side a { position: relative; transition: color 150ms, background-color 200ms, padding-left 250ms var(--cf-ease); }
.side a.on, .side a:hover { color: var(--cf-ink); background: var(--cf-wash); }
.side a.on { padding-left: 22px; box-shadow: inset 2px 0 0 var(--cf-ink); }
/* a new example's lines come in from the top down */
.numbered .line { display: inline-block; animation: line-in 380ms var(--cf-ease) calc(var(--l) * 22ms) both; }
@keyframes line-in { from { opacity: 0; transform: translateX(-4px); } }
.side p { margin: auto 0 0; padding: 16px; font-size: 13px; line-height: 1.6; color: var(--cf-ink-2); }

.diagram { border: 1px solid var(--cf-rule); background: var(--cf-panel); font-size: 12.5px; color: var(--cf-ink-2); }
.links { display: flex; flex-wrap: wrap; gap: 24px; margin: 18px 0 0; font-family: var(--vp-font-family-mono); font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase; }
.links a { color: var(--cf-ink-2); transition: color 150ms, letter-spacing 300ms var(--cf-ease); }
.links a:hover { color: var(--cf-ink); letter-spacing: 1px; }
.cta { padding-top: 56px; padding-bottom: 72px; }
.cta h2 { margin: 0 0 22px; font-size: 26px; font-weight: 400; letter-spacing: -0.02em; border: 0; padding: 0; }

@media (max-width: 1100px) {
  .grid { grid-template-columns: repeat(2, 1fr); }
  .split { grid-template-columns: 1fr; }
  .editor { border-right: 0; border-bottom: 1px solid var(--cf-rule); }
}
@media (max-width: 960px) {
  .cf-landing { grid-template-columns: 1fr; }
  .hero { position: relative; top: 0; height: auto; border-right: 0; border-bottom: 1px solid var(--cf-rule); }
  /* the mark and the live answer sit above the words, in the flow, so they never cover them */
  .hero-art { position: relative; inset: auto; padding: 32px 16px 28px; }
  .mark { position: relative; left: auto; top: auto; gap: 10px; }
  .hero-body { margin-top: 0; padding: 0 16px 20px; }
  .hero-foot { padding: 14px 16px; margin-top: 24px; }
  .bar { height: 32px; }
  section { padding: 32px 16px 4px; }
}
@media (max-width: 640px) {
  .grid, .grid.three { grid-template-columns: 1fr; }
  .b0 { width: 160px; }
  .b1 { width: 112px; }
  .b2 { width: 66px; }
  .answer { width: 100%; max-width: 340px; }
}

@media (prefers-reduced-motion: reduce) {
  .ticker, .mq-track, .caret, .hero-art::before { animation: none; }
}
</style>

<script setup lang="ts">
// The landing page, in the look of the console and of better-auth.com: a fixed hero on the left, README-style
// sections on the right, 1px rules, mono uppercase labels, square corners.
import { computed, ref } from 'vue';
import { withBase } from 'vitepress';

const repo = 'https://github.com/dvir-daniel/companyfeatures';

const install: Record<string, string[]> = {
  Docker: [
    'docker run --rm -p 8787:8787 \\',
    '  -e BETTER_AUTH_SECRET="$(openssl rand -base64 32)" \\',
    '  -e BETTER_AUTH_URL=http://localhost:8787 \\',
    '  -e FF_DEMO=1 ghcr.io/dvir-daniel/companyfeatures',
  ],
  Compose: [
    'curl -O https://raw.githubusercontent.com/dvir-daniel/companyfeatures/main/docker-compose.yml',
    'echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" > .env',
    'docker compose up -d',
  ],
  Source: [
    'git clone https://github.com/dvir-daniel/companyfeatures.git',
    'cd companyfeatures && corepack enable && pnpm install',
    'pnpm demo',
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
      "  headers: [['Authorization', `Bearer ${session.flagsToken}`]],",
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

const copied = ref(false);
async function copyInstall() {
  try {
    await navigator.clipboard.writeText(install[installTab.value].join('\n'));
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch { /* no clipboard here */ }
}

const features = [
  { title: 'Your own dimensions.', text: 'Serve config per customer, per company and its brands, per region › chain › store. Up to four levels, in your words.', chips: ['customer', 'company › brand', 'region › store'] },
  { title: 'Settings per entity.', text: 'Any customer, brand or store can have settings of its own, inherited down the chain, under rules for everyone.', chips: ['inherit', 'own settings'] },
  { title: 'Locked rules.', text: 'Overrides apply to everyone, always, and fail closed when a value is missing. No entity can change them.', chips: ['override', 'fail closed'] },
  { title: 'OpenFeature, no SDK of ours.', text: 'OFREP for OpenFeature’s web, Android, iOS and server providers; flagd JSON for in-process backends.', chips: ['OFREP', 'flagd', 'React'] },
  { title: 'Releases.', text: 'Early access for some customers, then 1% → 5% → 25% → 50% of devices, then everyone, then clean up.', chips: ['1%', '5%', '25%', '50%'] },
  { title: 'Version releases.', text: 'Move devices from 1.0.0 to 1.0.1 step by step. On call rolls back without waiting for a review.', chips: ['1.0.0', '→', '1.0.1'] },
  { title: 'Reviewed changes.', text: 'Production can require an approval for every change, with scheduling and break-glass for on call.', chips: ['approve', 'schedule', 'break-glass'] },
  { title: 'History and restore.', text: 'An append-only history, versions of every environment, restore, and two entities compared flag by flag.', chips: ['history', 'restore', 'compare'] },
  { title: 'Your sign-in.', text: 'Email and password, Google, GitHub, Microsoft, and single sign-on with SAML or OIDC, through Better Auth.', chips: ['SAML', 'OIDC', 'invites'] },
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
        <div class="bars"><span /><span /><span /></div>
      </div>
      <div class="hero-body">
        <a class="pill" :href="withBase('/guide/introduction')"><span class="tri">▲</span> Open source <b>| MIT licensed, self-hosted</b> <span>→</span></a>
        <h1>Feature flags for products made of customers</h1>
        <div class="actions">
          <a class="btn primary" :href="withBase('/guide/quickstart')">Get Started</a>
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
          Config that follows <b>your business</b>: served per customer, brand, store or any dimension you define,
          read with <b>OpenFeature</b>, and run on <b>your own servers</b>, one Node.js server and Postgres.
        </p>
        <div class="code">
          <div class="tabs" role="tablist">
            <button v-for="t in Object.keys(install)" :key="t" role="tab" :aria-selected="installTab === t" :class="{ on: installTab === t }" @click="installTab = t">{{ t }}</button>
          </div>
          <div class="cmd">
            <pre><code><template v-for="(l, i) in install[installTab]" :key="i"><span v-if="i === 0 || !install[installTab][i - 1].endsWith('\\')" class="prompt">$ </span>{{ l }}
</template></code></pre>
            <button class="copy" :aria-label="copied ? 'Copied' : 'Copy'" @click="copyInstall">{{ copied ? 'COPIED' : 'COPY' }}</button>
          </div>
        </div>
        <p class="note">Then open <code>http://localhost:8787</code> and create the admin account. <code>FF_DEMO=1</code> adds sample data.</p>
      </section>

      <section>
        <h2 class="title"><span>Features</span></h2>
        <div class="grid">
          <article v-for="(f, i) in features" :key="f.title" class="cell">
            <p class="num">{{ String(i + 1).padStart(2, '0') }}</p>
            <h3>{{ f.title }}</h3>
            <p>{{ f.text }}</p>
            <div class="chips"><span v-for="c in f.chips" :key="c">{{ c }}</span></div>
          </article>
        </div>
      </section>

      <section>
        <h2 class="title"><span>Read flags with OpenFeature</span></h2>
        <div class="code split">
          <div class="editor">
            <div class="tabs" role="tablist">
              <button v-for="t in Object.keys(usage)" :key="t" role="tab" :aria-selected="usageTab === t" :class="{ on: usageTab === t }" @click="usageTab = t">{{ t }}</button>
              <span class="file">{{ usageNow.file }}</span>
            </div>
            <pre class="numbered"><code><span v-for="(l, i) in usageNow.lines" :key="i" class="line">{{ l }}
</span></code></pre>
          </div>
          <div class="side">
            <a :href="withBase('/sdk/openfeature#web-apps')" :class="{ on: usageTab === 'Web app' }">Apps: OFREP</a>
            <a :href="withBase('/sdk/openfeature#backends')" :class="{ on: usageTab === 'Backend' }">Backends: OFREP</a>
            <a :href="withBase('/guide/backends')" :class="{ on: usageTab === 'flagd' }">Backends: flagd</a>
            <p>No SDK of ours: OpenFeature’s own providers, on the web, Android, iOS and servers. Each app asks as its own entity, with a token it can’t change.</p>
          </div>
        </div>
      </section>

      <section>
        <h2 class="title"><span>How it works</span></h2>
        <pre class="diagram"><code>console ──► server (rules, approvals, history) ──► Postgres
              │
              ├── OFREP ──────────────► apps (web, iOS, Android)
              ├── OFREP / flagd JSON ─► backends
              └── app files ──► your CDN ──► very large fleets</code></pre>
        <p class="lead small">
          One evaluator decides every answer, and the console traces it step by step. A device gets its own answers only:
          never the rules, a list of customers, or another customer’s values.
        </p>
      </section>

      <section>
        <h2 class="title"><span>Run it yourself</span></h2>
        <div class="grid three">
          <article v-for="r in runIt" :key="r.label" class="cell">
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

      <section class="cta">
        <h2>Start with the sample data, in one command.</h2>
        <div class="actions">
          <a class="btn primary" :href="withBase('/guide/quickstart')">Quickstart</a>
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
.hero-art {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(var(--cf-grid) 1px, transparent 1px);
  background-size: 12px 12px;
  mask-image: radial-gradient(ellipse 70% 55% at 45% 40%, #000 30%, transparent 75%);
}
.bars { position: absolute; left: 22%; top: 18%; display: grid; gap: 14px; opacity: 0.9; }
.bars span { display: block; height: 46px; background: linear-gradient(90deg, var(--cf-rule-2), var(--cf-rule)); border: 1px solid var(--cf-rule-2); }
.bars span:nth-child(1) { width: 220px; }
.bars span:nth-child(2) { width: 156px; }
.bars span:nth-child(3) { width: 92px; }
.hero-body { position: relative; margin-top: auto; padding: 0 32px 24px; }
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 5px 14px; margin-bottom: 18px;
  font-size: 13px; color: var(--cf-ink-2);
  border: 1px solid var(--cf-rule); background: var(--cf-panel); border-radius: 999px;
}
.pill b { color: var(--cf-ink); font-weight: 500; }
.pill .tri { font-size: 10px; color: var(--cf-ink); }
h1 { margin: 0 0 24px; font-size: clamp(30px, 2.7vw, 40px); line-height: 1.15; font-weight: 400; letter-spacing: -0.03em; max-width: 13em; }
.actions { display: flex; gap: 12px; flex-wrap: wrap; }
.btn { position: relative; display: inline-flex; align-items: center; height: 38px; padding: 0 20px; font-size: 14px; font-weight: 500; }
.btn.primary { background: var(--cf-ink); color: var(--cf-page); }
.btn.primary:hover { opacity: 0.88; }
.btn.ghost { border: 1px solid var(--cf-rule-2); color: var(--cf-ink); }
.btn.ghost:hover { background: var(--cf-wash); }
.corner { position: absolute; width: 7px; height: 7px; border-color: var(--cf-ink-3); border-style: solid; }
.corner.tl { top: -4px; left: -4px; border-width: 1px 0 0 1px; }
.corner.br { bottom: -4px; right: -4px; border-width: 0 1px 1px 0; }
.hero-foot {
  position: relative; display: flex; gap: 10px; padding: 18px 32px; margin-top: 48px;
  font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-3);
}
.hero-foot a:hover { color: var(--cf-ink); }

/* ---- the README side */
.body { min-width: 0; }
section { padding: 40px 40px 8px; max-width: 980px; }
.label, .title {
  display: flex; align-items: center; gap: 16px; margin: 0 0 22px; border: 0; padding: 0;
}
.label::after, .title::after { content: ''; flex: 1; height: 1px; background: var(--cf-rule); }
.label span { font-family: var(--vp-font-family-mono); font-size: 14px; font-weight: 400; letter-spacing: 0.4px; }
.title span { font-size: 22px; font-weight: 500; letter-spacing: -0.01em; }
.lead { margin: 0 0 22px; font-size: 16px; line-height: 1.75; color: var(--cf-ink-2); max-width: 46em; }
.lead b { color: var(--cf-ink); font-weight: 500; }
.lead.small { font-size: 15px; margin-top: 18px; }
.note { font-size: 13px; color: var(--cf-ink-3); margin: 12px 0 0; }
.note code, .lead code { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-2); }

.code { border: 1px solid var(--cf-rule); background: var(--cf-panel); }
.tabs { display: flex; align-items: stretch; gap: 0; border-bottom: 1px solid var(--cf-rule); padding: 0 8px; }
.tabs button {
  padding: 11px 14px; font-size: 13px; color: var(--cf-ink-3); background: none; border: 0; cursor: pointer;
  box-shadow: inset 0 -2px 0 transparent;
}
.tabs button:hover { color: var(--cf-ink); }
.tabs button.on { color: var(--cf-ink); box-shadow: inset 0 -2px 0 var(--cf-ink-nav); }
.tabs .file { margin-left: auto; align-self: center; padding-right: 8px; font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-3); }
.cmd { position: relative; }
pre { margin: 0; padding: 18px 20px; overflow-x: auto; font-family: var(--vp-font-family-mono); font-size: 13px; line-height: 1.7; color: var(--cf-ink); }
pre code { font-family: inherit; }
.prompt { color: var(--cf-accent); user-select: none; }
.copy {
  position: absolute; right: 12px; top: 12px; padding: 4px 8px; font-family: var(--vp-font-family-mono); font-size: 11px;
  letter-spacing: 0.6px; color: var(--cf-ink-3); background: var(--cf-page); border: 1px solid var(--cf-rule); cursor: pointer;
}
.copy:hover { color: var(--cf-ink); }

.grid { display: grid; grid-template-columns: repeat(3, 1fr); border-top: 1px solid var(--cf-rule); border-left: 1px solid var(--cf-rule); }
.grid.three { grid-template-columns: repeat(3, 1fr); }
.cell { padding: 20px 20px 22px; border-right: 1px solid var(--cf-rule); border-bottom: 1px solid var(--cf-rule); min-width: 0; }
.cell:hover { background: var(--cf-wash); }
.num { margin: 0 0 10px; font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-3); letter-spacing: 0.4px; }
.cell h3 { margin: 0 0 8px; font-size: 15px; font-weight: 500; }
.cell p:not(.num) { margin: 0; font-size: 14px; line-height: 1.6; color: var(--cf-ink-2); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 14px; }
.chips span { padding: 2px 7px; font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-2); border: 1px solid var(--cf-rule); background: var(--cf-page); }

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
.side a.on, .side a:hover { color: var(--cf-ink); background: var(--cf-wash); }
.side p { margin: auto 0 0; padding: 16px; font-size: 13px; line-height: 1.6; color: var(--cf-ink-2); }

.diagram { border: 1px solid var(--cf-rule); background: var(--cf-panel); font-size: 12.5px; color: var(--cf-ink-2); }
.links { display: flex; flex-wrap: wrap; gap: 24px; margin: 18px 0 0; font-family: var(--vp-font-family-mono); font-size: 12px; letter-spacing: 0.4px; text-transform: uppercase; }
.links a { color: var(--cf-ink-2); }
.links a:hover { color: var(--cf-ink); }
.cta { padding-top: 56px; padding-bottom: 72px; }
.cta h2 { margin: 0 0 22px; font-size: 26px; font-weight: 400; letter-spacing: -0.02em; border: 0; padding: 0; }

@media (max-width: 1100px) {
  .grid { grid-template-columns: repeat(2, 1fr); }
  .split { grid-template-columns: 1fr; }
  .editor { border-right: 0; border-bottom: 1px solid var(--cf-rule); }
}
@media (max-width: 960px) {
  .cf-landing { grid-template-columns: 1fr; }
  .hero { position: relative; top: 0; height: auto; min-height: 460px; border-right: 0; border-bottom: 1px solid var(--cf-rule); }
  .hero-body { padding: 0 16px 20px; }
  .hero-foot { padding: 14px 16px; margin-top: 24px; }
  .bars { left: 12%; top: 8%; gap: 10px; }
  .bars span { height: 32px; }
  section { padding: 32px 16px 4px; }
}
@media (max-width: 640px) {
  .grid, .grid.three { grid-template-columns: 1fr; }
  .bars span:nth-child(1) { width: 160px; }
  .bars span:nth-child(2) { width: 112px; }
  .bars span:nth-child(3) { width: 66px; }
}
</style>

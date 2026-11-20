<script setup lang="ts">
// The architecture, drawn the way better-auth.com draws: a small core, plugins around it, one config file that the
// server and the CLI read (server/plugin.ts, server/config.ts, server/cli.ts).
import { ICONS } from './icons.ts';
const core: { icon: string; label: string }[] = [
  { icon: 'console', label: 'console + api' },
  { icon: 'lock', label: 'sign-in' },
  { icon: 'check', label: 'approvals' },
  { icon: 'flag', label: 'evaluator' },
  { icon: 'database', label: 'journal' },
  { icon: 'bolt', label: 'publish' },
];
const plugins: { call: string; icon: string; where: string; who: string }[] = [
  { call: 'ofrep()', icon: 'devices', where: '/ofrep/v1', who: 'apps · backends' },
  { call: 'flagd()', icon: 'server', where: '/sdk/v1/flagd', who: 'backends' },
  { call: 'appFiles()', icon: 'phone', where: '/client/v1', who: 'apps · CDN' },
  { call: 'cloudflare()', icon: 'cloud', where: 'after a publish', who: 'purge' },
];
</script>

<template>
  <div class="cf-ill arch">
    <div class="head dots">
      <p class="label">companyflags.config.ts</p>
      <code class="term"><span class="p">export default</span> defineConfig({ database, auth, plugins: [<span class="dim">ofrep(), flagd(), appFiles(), cloudflare()</span>] })</code>
    </div>
    <div class="core">
      <p class="label">Core</p>
      <div class="row">
        <template v-for="(c, i) in core" :key="c.label">
          <span v-if="i" class="link" />
          <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS[c.icon]" /></span><span class="label">{{ c.label }}</span></div>
        </template>
      </div>
    </div>
    <div class="plugins">
      <div v-for="p in plugins" :key="p.call" class="plugin">
        <span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS[p.icon]" /></span>
        <code class="call">{{ p.call }}</code>
        <span class="where">{{ p.where }}</span>
        <span class="chip"><span class="dot" />{{ p.who }}</span>
      </div>
      <div class="plugin own">
        <span class="tile dashed">+</span>
        <code class="call">definePlugin()</code>
        <span class="where">routes · console · onPublish</span>
        <span class="chip dashed">your own</span>
      </div>
    </div>
    <div class="foot">
      <code class="term"><span class="p">$</span> companyflags flags push <span class="dim">→</span> ✓ create dark_mode <span class="dim">·</span> → request #12 in prod <span class="ok">✓</span></code>
    </div>
  </div>
</template>

<style scoped>
.arch { border: 1px solid var(--cf-rule); container-type: inline-size; }
.head, .core, .foot { display: grid; gap: 12px; padding: 16px 20px; }
.head, .core { border-bottom: 1px solid var(--cf-rule); }
.plugins { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); border-bottom: 1px solid var(--cf-rule); }
.plugin { display: grid; justify-items: start; align-content: start; gap: 8px; padding: 16px 20px; border-right: 1px solid var(--cf-rule); min-width: 0; }
.plugin:last-child { border-right: 0; }
.call { font-family: var(--vp-font-family-mono); font-size: 13px; color: var(--cf-ink); background: none; padding: 0; }
.where { font-family: var(--vp-font-family-mono); font-size: 11px; color: var(--cf-ink-3); overflow-wrap: anywhere; }
.own .call { color: var(--cf-ink-2); }
@container (max-width: 760px) {
  .plugins { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .plugin { border-bottom: 1px solid var(--cf-rule); }
  .plugin:nth-child(2n) { border-right: 0; }
  .plugin:last-child { grid-column: 1 / -1; border-bottom: 0; }
}
</style>

<script setup lang="ts">
// Dimensions and entities: the levels an installation names, and entities that follow their parent's settings until
// they have their own.
import { ICONS } from './icons.ts';
const tree: { parent: string; own?: boolean; children: { key: string; own?: boolean }[] }[] = [
  { parent: 'acme', own: true, children: [{ key: 'acme-kids' }] },
  { parent: 'globex', own: true, children: [{ key: 'lumen', own: true }, { key: 'bolt' }] },
];
</script>

<template>
  <div class="cf-ill chain">
    <div class="head dots">
      <p class="label">Settings → Dimensions</p>
      <div class="row gap"><span class="chip">company</span><span class="sep">›</span><span class="chip">brand</span><span class="chip dashed">+ up to 4 levels</span></div>
    </div>
    <div class="trees">
      <div v-for="t in tree" :key="t.parent" class="tree">
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.users" /></span><span class="label">{{ t.parent }}</span></div>
        <div class="kids">
          <div v-for="c in t.children" :key="c.key" class="row">
            <span class="link" />
            <div class="node"><span :class="['tile', c.own && 'on']"><svg viewBox="0 0 16 16" v-html="ICONS.users" /></span><span class="label">{{ c.key }}</span></div>
            <span v-if="c.own" class="chip ok kid-chip"><span class="dot" />own settings</span>
            <span v-else class="chip kid-chip">follows {{ t.parent }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chain { border: 1px solid var(--cf-rule); }
.head { display: grid; gap: 10px; padding: 16px 20px; border-bottom: 1px solid var(--cf-rule); }
.gap { gap: 8px; }
.sep { color: var(--cf-ink-3); }
.trees { display: grid; grid-template-columns: 1fr 1fr; }
.tree { display: flex; align-items: flex-start; gap: 0; padding: 20px; min-width: 0; }
.tree + .tree { border-left: 1px solid var(--cf-rule); }
.kids { display: grid; gap: 12px; padding-top: 0; }
.kids .row { align-items: flex-start; flex-wrap: nowrap; }
.kids .link { margin-top: 18px; }
.kid-chip { margin: 7px 0 0 10px; }
@media (max-width: 760px) {
  .trees { grid-template-columns: 1fr; }
  .tree + .tree { border-left: 0; border-top: 1px solid var(--cf-rule); }
}
</style>

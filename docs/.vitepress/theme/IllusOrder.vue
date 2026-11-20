<script setup lang="ts">
// The order one flag is decided in, for one entity, in one environment (server/evaluator.ts entityChain and
// evaluate). The first step that answers wins.
const steps: { label: string; title: string; text: string; chip: string; tone?: 'ok' | 'warn' | 'bad' }[] = [
  { label: 'in set?', title: 'Not in this flag set', text: 'The flag doesn’t exist for it.', chip: 'code default', tone: 'bad' },
  { label: 'on?', title: 'The flag is off', text: 'Nothing is sent.', chip: 'code default', tone: 'bad' },
  { label: 'locked', title: 'Overrides', text: 'For everyone. A missing value counts as a match.', chip: 'value or %', tone: 'warn' },
  { label: 'own', title: 'The entity’s own rules', text: '“Own settings only” stops here, with its own default.', chip: 'value or %', tone: 'ok' },
  { label: 'above', title: 'Its parent’s rules, and up', text: 'Each level until one has “Own settings only”.', chip: 'value or %', tone: 'ok' },
  { label: 'everyone', title: 'Rules for everyone', text: 'Skipped below an entity with “Own settings only”.', chip: 'value or %' },
  { label: 'default', title: 'The default', text: 'The nearest own default, else everyone’s.', chip: 'value' },
];
</script>

<template>
  <div class="cf-ill order">
    <div v-for="(s, i) in steps" :key="s.title" class="step">
      <span class="num">{{ String(i + 1).padStart(2, '0') }}</span>
      <span class="what"><b>{{ s.title }}</b><span class="text">{{ s.text }}</span></span>
      <span :class="['chip', s.tone]"><span class="dot" />{{ s.chip }}</span>
    </div>
    <p class="foot label">The first step that answers wins · a % with no device ID, or outside every range, passes to the next</p>
  </div>
</template>

<style scoped>
.order { border: 1px solid var(--cf-rule); }
.step { display: grid; grid-template-columns: 32px 1fr auto; align-items: center; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--cf-rule); }
.num { font-family: var(--vp-font-family-mono); font-size: 12px; color: var(--cf-ink-3); }
.what { display: grid; gap: 2px; min-width: 0; }
.what b { font-size: 14px; font-weight: 500; color: var(--cf-ink); }
.what .text { font-size: 13px; color: var(--cf-ink-2); }
.foot { padding: 12px 16px; font-size: 10px; line-height: 1.6; }
@media (max-width: 640px) { .step { grid-template-columns: 28px 1fr; } .step .chip { grid-column: 2; justify-self: start; } }
</style>

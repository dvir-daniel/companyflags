<script setup lang="ts">
// How CompanyFeatures works, in three steps and the path of one change, drawn the way better-auth.com draws its
// features: icon tiles joined by thin lines, status chips, a one-line terminal, mono labels.
import { ICONS } from './icons.ts';
</script>

<template>
  <div class="cf-ill hiw">
    <div class="steps">
      <article class="step">
        <div class="words">
          <p class="label">01 · Describe</p>
          <h3>Your dimensions.</h3>
          <p class="text">Say what config is served per: regions and their stores, teams, customers. Up to four levels.</p>
        </div>
        <div class="art">
          <div class="row">
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.globe" /></span><span class="label">us-west</span></div>
            <span class="link" />
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.store" /></span><span class="label">sf-01</span></div>
            <span class="link" />
            <div class="node"><span class="tile"><svg viewBox="0 0 16 16" v-html="ICONS.store" /></span><span class="label">sf-02</span></div>
            <span class="link" />
            <div class="node"><span class="tile dashed">+</span><span class="label">&nbsp;</span></div>
          </div>
          <div class="row gap"><span class="chip">region › store</span><span class="chip ok"><span class="dot" />own settings</span></div>
        </div>
      </article>

      <article class="step">
        <div class="words">
          <p class="label">02 · Decide</p>
          <h3>Rules, then defaults.</h3>
          <p class="text">Locked rules for everyone first, then each entity’s own settings, then the rules for everyone.</p>
        </div>
        <div class="art">
          <div class="rules">
            <div class="rule-row"><span class="chip bad"><span class="dot" />override</span><span class="t">app below 6.0</span><b>off</b></div>
            <div class="rule-row"><span class="chip ok"><span class="dot" />sf-01</span><span class="t">its own setting</span><b>on</b></div>
            <div class="rule-row"><span class="chip warn"><span class="dot" />10%</span><span class="t">of devices</span><b>on</b></div>
            <div class="rule-row"><span class="chip"><span class="dot" />default</span><span class="t">everyone else</span><b>off</b></div>
          </div>
        </div>
      </article>

      <article class="step">
        <div class="words">
          <p class="label">03 · Read</p>
          <h3>With OpenFeature.</h3>
          <p class="text">Apps and backends use OpenFeature’s own providers. No SDK of ours, no rules on devices.</p>
        </div>
        <div class="art">
          <div class="row">
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.browser" /></span><span class="label">web</span></div>
            <span class="link" />
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.phone" /></span><span class="label">ios</span></div>
            <span class="link" />
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.tablet" /></span><span class="label">android</span></div>
            <span class="link" />
            <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.server" /></span><span class="label">api</span></div>
          </div>
          <code class="term"><span class="p">$</span> getBooleanValue(<span class="dim">'new_checkout'</span>) <span class="dim">→</span> true <span class="ok">✓</span></code>
        </div>
      </article>
    </div>

    <div class="path dots">
      <p class="label">The path of a change</p>
      <div class="row flow">
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.console" /></span><span class="label">draft</span></div>
        <span class="link long" />
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.check" /></span><span class="label">approved</span></div>
        <span class="link long" />
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.database" /></span><span class="label">published</span></div>
        <span class="link long" />
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.bolt" /></span><span class="label">change event</span></div>
        <span class="link long" />
        <div class="node"><span class="tile on"><svg viewBox="0 0 16 16" v-html="ICONS.devices" /></span><span class="label">every device</span></div>
      </div>
      <div class="row gap">
        <span class="chip warn"><span class="dot" />1 approval in production</span>
        <span class="chip">rev 42</span>
        <span class="chip ok"><span class="dot" />304 when nothing changed</span>
        <span class="chip dashed">break-glass for on call</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hiw { border: 1px solid var(--cf-rule); container-type: inline-size; }
.steps { display: grid; grid-template-columns: repeat(3, 1fr); }
.rules { display: grid; }
.rules .t { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
.rules b { font-family: var(--vp-font-family-mono); font-size: 12px; }
.step { display: grid; align-content: start; gap: 8px; padding: 20px; border-right: 1px solid var(--cf-rule); min-width: 0; }
.words { display: grid; gap: 8px; align-content: start; }
.step:last-child { border-right: 0; }
.words h3 { margin: 2px 0 0; padding: 0; border: 0; font-size: 15px; font-weight: 500; letter-spacing: 0; line-height: 1.4; color: var(--cf-ink); }
.words .text { font-size: 14px; line-height: 1.6; color: var(--cf-ink-2); }
.art { display: grid; gap: 12px; margin-top: 12px; }
.gap { gap: 6px; }
.path { display: grid; gap: 16px; padding: 20px; border-top: 1px solid var(--cf-rule); }
.flow { row-gap: 14px; }
/* no room for three side by side (the docs' column): each step is a row, its words left and its picture right */
@container (max-width: 820px) {
  .steps { grid-template-columns: 1fr; }
  .step { grid-template-columns: minmax(0, 0.8fr) minmax(0, 1fr); column-gap: 28px; border-right: 0; border-bottom: 1px solid var(--cf-rule); }
  .step > .art { margin-top: 0; align-self: center; }
  .step:last-child { border-bottom: 0; }
}
@container (max-width: 520px) {
  .step { grid-template-columns: 1fr; }
  .step > .art { margin-top: 12px; }
}
</style>

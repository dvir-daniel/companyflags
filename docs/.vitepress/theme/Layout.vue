<script setup lang="ts">
// The default layout, with light ↔ dark drawn as a circle growing from the switch (VitePress's own recipe for the
// View Transitions API). Without it, or with less motion asked for, the theme just changes.
import { nextTick, provide } from 'vue';
import { useData } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
import { lessMotion, quiet } from './motion.ts';

const { isDark } = useData();

provide('toggle-appearance', async ({ clientX: x, clientY: y }: MouseEvent) => {
  if (!('startViewTransition' in document) || document.hidden || lessMotion()) {
    isDark.value = !isDark.value;
    return;
  }
  const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  const clip = [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`];
  document.documentElement.classList.add('cf-theme-switch');
  const t = quiet(document.startViewTransition(async () => {
    isDark.value = !isDark.value;
    await nextTick();
  }));
  // a tab the browser isn't drawing never starts it: then the theme just changes
  const late = setTimeout(() => t.skipTransition(), 1000);
  try {
    await t.ready;
    clearTimeout(late);
    document.documentElement.animate({ clipPath: clip }, {
      duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', pseudoElement: '::view-transition-new(root)',
    });
    await t.finished;
  } catch { /* skipped: the theme has changed all the same */ }
  document.documentElement.classList.remove('cf-theme-switch');
});
</script>

<template>
  <DefaultTheme.Layout />
</template>

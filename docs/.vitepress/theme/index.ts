import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import Landing from './Landing.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
  },
} satisfies Theme;

import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import Landing from './Landing.vue';
import IllusHowItWorks from './IllusHowItWorks.vue';
import IllusChain from './IllusChain.vue';
import IllusOrder from './IllusOrder.vue';
import IllusArchitecture from './IllusArchitecture.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('Landing', Landing);
    app.component('IllusHowItWorks', IllusHowItWorks);
    app.component('IllusChain', IllusChain);
    app.component('IllusOrder', IllusOrder);
    app.component('IllusArchitecture', IllusArchitecture);
  },
} satisfies Theme;

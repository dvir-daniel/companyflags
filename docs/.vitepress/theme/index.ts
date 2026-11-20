import DefaultTheme from 'vitepress/theme';
import type { Theme } from 'vitepress';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './style.css';
import Layout from './Layout.vue';
import Landing from './Landing.vue';
import IllusHowItWorks from './IllusHowItWorks.vue';
import IllusChain from './IllusChain.vue';
import IllusOrder from './IllusOrder.vue';
import IllusArchitecture from './IllusArchitecture.vue';
import { pageTransitions } from './motion.ts';

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app, router }) {
    pageTransitions(router);
    app.component('Landing', Landing);
    app.component('IllusHowItWorks', IllusHowItWorks);
    app.component('IllusChain', IllusChain);
    app.component('IllusOrder', IllusOrder);
    app.component('IllusArchitecture', IllusArchitecture);
  },
} satisfies Theme;

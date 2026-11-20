// The flagd plugin: one entity's flags in one service as flagd JSON (../flagd.ts), for flagd itself or an OpenFeature
// flagd provider evaluating in-process on a backend. With an API key.
//   GET /sdk/v1/flagd/<dimension>/<entity>, or GET /sdk/v1/flagd with a key for one entity

import { definePlugin } from '../plugin.ts';
import { flagdRoutes } from '../delivery.ts';

export const flagd = () => definePlugin({
  id: 'flagd',
  setup: (ctx) => ({ routes: flagdRoutes(ctx), prefixes: ['/sdk/v1/flagd'] }),
});

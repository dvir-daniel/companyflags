// The OFREP plugin: OpenFeature's Remote Evaluation Protocol (../ofrep.ts), for OpenFeature's own OFREP providers on the
// web, Android, iOS and servers. Apps use an app token, backends an API key.
//   POST /ofrep/v1/evaluate/flags, POST /ofrep/v1/evaluate/flags/<key>, GET /ofrep/v1/events/… (change events)

import { definePlugin } from '../plugin.ts';
import { ofrepApi } from '../ofrep.ts';

export const ofrep = () => definePlugin({
  id: 'ofrep',
  setup: ({ db, plane, keys, links, flagSets, hub }) => ({
    routes: ofrepApi({ db, plane, keys, links, apps: flagSets, hub }),
    prefixes: ['/ofrep'],
  }),
});

// The cdn-files plugin: the CDN file, one flagd JSON file per environment, service and entity (../flagd.ts), made to
// sit behind a CDN, for apps that read a file (an OpenFeature flagd provider, in-process) instead of using OFREP. The
// entity's app link is its address.
//   GET /cdn/v1/flags/<env>/<service>, GET /cdn/v1/flags/<env>/<service>/<entity>/<secret>

import { definePlugin } from '../plugin.ts';
import { cdnFileRoutes } from '../delivery.ts';

export const cdnFiles = () => definePlugin({
  id: 'cdn-files',
  setup: (ctx) => ({ routes: cdnFileRoutes(ctx), prefixes: ['/cdn'] }),
});

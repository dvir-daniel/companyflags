// The app-files plugin: the CDN file, one flagd JSON file per environment, service and entity (../flagd.ts), made to
// sit behind a CDN, for apps that read a file (an OpenFeature flagd provider, in-process) instead of using OFREP. The
// entity's app link is its address.
//   GET /client/v1/flags/<env>/<service>, GET /client/v1/flags/<env>/<service>/<entity>/<secret>

import { definePlugin } from '../plugin.ts';
import { appFileRoutes } from '../delivery.ts';

export const appFiles = () => definePlugin({
  id: 'app-files',
  setup: (ctx) => ({ routes: appFileRoutes(ctx), prefixes: ['/client'] }),
});

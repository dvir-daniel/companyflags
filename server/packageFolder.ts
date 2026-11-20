// The folder of the companyflags package: the repository's root here, or node_modules/companyflags when installed
// from npm (packages/companyflags). Both keep this code one folder down (server/ here, dist/ there), so the same
// path finds package.json and the console (web/dist) in either.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_FOLDER = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/** The package's version (its package.json). */
export const VERSION = (JSON.parse(readFileSync(join(PACKAGE_FOLDER, 'package.json'), 'utf8')) as { version: string }).version;

/** The built console (vite build). */
export const CONSOLE_FOLDER = join(PACKAGE_FOLDER, 'web', 'dist');

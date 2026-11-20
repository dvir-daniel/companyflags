// The docs' pages as Fumadocs sees them: each page's address is its path under content/docs ("/guide/quickstart").
import { loader } from 'fumadocs-core/source';
import { docs } from '@/.source/server';

export const source = loader({ baseUrl: '/', source: docs.toFumadocsSource() });

/** The site's address prefix on GitHub Pages ("/companyflags"), or "" locally. */
export const BASE = process.env.NEXT_PUBLIC_BASE ?? '';
export const REPO = 'https://github.com/dvir-daniel/companyflags';

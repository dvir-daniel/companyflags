// The search index, written once at build time (static export); the browser searches it itself.
import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '@/lib/source';

export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);

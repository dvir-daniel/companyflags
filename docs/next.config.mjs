// The docs site, built to static files (out/) for GitHub Pages. DOCS_BASE is the path it's served under there
// ("/companyflags/"); locally it's served at the root.
import { join } from 'node:path';
import { createMDX } from 'fumadocs-mdx/next';

const base = (process.env.DOCS_BASE ?? '/').replace(/\/$/, '');

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath: base || undefined,
  images: { unoptimized: true },
  reactStrictMode: true,
  turbopack: { root: join(import.meta.dirname, '..') },   // the repository: its pnpm workspace
  env: { NEXT_PUBLIC_BASE: base },
};

export default createMDX()(config);

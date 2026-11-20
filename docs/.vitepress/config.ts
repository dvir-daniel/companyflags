import { defineConfig } from 'vitepress';
import llmstxt from 'vitepress-plugin-llms';

const repo = 'https://github.com/dvir-daniel/companyflags';

export default defineConfig({
  // for agents: /llms.txt (an index), /llms-full.txt (every page) and a .md copy of each page (guide/ai-resources.md)
  // DOCS_SITE: where the site is published (CI sets it with DOCS_BASE), so its links are full addresses
  vite: { plugins: [llmstxt({ ignoreFiles: ['design/**', 'README.md'], ...(process.env.DOCS_SITE ? { domain: process.env.DOCS_SITE } : {}) })] },
  title: 'CompanyFlags',
  description: 'The most comprehensive feature flag framework: open source, self-hosted, and read with OpenFeature.',
  base: process.env.DOCS_BASE || '/',
  cleanUrls: true,
  appearance: true,
  lastUpdated: false,
  srcExclude: ['design/**', 'README.md'],
  // http://localhost:8787 is where your own server runs, not a page of this site
  ignoreDeadLinks: 'localhostLinks',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${process.env.DOCS_BASE || '/'}logo.svg` }]],
  themeConfig: {
    logo: '/logo.svg',
    search: { provider: 'local' },
    editLink: { pattern: `${repo}/edit/main/docs/:path`, text: 'Edit this page on GitHub' },
    footer: { message: 'Released under the MIT License.', copyright: 'CompanyFlags contributors' },
    siteTitle: 'CompanyFlags',
    nav: [
      { text: 'Readme', link: '/', activeMatch: '^/$' },
      // the security model's address is under /guide/, but it is listed in the reference
      { text: 'Docs', link: '/guide/introduction', activeMatch: '^/guide/(?!security$)' },
      { text: 'OpenFeature', link: '/sdk/openfeature', activeMatch: '^/sdk/openfeature' },
      { text: 'Self-hosting', link: '/self-hosting/docker', activeMatch: '/self-hosting/' },
      { text: 'Reference', link: '/reference/http-api', activeMatch: '^/(reference/|guide/security$)' },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Examples', link: '/guide/examples' },
          { text: 'Compared with others', link: '/guide/comparison' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'How it fits together', link: '/guide/concepts' },
          { text: 'Architecture', link: '/guide/architecture' },
          { text: 'Dimensions', link: '/guide/dimensions' },
          { text: 'Flags and rules', link: '/guide/flags-and-rules' },
          { text: 'Services', link: '/guide/services' },
        ],
      },
      {
        text: 'Reading flags',
        items: [
          { text: 'OpenFeature (web, mobile, servers)', link: '/sdk/openfeature' },
          { text: 'Backends', link: '/guide/backends' },
          { text: 'The app file', link: '/sdk/app-file' },
        ],
      },
      {
        text: 'Changing flags',
        items: [
          { text: 'Releases', link: '/guide/releases' },
          { text: 'Approvals and history', link: '/guide/approvals' },
          { text: 'Flags as code', link: '/guide/flags-as-code' },
          { text: 'Flags in the age of AI', link: '/guide/ai' },
          { text: 'AI resources', link: '/guide/ai-resources' },
        ],
      },
      {
        text: 'Plugins',
        items: [
          { text: 'Plugins', link: '/reference/plugins' },
          { text: 'Webhooks', link: '/guide/webhooks' },
        ],
      },
      {
        text: 'Migration',
        items: [
          { text: 'Moving from another system', link: '/guide/migration' },
        ],
      },
      {
        text: 'Self-hosting',
        items: [
          { text: 'Docker', link: '/self-hosting/docker' },
          { text: 'Configuration', link: '/self-hosting/configuration' },
          { text: 'Sign-in and single sign-on', link: '/self-hosting/sign-in' },
          { text: 'CDN (Cloudflare)', link: '/self-hosting/cdn' },
          { text: 'Appearance', link: '/self-hosting/appearance' },
          { text: 'Production checklist', link: '/self-hosting/production' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/reference/http-api' },
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Attributes', link: '/reference/attributes' },
          { text: 'Security model', link: '/guide/security' },
        ],
      },
    ],
  },
});

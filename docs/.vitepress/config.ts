import { defineConfig } from 'vitepress';

const repo = 'https://github.com/dvir-daniel/companyfeatures';

export default defineConfig({
  title: 'CompanyFeatures',
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
    footer: { message: 'Released under the MIT License.', copyright: 'CompanyFeatures contributors' },
    siteTitle: 'CompanyFeatures',
    nav: [
      { text: 'Readme', link: '/', activeMatch: '^/$' },
      { text: 'Docs', link: '/guide/introduction', activeMatch: '/guide/' },
      { text: 'OpenFeature', link: '/sdk/openfeature', activeMatch: '/sdk/' },
      { text: 'Self-hosting', link: '/self-hosting/docker', activeMatch: '/self-hosting/' },
      { text: 'Reference', link: '/reference/http-api', activeMatch: '/reference/' },
      { text: 'GitHub', link: repo },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Introduction', link: '/guide/introduction' },
          { text: 'Quickstart', link: '/guide/quickstart' },
          { text: 'Compared with others', link: '/guide/comparison' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'How it fits together', link: '/guide/concepts' },
          { text: 'Dimensions', link: '/guide/dimensions' },
          { text: 'Flags and rules', link: '/guide/flags-and-rules' },
          { text: 'Releases', link: '/guide/releases' },
          { text: 'Approvals and history', link: '/guide/approvals' },
        ],
      },
      {
        text: 'Delivering flags',
        items: [
          { text: 'Flag sets', link: '/guide/flag-sets' },
          { text: 'Backends', link: '/guide/backends' },
          { text: 'OpenFeature (web, mobile, servers)', link: '/sdk/openfeature' },
          { text: 'The app file', link: '/sdk/app-file' },
        ],
      },
      {
        text: 'Self-hosting',
        items: [
          { text: 'Docker', link: '/self-hosting/docker' },
          { text: 'Configuration', link: '/self-hosting/configuration' },
          { text: 'Sign-in and single sign-on', link: '/self-hosting/sign-in' },
          { text: 'CDN (Cloudflare)', link: '/self-hosting/cdn' },
          { text: 'Production checklist', link: '/self-hosting/production' },
          { text: 'Security model', link: '/guide/security' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'HTTP API', link: '/reference/http-api' },
          { text: 'Attributes', link: '/reference/attributes' },
        ],
      },
    ],
  },
});

// The docs' pages (content/docs, Markdown and MDX), compiled by fumadocs-mdx. VitePress-style boxes are written
// `:::warning[Title]` and become Fumadocs callouts; code tabs are ```bash tab="Docker".
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { remarkDirectiveAdmonition } from 'fumadocs-core/mdx-plugins';
import remarkDirective from 'remark-directive';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: { postprocess: { includeProcessedMarkdown: true } },
});

export default defineConfig({
  mdxOptions: {
    remarkPlugins: (plugins) => [remarkDirective, remarkDirectiveAdmonition, ...plugins],
    rehypeCodeOptions: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
});

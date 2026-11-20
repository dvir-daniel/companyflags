import defaultMdxComponents from 'fumadocs-ui/mdx';
import { CalloutContainer, CalloutDescription, CalloutTitle } from 'fumadocs-ui/components/callout';
import type { MDXComponents } from 'mdx/types';
import { IllusArchitecture } from '@/components/illus/architecture';
import { IllusChain } from '@/components/illus/chain';
import { IllusHowItWorks } from '@/components/illus/how-it-works';
import { IllusOrder } from '@/components/illus/order';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CalloutContainer, CalloutTitle, CalloutDescription,
    IllusArchitecture, IllusChain, IllusHowItWorks, IllusOrder,
    ...components,
  };
}

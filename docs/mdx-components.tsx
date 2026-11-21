import defaultMdxComponents from 'fumadocs-ui/mdx';
import { CalloutContainer, CalloutDescription, CalloutTitle } from 'fumadocs-ui/components/callout';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import type { MDXComponents } from 'mdx/types';
import { IllusArchitecture } from '@/components/illus/architecture';
import { IllusChain } from '@/components/illus/chain';
import { IllusHowItWorks } from '@/components/illus/how-it-works';
import { IllusOrder } from '@/components/illus/order';
import { SetupBuilder } from '@/components/setup-builder/setup-builder';

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    CalloutContainer, CalloutTitle, CalloutDescription,
    Tab, Tabs,
    IllusArchitecture, IllusChain, IllusHowItWorks, IllusOrder, SetupBuilder,
    ...components,
  };
}

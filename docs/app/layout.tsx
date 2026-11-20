import './global.css';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SiteBar } from '@/components/site-bar';
import { GeistMono } from 'geist/font/mono';
import { GeistSans } from 'geist/font/sans';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { BASE } from '@/lib/source';

export const metadata: Metadata = {
  title: { template: '%s | CompanyFlags', default: 'CompanyFlags | The most comprehensive feature flag framework' },
  description: 'Feature flags and remote config you run yourself, read with OpenFeature.',
  icons: { icon: `${BASE}/logo.svg` },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ options: { type: 'static', api: `${BASE}/api/search` } }}>
          <SiteBar />
          {children}
        </RootProvider>
      </body>
    </html>
  );
}

import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto grid max-w-lg flex-1 content-center gap-4 px-6 py-24 text-center">
      <p className="font-mono text-xs tracking-wider text-fd-muted-foreground uppercase">404</p>
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="text-fd-muted-foreground">There’s no page at this address. It may have moved.</p>
      <div><Link href="/guide/introduction" className="inline-flex h-9 items-center bg-fd-primary px-4 text-sm font-medium text-fd-primary-foreground">Read the docs</Link></div>
    </main>
  );
}

// The site's bar, for screens below 1024px where it isn't shown: the same parts of the site and Resources, at the
// foot of the docs' sidebar and in the phone's menu. Above 1024px the bar has them, so these hide (.cf-site-links).
import Link from 'next/link';
import { REPO } from '@/lib/source';
import { RESOURCES, resourceHref } from '@/lib/resources';

export function SiteLinks() {
  return (
    <nav className="cf-site-links" aria-label="Site">
      <Link href="/">Home</Link>
      <Link href="/guide/enterprise">Enterprise</Link>
      {RESOURCES.map((r) => (r.external
        ? <a key={r.text} href={resourceHref(r)}>{r.text}</a>
        : <Link key={r.text} href={r.url}>{r.text}</Link>))}
      <a href={REPO}>GitHub</a>
    </nav>
  );
}

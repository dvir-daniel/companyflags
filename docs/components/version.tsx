// The version these docs are for, at the top of the sidebar (better-auth.com's "Latest Version"): from the server's
// package.json, so a release updates it.
import pkg from '../../package.json' with { type: 'json' };
import { REPO } from '@/lib/source';

export function Version() {
  return (
    <a href={`${REPO}/releases/tag/v${pkg.version}`} className="cf-version">
      <span className="cf-version-label">Latest version</span>
      <span className="cf-version-number">{pkg.version}</span>
    </a>
  );
}

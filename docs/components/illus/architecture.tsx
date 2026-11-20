// The architecture, drawn the way better-auth.com draws: a small core, plugins around it, one config file that the
// server and the CLI read (server/plugin.ts; server/configFile.ts reads the file, server/config.ts is its type;
// server/cli.ts).
import { Fragment } from 'react';
import { ICONS, type IconName } from './icons';
import './architecture.css';

const core: { icon: IconName; label: string }[] = [
  { icon: 'console', label: 'console + api' },
  { icon: 'lock', label: 'sign-in' },
  { icon: 'check', label: 'approvals' },
  { icon: 'flag', label: 'evaluator' },
  { icon: 'database', label: 'journal' },
  { icon: 'bolt', label: 'publish' },
];
const plugins: { call: string; icon: IconName; where: string; who: string }[] = [
  { call: 'ofrep()', icon: 'devices', where: '/ofrep/v1', who: 'apps · backends' },
  { call: 'flagd()', icon: 'server', where: '/sdk/v1/flagd', who: 'backends' },
  { call: 'cdnFiles()', icon: 'phone', where: '/cdn/v1', who: 'apps · CDN' },
  { call: 'cloudflare()', icon: 'cloud', where: 'after a publish', who: 'purge' },
  { call: 'webhooks()', icon: 'globe', where: '/hooks/v1 · after a change', who: 'Slack · CI · old system' },
];

export function IllusArchitecture() {
  return (
    <div className="cf-ill arch">
      <div className="head dots">
        <p className="label">companyflags.config.ts</p>
        <code className="term"><span className="p">export default</span> defineConfig({'{'} database, auth, plugins: [<span className="dim">ofrep(), flagd(), cdnFiles(), cloudflare(), webhooks()</span>] {'}'})</code>
      </div>
      <div className="core">
        <p className="label">Core</p>
        <div className="row">
          {core.map((c, i) => (
            <Fragment key={c.label}>
              {i > 0 && <span className="link" />}
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS[c.icon] }} /></span><span className="label">{c.label}</span></div>
            </Fragment>
          ))}
        </div>
      </div>
      <div className="plugins">
        {plugins.map((p) => (
          <div key={p.call} className="plugin">
            <span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS[p.icon] }} /></span>
            <code className="call">{p.call}</code>
            <span className="where">{p.where}</span>
            <span className="chip"><span className="dot" />{p.who}</span>
          </div>
        ))}
        <div className="plugin own">
          <span className="tile dashed">+</span>
          <code className="call">definePlugin()</code>
          <span className="where">routes · console · onPublish · worker</span>
          <span className="chip dashed">your own</span>
        </div>
      </div>
      <div className="foot">
        <code className="term"><span className="p">$</span> companyflags flags push <span className="dim">→</span> ✓ create dark_mode <span className="dim">·</span> → request #12 in prod <span className="ok">✓</span></code>
      </div>
    </div>
  );
}

// Dimensions and entities: the levels an installation names, and entities that follow their parent's settings until
// they have their own.
import { ICONS } from './icons';
import './chain.css';

const tree: { parent: string; own?: boolean; children: { key: string; own?: boolean }[] }[] = [
  { parent: 'acme', own: true, children: [{ key: 'acme-kids' }] },
  { parent: 'globex', own: true, children: [{ key: 'lumen', own: true }, { key: 'bolt' }] },
];

export function IllusChain() {
  return (
    <div className="cf-ill chain">
      <div className="head dots">
        <p className="label">Settings → Dimensions</p>
        <div className="row gap"><span className="chip">company</span><span className="sep">›</span><span className="chip">brand</span><span className="chip dashed">+ up to 4 levels</span></div>
      </div>
      <div className="trees">
        {tree.map((t) => (
          <div key={t.parent} className="tree">
            <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.users }} /></span><span className="label">{t.parent}</span></div>
            <div className="kids">
              {t.children.map((c) => (
                <div key={c.key} className="row">
                  <span className="link" />
                  <div className="node"><span className={c.own ? 'tile on' : 'tile'}><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.users }} /></span><span className="label">{c.key}</span></div>
                  {c.own
                    ? <span className="chip ok kid-chip"><span className="dot" />own settings</span>
                    : <span className="chip kid-chip">follows {t.parent}</span>}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// How CompanyFlags works, in three steps and the path of one change, drawn the way better-auth.com draws its
// features: icon tiles joined by thin lines, status chips, a one-line terminal, mono labels.
import { ICONS } from './icons';
import './how-it-works.css';

export function IllusHowItWorks() {
  return (
    <div className="cf-ill hiw">
      <div className="steps">
        <article className="step">
          <div className="words">
            <p className="label">01 · Describe</p>
            <h3>Your dimensions.</h3>
            <p className="text">Say what config is served per: regions and their stores, teams, customers. Up to four levels.</p>
          </div>
          <div className="art">
            <div className="row">
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.globe }} /></span><span className="label">us-west</span></div>
              <span className="link" />
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.store }} /></span><span className="label">sf-01</span></div>
              <span className="link" />
              <div className="node"><span className="tile"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.store }} /></span><span className="label">sf-02</span></div>
              <span className="link" />
              <div className="node"><span className="tile dashed">+</span><span className="label">{' '}</span></div>
            </div>
            <div className="row gap"><span className="chip">region › store</span><span className="chip ok"><span className="dot" />own settings</span></div>
          </div>
        </article>

        <article className="step">
          <div className="words">
            <p className="label">02 · Decide</p>
            <h3>Rules, then defaults.</h3>
            <p className="text">Locked rules for everyone first, then each entity’s own settings, then the rules for everyone.</p>
          </div>
          <div className="art">
            <div className="rules">
              <div className="rule-row"><span className="chip bad"><span className="dot" />override</span><span className="t">app below 6.0</span><b>off</b></div>
              <div className="rule-row"><span className="chip ok"><span className="dot" />sf-01</span><span className="t">its own setting</span><b>on</b></div>
              <div className="rule-row"><span className="chip warn"><span className="dot" />10%</span><span className="t">of devices</span><b>on</b></div>
              <div className="rule-row"><span className="chip"><span className="dot" />default</span><span className="t">everyone else</span><b>off</b></div>
            </div>
          </div>
        </article>

        <article className="step">
          <div className="words">
            <p className="label">03 · Read</p>
            <h3>With OpenFeature.</h3>
            <p className="text">Apps and backends use OpenFeature’s own providers. No SDK of ours, no rules on devices.</p>
          </div>
          <div className="art">
            <div className="row">
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.browser }} /></span><span className="label">web</span></div>
              <span className="link" />
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.phone }} /></span><span className="label">ios</span></div>
              <span className="link" />
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.tablet }} /></span><span className="label">android</span></div>
              <span className="link" />
              <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.server }} /></span><span className="label">api</span></div>
            </div>
            <code className="term"><span className="p">$</span> getBooleanValue(<span className="dim">'new_checkout'</span>) <span className="dim">→</span> true <span className="ok">✓</span></code>
          </div>
        </article>
      </div>

      <div className="path dots">
        <p className="label">The path of a change</p>
        <div className="row flow">
          <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.console }} /></span><span className="label">draft</span></div>
          <span className="link long" />
          <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.check }} /></span><span className="label">approved</span></div>
          <span className="link long" />
          <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.database }} /></span><span className="label">published</span></div>
          <span className="link long" />
          <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.bolt }} /></span><span className="label">change event</span></div>
          <span className="link long" />
          <div className="node"><span className="tile on"><svg viewBox="0 0 16 16" dangerouslySetInnerHTML={{ __html: ICONS.devices }} /></span><span className="label">every device</span></div>
        </div>
        <div className="row gap">
          <span className="chip warn"><span className="dot" />1 approval in production</span>
          <span className="chip">rev 42</span>
          <span className="chip ok"><span className="dot" />304 when nothing changed</span>
          <span className="chip dashed">break-glass for on call</span>
        </div>
      </div>
    </div>
  );
}

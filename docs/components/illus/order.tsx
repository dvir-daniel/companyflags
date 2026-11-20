// The order one flag is decided in, for one entity, in one environment (server/evaluator.ts entityChain and
// evaluate). The first step that answers wins.
import './order.css';

const steps: { label: string; title: string; text: string; chip: string; tone?: 'ok' | 'warn' | 'bad' }[] = [
  { label: 'in service?', title: 'Not in this service', text: 'The flag doesn’t exist for it.', chip: 'code default', tone: 'bad' },
  { label: 'on?', title: 'The flag is off', text: 'Nothing is sent.', chip: 'code default', tone: 'bad' },
  { label: 'locked', title: 'Overrides', text: 'For everyone. A missing value counts as a match.', chip: 'value or %', tone: 'warn' },
  { label: 'own', title: 'The entity’s own rules', text: '“Skip what’s above” stops here, with its own default.', chip: 'value or %', tone: 'ok' },
  { label: 'above', title: 'Its parent’s rules, and up', text: 'Each level until one has “Skip what’s above”.', chip: 'value or %', tone: 'ok' },
  { label: 'everyone', title: 'Rules for everyone', text: 'Skipped below an entity with “Skip what’s above”.', chip: 'value or %' },
  { label: 'default', title: 'The default', text: 'The nearest own default, else everyone’s.', chip: 'value' },
];

export function IllusOrder() {
  return (
    <div className="cf-ill order">
      {steps.map((s, i) => (
        <div key={s.title} className="step">
          <span className="num">{String(i + 1).padStart(2, '0')}</span>
          <span className="what"><b>{s.title}</b><span className="text">{s.text}</span></span>
          <span className={s.tone ? `chip ${s.tone}` : 'chip'}><span className="dot" />{s.chip}</span>
        </div>
      ))}
      <p className="foot label">The first step that answers wins · a % with no device ID, or outside every range, passes to the next</p>
    </div>
  );
}

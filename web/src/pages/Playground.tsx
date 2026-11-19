import { cn } from '@companyfeatures/ui/lib/utils';
import { conditionText, entityIndex, fmtValue, STAGE_LABEL, vocabOf, type EvalResult, type TraceStep } from '../api.ts';
import { useApp } from '../app.ts';
import { InAppDefault, ReasonBadge, SplitBar, Val } from '../ui.tsx';

// The step-by-step answer to "why does this device get this value?", used by the flag page's Debug tab.
// `showHead` false leaves out the answer itself, for a page that shows it above.
export function TraceView({ result, showHead = true }: { result: EvalResult; showHead?: boolean }) {
  const meta = Object.entries(result.metadata);
  return (
    <div className="grid gap-4">
      {showHead && (
        <div className="grid gap-2">
          <h2 className="m-0 font-mono text-15 font-medium tracking-normal text-ink">{result.key}</h2>
          <div className="flex flex-wrap items-center gap-2.5">
            {result.errorCode ? <ReasonBadge reason={result.errorCode} /> : <>
              {result.codeDefault ? <InAppDefault className="text-15 leading-7" /> : <Val className="text-15 leading-7">{fmtValue(result.value)}</Val>}
              <ReasonBadge reason={result.reason} />
              <span className="text-13 text-ink-3">variant <span className="font-mono text-ink-2">{result.variant}</span></span>
            </>}
          </div>
          {meta.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-13">
              {meta.map(([k, v]) => <span key={k}><span className="text-ink-3">{k}</span> <span className="font-mono text-ink-2">{String(v)}</span></span>)}
            </div>
          )}
        </div>
      )}
      <ol className="m-0 list-none border-t border-rule p-0">
        {(result.trace ?? []).map((s, i) => <TraceStepView key={i} step={s} />)}
      </ol>
    </div>
  );
}

// a square per step: green where the answer came from, red where nothing was sent, hollow for the rest
const MARK: Record<string, string> = {
  match: 'bg-ok', served: 'bg-ok', not_delivered: 'bg-live', disabled: 'bg-flag',
};
const OUTCOME_TEXT: Record<string, string> = { match: 'text-ok', served: 'text-ok', not_delivered: 'text-live', disabled: 'text-flag' };

function TraceStepView({ step }: { step: TraceStep }) {
  const { meta } = useApp();
  const vocab = vocabOf(meta);
  // an entity's own settings: whose ("Acme’s rule", "Acme’s default")
  const owner = step.owner ? entityIndex(meta.entities).get(step.owner)?.name ?? step.owner : null;
  const stage = owner && step.stage === 'entity' ? `${owner}’s rule` : owner && step.stage === 'entity_default' ? `${owner}’s default`
    : owner && step.stage === 'default' ? `${owner}’s default` : STAGE_LABEL[step.stage] ?? step.stage;
  return (
    <li className="relative grid gap-1 border-b border-grid py-3 pl-6">
      <span aria-hidden className={cn('absolute top-[19px] left-1 size-[7px]', MARK[step.outcome] ?? 'border-[1.5px] border-ink-3')} />
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-13">
        <span className="font-mono text-11 tracking-[0.55px] text-ink-3 uppercase">{stage}</span>
        {step.ruleName && <b className="font-medium text-ink">{step.ruleName}</b>}
        <span className={cn('ml-auto font-mono text-11 tracking-[0.55px] uppercase', OUTCOME_TEXT[step.outcome] ?? 'text-ink-3')}>{step.outcome.replace('_', ' ')}</span>
      </div>
      {step.detail && <div className="text-13 text-ink-2">{step.detail}</div>}
      {step.conditions && step.conditions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="mt-1 border-collapse text-13">
            <tbody>
              {step.conditions.map((c, i) => (
                <tr key={i} className="border-t border-grid align-baseline">
                  <td className={cn('w-5 py-1.5 pr-2 font-mono', c.result ? 'text-ok' : 'text-live')} aria-label={c.result ? 'true' : 'false'}>{c.result ? '✓' : '✗'}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs text-ink">{conditionText({ field: c.field, op: c.op, values: c.values as (string | number)[] | undefined }, vocab)}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs text-ink-2">actual: {c.actual === null ? <i className="text-ink-3">missing</i> : JSON.stringify(c.actual)}</td>
                  {c.note && <td className="py-1.5 text-ink-3">{c.note}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {step.split && (
        <div className="mt-1 grid gap-2">
          <div className="flex flex-wrap gap-x-1.5 font-mono text-xs text-ink">
            <span className="text-ink-3">by</span><span>{step.split.unit ?? 'missing'}</span>
            {step.split.unitValue && <><span className="text-ink-3">=</span><span>{step.split.unitValue}</span></>}
            <span className="ml-2 text-ink-3">salt</span><span>{step.split.salt}</span>
            <span className="ml-2 text-ink-3">hash</span><span>v{step.split.hashVersion}</span>
            {step.split.bucket !== undefined && <><span className="ml-2 text-ink-3">bucket</span><span>{step.split.bucket} / 10000</span></>}
          </div>
          {step.split.bucket !== undefined && <SplitBar ranges={step.split.range ? [step.split.range] : []} variations={[step.split.range?.variation ?? '']} marker={step.split.bucket} />}
        </div>
      )}
    </li>
  );
}

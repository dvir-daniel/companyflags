// Type-aware editing of a flag's values, so nobody has to type raw JSON. The text ⇄ value rules are in valueText.ts.
import { useId, type ChangeEvent } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { Button } from '@companyfeatures/ui/components/button';
import { Input } from '@companyfeatures/ui/components/input';
import { cn } from '@companyfeatures/ui/lib/utils';
import { Segmented } from './ui.tsx';
import { denseField, textareaField } from './uiKit.ts';
import { isTrue, nameError, valueError, type ValueRow } from './valueText.ts';

export { blankRow, fromText, isTrue, nameError, rowError, toText, valueError, type ValueRow } from './valueText.ts';

/** A dense (32px) text field, for rows of an editor. */
const dense = cn(denseField, 'w-full rounded-none');

/**
 * One value, typed: true/false, a number, JSON or text. `dense` for editor rows (32px); dialogs use the 38px field.
 * `invalid` and `describedBy` tie it to the message that says what's wrong with it.
 */
export function ValueInput({ type, text, onChange, label, dense: isDense = false, invalid, describedBy, placeholder }: {
  type: string; text: string; onChange: (t: string) => void; label: string; dense?: boolean; invalid?: boolean; describedBy?: string; placeholder?: string;
}) {
  if (type === 'bool') {
    return <Segmented label={label} value={isTrue(text) ? 'true' : 'false'} onChange={onChange}
      options={[{ value: 'true', label: 'true' }, { value: 'false', label: 'false' }]} />;
  }
  const a11y = { 'aria-label': label, 'aria-invalid': invalid || undefined, 'aria-describedby': describedBy };
  if (type === 'json') {
    return <textarea rows={3} spellCheck={false} {...a11y} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
      className={cn(textareaField, 'rounded-none font-mono text-13', isDense && 'min-h-8 py-1.5')} />;
  }
  const number = type === 'number';
  const props = {
    ...a11y, value: text, onChange: (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value),
    type: number ? 'number' : 'text', placeholder: placeholder ?? (number ? undefined : 'Text the app receives'),
  };
  return isDense ? <input {...props} className={cn(dense, number && 'font-mono')} /> : <Input {...props} className={cn(number && 'font-mono')} />;
}

/** Variants as rows: name, value, and a remove button for the new ones. Existing names can't change. */
export function ValuesEditor({ type, rows, onChange }: { type: string; rows: ValueRow[]; onChange: (r: ValueRow[]) => void }) {
  const uid = useId();
  const set = (i: number, patch: Partial<ValueRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <ul className="m-0 list-none border-t border-rule p-0">
      {rows.map((r, i) => {
        // each message is tied to the field it is about, so a screen reader reads it there
        const keyErr = nameError(r, rows);
        const valErr = valueError(type, r.text);
        const keyErrId = `${uid}-${i}-name`;
        const valErrId = `${uid}-${i}-value`;
        return (
          <li key={i} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_32px] items-start gap-2 border-b border-grid py-2 max-sm:grid-cols-[minmax(0,1fr)_32px]">
            <input aria-label="Value name" placeholder="name" value={r.key} disabled={!r.isNew} spellCheck={false}
              title={r.isNew ? undefined : 'Names can’t change once rules may use them'}
              aria-invalid={!!keyErr || undefined} aria-describedby={keyErr ? keyErrId : undefined}
              onChange={(e) => set(i, { key: e.target.value.toLowerCase().replace(/\s+/g, '_') })}
              className={cn(dense, 'font-mono disabled:bg-panel disabled:text-ink-2 disabled:opacity-100')} />
            <div className="grid min-w-0 gap-1 max-sm:col-span-2 max-sm:row-start-2">
              <ValueInput dense type={type} label={`Value for ${r.key || 'new value'}`} text={r.text} onChange={(t) => set(i, { text: t })}
                invalid={!!valErr} describedBy={valErr ? valErrId : undefined} />
              {keyErr && <span id={keyErrId} className="text-13 text-live">{keyErr}</span>}
              {valErr && <span id={valErrId} className="text-13 text-live">{valErr}</span>}
            </div>
            {r.isNew
              ? <Button variant="ghost" size="icon" className="text-ink-3 hover:text-live" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label="Remove value" title="Remove"><XIcon /></Button>
              : <span />}
          </li>
        );
      })}
    </ul>
  );
}

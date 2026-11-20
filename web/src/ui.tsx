import { Children, cloneElement, Fragment, isValidElement, use, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Badge as UIBadge } from '@companyflags/ui/components/badge';
import { Callout } from '@companyflags/ui/components/callout';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@companyflags/ui/components/dialog';
import { Empty as UIEmpty, EmptyContent, EmptyDescription } from '@companyflags/ui/components/empty';
import { Switch as UISwitch } from '@companyflags/ui/components/switch';
import { BAR_CONTROLS } from '@companyflags/ui/components/page-bar';
import { SectionLabel } from '@companyflags/ui/components/page';
import { cn } from '@companyflags/ui/lib/utils';
import { CODE_DEFAULT, conditionText, fieldLabel, fmtValue, reasonLabel, vocabOf, type Rule, type Variation } from './api.ts';
import { AppContext } from './app.ts';
import { unitPlural } from './dimWords.ts';
import { PAGE_SIZE, readPersistent } from './persist.ts';
import { monoLabel } from './uiKit.ts';

/*
 * This console's small UI kit: the shared Company OS components (@companyflags/ui) behind the console's own
 * props, plus a few pieces only a flag console needs (rules, splits, values). Everything is Tailwind with
 * the shared tokens; the recipes are in packages/ui/DESIGN.md.
 */

export { Segmented } from '@companyflags/ui/components/segmented';
// kept here for the pages that import them from the UI kit; they live in persist.ts, which needs no DOM
export { PAGE_SIZE, readPersistent };

/* ---------------------------------------------------------------- labels */

// red for problems, amber for things waiting on someone; everything else is a grey label
const LIVE_KINDS = /^(danger|status-(conflict|rejected|failed)|reason-ERROR)$/;
const WAIT_KINDS = /^(warn|status-(in_review|scheduled))$/;
export function Badge({ kind, children, title }: { kind?: string; children: ReactNode; title?: string }) {
  const variant = kind && LIVE_KINDS.test(kind) ? 'live' : kind && WAIT_KINDS.test(kind) ? 'warn' : 'default';
  return <UIBadge variant={variant} title={title}>{children}</UIBadge>;
}

export function KindBadge({ kind }: { kind: string }) {
  return <Badge kind={`kind-${kind}`}>{kind.replace('_', ' ')}</Badge>;
}

export function ReasonBadge({ reason }: { reason: string }) {
  return <Badge kind={`reason-${reason}`} title={reason}>{reasonLabel(reason)}</Badge>;
}

/** On or Off, with its square mark. */
export function OnOff({ on }: { on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-13 font-medium">
      <span aria-hidden className={cn('size-[7px] shrink-0', on ? 'bg-ok' : 'border-[1.5px] border-ink-3')} />
      {on ? 'On' : 'Off'}
    </span>
  );
}

/** A value as sent to apps: mono, in a 1px box. */
export function Val({ children, className, title }: { children: ReactNode; className?: string; title?: string }) {
  return <span title={title} className={cn('inline-block max-w-full truncate border border-rule bg-panel px-1.5 font-mono text-13 leading-[22px] text-ink align-middle', className)}>{children}</span>;
}

/** "No value is sent; the app uses the default in its code." */
export function InAppDefault({ className }: { className?: string }) {
  return (
    <span title="No value is sent; the app uses the default in its code"
      className={cn('inline-block border border-dashed border-rule-2 px-1.5 text-13 leading-[22px] text-ink-2 italic align-middle', className)}>in-app default</span>
  );
}

/* ---------------------------------------------------------------- states */

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <UIEmpty className="max-w-none border-0">
      <EmptyDescription>{children}</EmptyDescription>
      {action && <EmptyContent className={cn('items-start', BAR_CONTROLS)}>{action}</EmptyContent>}
    </UIEmpty>
  );
}

export function ErrorList({ error }: { error: { message: string; details?: string[] } | null }) {
  if (!error) return null;
  return (
    <Callout tone="error" role="alert">
      <b className="font-medium">{error.message}</b>
      {error.details && error.details.length > 0 && <ul className="mt-1 list-disc pl-4">{error.details.map((d, i) => <li key={i}>{d}</li>)}</ul>}
    </Callout>
  );
}

/* ---------------------------------------------------------------- rules and values */

const pctText = (n: number) => `${+(n / 100).toFixed(2)}%`;
const VarName = ({ v }: { v: string }) => (v === CODE_DEFAULT ? <InAppDefault /> : <code className="font-mono text-ink">{v}</code>);

export function ServeText({ rule }: { rule: Rule }) {
  const dims = use(AppContext)?.meta.dimensions ?? [];
  if (rule.serveVariation) return <span className="text-ink-2">→ <VarName v={rule.serveVariation} /></span>;
  if (!rule.split) return null;
  const s = rule.split;
  const simple = s.ranges.length === 1 && s.ranges[0].from === 0;
  if (simple) {
    const r = s.ranges[0];
    return <span className="text-ink-2">→ {pctText(r.to)} of {unitPlural(s.by, dims)} get <VarName v={r.variation} /></span>;
  }
  return (
    <span className="text-ink-2">
      → split by {fieldLabel(s.by, dims).toLowerCase()}:{' '}
      {s.ranges.map((r, i) => <span key={i}>{i > 0 && ', '}<VarName v={r.variation} /> {pctText(r.to - r.from)}</span>)}
    </span>
  );
}

export function RuleSummary({ rule, index }: { rule: Rule; index?: number }) {
  const meta = use(AppContext)?.meta;
  const vocab = meta ? vocabOf(meta) : undefined;
  return (
    <div className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-1 text-13', rule.disabled && 'line-through opacity-50')}>
      {index !== undefined && <span className="inline-grid size-5 shrink-0 place-items-center self-center border border-rule-2 font-mono text-11 text-ink-3">{index + 1}</span>}
      {rule.locked && <Badge title="Override: wins over the defaults and everyone’s own settings">override</Badge>}
      {rule.disabled && <Badge title="This rule is skipped">paused</Badge>}
      {rule.name && <span className="font-medium">{rule.name}</span>}
      <span>
        {rule.conditions.length === 0 ? <span className="text-ink-3">All requests</span>
          : <>If {rule.conditions.map((c, i) => <span key={i}>{i > 0 && <span className="text-ink-3"> and </span>}<code className="bg-wash px-1 font-mono text-xs">{conditionText(c, vocab)}</code></span>)}</>}
      </span>
      <ServeText rule={rule} />
    </div>
  );
}

// segment fills for a split, by variant order; the in-app default is hatched
const SEG = ['bg-ink', 'bg-ink-3', 'bg-rule-2', 'bg-ink-2', 'bg-ink/70', 'bg-ink-4'];
const HATCH = 'bg-[repeating-linear-gradient(45deg,var(--rule-2)_0_3px,transparent_3px_6px)]';

// Visual bar of a split: ranges over 0..10000
export function SplitBar({ ranges, variations, marker }: { ranges: { variation: string; from: number; to: number }[]; variations: string[]; marker?: number }) {
  return (
    <div className="relative h-2 overflow-visible border border-rule bg-panel" aria-hidden>
      {ranges.map((r, i) => (
        <div key={i} className={cn('absolute inset-y-0', r.variation === CODE_DEFAULT ? HATCH : SEG[Math.max(0, variations.indexOf(r.variation)) % SEG.length])}
          style={{ left: `${r.from / 100}%`, width: `${(r.to - r.from) / 100}%` }} title={`${r.variation}: ${pctText(r.to - r.from)}`} />
      ))}
      {marker !== undefined && <div className="absolute -inset-y-1 -ml-px w-[3px] bg-live" style={{ left: `${marker / 100}%` }} title={`This device: bucket ${marker}`} />}
    </div>
  );
}

export function VariationChip({ v, variations }: { v: string | undefined | null; variations?: Variation[] }) {
  if (!v) return <span className="text-ink-3">—</span>;
  if (v === CODE_DEFAULT) return <InAppDefault />;
  const val = variations?.find((x) => x.key === v)?.value;
  return <span><code className="font-mono text-ink">{v}</code>{val !== undefined && <span className="text-ink-3"> = {fmtValue(val)}</span>}</span>;
}

export function JsonView({ value }: { value: unknown }) {
  return <pre className="m-0 max-h-80 overflow-auto border border-rule bg-panel p-2.5 font-mono text-xs text-ink-1 select-text">{JSON.stringify(value, null, 2)}</pre>;
}

export function Collapsible({ title, children, defaultOpen = false }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="inline-flex cursor-default items-center gap-1.5 border-0 bg-transparent p-0 text-13 text-ink-2 hover:text-ink">
        <span aria-hidden className="w-2.5 font-mono text-11">{open ? '▾' : '▸'}</span>{title}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}

/* ---------------------------------------------------------------- fields */

const LABELABLE = new Set(['input', 'select', 'textarea']);
type ControlProps = { id?: string; children?: ReactNode; 'aria-describedby'?: string; 'aria-required'?: boolean };

/**
 * Gives a field's control the id its label points at, and the hint as its description. The control is the first
 * native input, select or textarea, or the first component (Input, NativeSelect, ChipInput, EntityPicker… pass
 * `id` on to their own input), looking inside plain wrappers (a <span> around an input and a button). A control
 * with an id of its own keeps it. A required field's control says so to screen readers (aria-required), as its label's
 * asterisk does on screen. Returns the children and the id, or no id when there is no control.
 */
function withControlId(children: ReactNode, id: string, describedBy: string | undefined, required?: boolean): [ReactNode, string | undefined] {
  let found: string | undefined;
  const visit = (node: ReactNode): ReactNode => {
    if (found !== undefined || !isValidElement<ControlProps>(node)) return node;
    if (node.type === Fragment || (typeof node.type === 'string' && !LABELABLE.has(node.type))) {
      if (node.props.children == null) return node;
      const inner = Children.map(node.props.children, visit);
      return found === undefined ? node : cloneElement(node, undefined, inner);
    }
    found = node.props.id ?? id;
    const described = [node.props['aria-describedby'], describedBy].filter(Boolean).join(' ') || undefined;
    return cloneElement(node, { id: found, 'aria-describedby': described, ...(required ? { 'aria-required': true } : {}) });
  };
  const out = Children.map(children, visit);
  return found === undefined ? [children, undefined] : [out, found];
}

/**
 * A field with its mono label above and a hint below. The label points at the control (see withControlId), so
 * clicking it focuses the control and never presses a button inside it (a tag's Remove in ChipInput, say).
 * `htmlFor` names the control yourself, for one Field can't find; then tie the hint to it yourself too.
 */
export function Field({ label, children, hint, required, className, htmlFor }: {
  label: string; children: ReactNode; hint?: ReactNode; required?: boolean; className?: string; htmlFor?: string;
}) {
  const auto = useId();
  const hintId = hint ? `${auto}hint` : undefined;
  const [control, id] = htmlFor ? [children, htmlFor] : withControlId(children, `${auto}field`, hintId, required);
  const text = <>{label}{required && <span className="text-live" aria-hidden> *</span>}</>;
  return (
    <div className={cn('grid min-w-0 content-start gap-1.5', className)}>
      {id ? <label htmlFor={id} className={monoLabel}>{text}</label> : <span className={monoLabel}>{text}</span>}
      {control}
      {hint && <span id={hintId} className="text-13 text-ink-3">{hint}</span>}
    </div>
  );
}

/** A section's heading: its title (with the id its section is labelled by), what it's for, and its action. */
export function Heading({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
      <div className="grid min-w-0 flex-1 gap-1">
        <SectionLabel className="m-0"><span id={id}>{title}</span></SectionLabel>
        <p className="m-0 max-w-[720px] text-13 text-ink-2">{children}</p>
      </div>
      {action}
    </div>
  );
}

export function Switch({ checked, onChange, disabled, label, children }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-2 text-13">
      <UISwitch checked={checked} onCheckedChange={(v) => onChange(v)} disabled={disabled} aria-label={label} />
      {children}
    </span>
  );
}

// Multi-value input: type and press Enter or comma to add; Backspace removes the last value. Picking a suggestion
// adds it at once. `id` and `aria-describedby` go to the text input (a Field passes them).
export function ChipInput({ values, onChange, suggestions = [], placeholder, label, invalid, id, 'aria-describedby': describedBy }: {
  values: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string; label: string; invalid?: boolean;
  id?: string; 'aria-describedby'?: string;
}) {
  const [text, setText] = useState('');
  const listId = useId();
  const add = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean).filter((s) => !values.includes(s));
    if (parts.length) onChange([...values, ...parts]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab') {
      if (text.trim()) { e.preventDefault(); add(text); }
    } else if (e.key === 'Backspace' && !text && values.length) {
      onChange(values.slice(0, -1));
    }
  };
  const left = suggestions.filter((s) => !values.includes(s));
  return (
    <div onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement)?.focus()}
      className={cn('flex min-h-8 min-w-0 flex-1 cursor-text flex-wrap items-center gap-1 border bg-background px-1.5 py-[3px] focus-within:border-ink hover:border-ink-3', invalid ? 'border-live' : 'border-rule-2')}>
      {values.map((v) => (
        <span key={v} className="inline-flex items-center border border-rule bg-panel pl-1.5 font-mono text-xs leading-5 text-ink">{v}
          <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}
            className="cursor-default border-0 bg-transparent px-1 text-ink-3 hover:text-ink">×</button>
        </span>
      ))}
      <input id={id} list={left.length ? listId : undefined} aria-label={label} aria-invalid={invalid || undefined} aria-describedby={describedBy}
        value={text} placeholder={values.length ? '' : placeholder}
        className="h-6 min-w-20 flex-1 border-0 bg-transparent px-1 text-13 text-ink outline-none select-text placeholder:text-ink-3 [&::-webkit-calendar-picker-indicator]:hidden"
        onChange={(e) => {
          const v = e.target.value;
          // only a pick from the suggestions adds at once: typing "webapp" must not stop at "web". A pick comes as a
          // replacement (Firefox, Safari) or as a plain event rather than an InputEvent (Chrome)
          const native = e.nativeEvent;
          const typed = typeof InputEvent !== 'undefined' && native instanceof InputEvent && native.inputType !== 'insertReplacementText';
          if (!typed && left.includes(v)) { onChange([...values, v]); setText(''); } else setText(v);
        }}
        onKeyDown={onKey} onBlur={() => text.trim() && add(text)} />
      {left.length > 0 && <datalist id={listId}>{left.map((s) => <option key={s} value={s} />)}</datalist>}
    </div>
  );
}

/* ---------------------------------------------------------------- dialog */

// Dialog: the shared one, with this console's props. Focus goes to [data-autofocus] (or the first field),
// Escape and the backdrop close it, focus returns where it was. The body is the dialog's description, so a screen
// reader reads the question with the title. `wide` only widens it (680px instead of 480px): one layout, so no variant.
export function Modal({ title, children, onClose, footer, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  const body = useRef<HTMLDivElement>(null);
  const bodyId = useId();
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent aria-describedby={bodyId}
        initialFocus={() => body.current?.querySelector<HTMLElement>('[data-autofocus], input, textarea, select') ?? true}
        className={cn('flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0', wide ? 'sm:max-w-[680px]' : 'sm:max-w-[480px]')}>
        <DialogHeader className="px-5 pt-[18px] pr-12 pb-2">
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>
        <div ref={body} id={bodyId} data-slot="dialog-body" className="grid min-h-0 gap-4 overflow-auto px-5 pt-1.5 pb-5">{children}</div>
        {footer && <DialogFooter className="m-0 border-t border-rule px-5 py-3.5">{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}

/** The buttons at the end of a form or dialog, right-aligned. */
export function Actions({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex flex-wrap items-center justify-end gap-2', BAR_CONTROLS, className)}>{children}</div>;
}

/* ---------------------------------------------------------------- time */

/** A time as "2 hours ago", with the exact time on hover. */
export function When({ iso, className }: { iso?: string | null; className?: string }) {
  if (!iso) return <span className={cn('text-ink-3', className)}>—</span>;
  const d = new Date(iso);
  return <time dateTime={iso} title={d.toLocaleString()} className={cn('font-sans text-13 tracking-normal text-ink-2 normal-case', className)}>{agoText(d)}</time>;
}
const agoText = (d: Date) => {
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/* ---------------------------------------------------------------- paging */

const pagerBtn = 'h-7 min-w-7 cursor-default border border-rule bg-transparent px-2 font-mono text-xs text-ink-2 hover:border-rule-2 hover:text-ink disabled:opacity-40 aria-[current=page]:border-ink aria-[current=page]:bg-ink aria-[current=page]:text-background';

// ‹ 1 2 3 … N ›  plus "51–100 of 5,009 flags". `matched` is the count after searching and filters.
export function Pager({ page, size, matched, noun, onPage, className }: { page: number; size: number; matched: number; noun: string; onPage: (p: number) => void; className?: string }) {
  if (matched === 0) return null;
  const pages = Math.max(1, Math.ceil(matched / size));
  const from = page * size + 1;
  const to = Math.min(matched, (page + 1) * size);
  const nums: (number | 'gap')[] = [];
  for (let i = 0; i < pages; i++) {
    if (i === 0 || i === pages - 1 || Math.abs(i - page) <= 2) nums.push(i);
    else if (nums[nums.length - 1] !== 'gap') nums.push('gap');
  }
  return (
    <nav aria-label="Pages" className={cn('flex min-w-0 shrink flex-wrap items-center justify-between gap-3 py-2.5', className)}>
      <span className="font-mono text-11 text-ink-3 uppercase">{from.toLocaleString()}–{to.toLocaleString()} of {matched.toLocaleString()} {noun}</span>
      {pages > 1 && (
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          <button className={pagerBtn} disabled={page === 0} onClick={() => onPage(page - 1)} aria-label="Previous page">‹</button>
          {nums.map((n, i) => n === 'gap' ? <span key={`g${i}`} className="px-1 text-ink-3" aria-hidden>…</span> : (
            <button key={n} className={pagerBtn} aria-current={n === page ? 'page' : undefined} onClick={() => onPage(n)}>{n + 1}</button>
          ))}
          <button className={pagerBtn} disabled={page >= pages - 1} onClick={() => onPage(page + 1)} aria-label="Next page">›</button>
        </span>
      )}
    </nav>
  );
}

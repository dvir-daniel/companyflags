// The setup builder (deploy/builder.mdx): a few questions, then exactly the reader's steps and files, each code block
// with a copy button. It only renders: lib/setup's generate() decides every step.
'use client';

import './setup-builder.css';
import Link from 'next/link';
import { useMemo, useState, type ReactNode } from 'react';
import { DynamicCodeBlock } from 'fumadocs-ui/components/dynamic-codeblock.core';
import { cdnOptions, databaseOptions, generate, WHERE, type Option, type Step } from '@/lib/setup/index.ts';
import { inline } from '@/lib/setup/inline.ts';
import { highlighter, THEMES } from './highlighter';
import { copyLink, useChoices } from './use-choices';

export function SetupBuilder() {
  const { choices: c, update, domainText, typeDomain, domainValid } = useChoices();
  const plan = useMemo(() => generate(c), [c]);
  const [copied, setCopied] = useState(false);
  const cdn = `cdn.${c.domain}`;

  return (
    <div className="cf-sb not-prose">
      <form className="cf-sb-questions" onSubmit={(e) => e.preventDefault()} aria-label="Your setup">
        <Question n={1} title="Where it runs">
          <OptionGroup name="where" options={WHERE} value={c.where} onChange={(where) => update({ where })} />
        </Question>
        <Question n={2} title="Database">
          <OptionGroup name="database" options={databaseOptions(c.where)} value={c.database} onChange={(database) => update({ database })} />
        </Question>
        <Question n={3} title="Address">
          <label className="cf-sb-field">
            <span className="cf-sb-field-label">The console’s host name</span>
            <input
              type="text" inputMode="url" autoComplete="off" spellCheck={false} value={domainText}
              onChange={(e) => typeDomain(e.target.value)} aria-invalid={!domainValid} placeholder="flags.example.com"
            />
            {!domainValid && <span className="cf-sb-field-note">Not a host name yet: the steps use {c.domain}.</span>}
          </label>
          <OptionGroup
            name="cdnHost"
            options={[
              { value: 'same', label: 'No CDN host', hint: `Apps read CDN files from ${c.domain}, if at all` },
              { value: 'cdn', label: 'A CDN host', hint: `Apps read CDN files from ${cdn}` },
            ]}
            value={c.cdnHost ? 'cdn' : 'same'}
            onChange={(v) => update({ cdnHost: v === 'cdn' })}
          />
        </Question>
        <Question n={4} title="Sign-in">
          <OptionGroup
            name="signIn"
            options={[
              { value: 'passwords', label: 'Passwords', hint: 'Email and password, with two-factor' },
              { value: 'sso', label: 'Single sign-on later', hint: 'OIDC or SAML, added in the console' },
            ]}
            value={c.signIn}
            onChange={(signIn) => update({ signIn })}
          />
        </Question>
        <Question n={5} title="CDN">
          <OptionGroup name="cdn" options={cdnOptions(c.where, c.cdnHost)} value={c.cdn} onChange={(v) => update({ cdn: v })} />
        </Question>
        <Question n={6} title="Extras">
          <div className="cf-sb-options" role="group" aria-label="Extras">
            <Toggle label="Metrics" hint="Prometheus at /metrics, with a token" checked={c.metrics} onChange={(metrics) => update({ metrics })} />
            <Toggle label="No MCP" hint="Turn off the MCP server for AI agents" checked={!c.mcp} onChange={(off) => update({ mcp: !off })} />
            <Toggle label="No webhooks" hint="Turn off webhooks in and out" checked={!c.webhooks} onChange={(off) => update({ webhooks: !off })} />
          </div>
        </Question>
      </form>

      <div className="cf-sb-summary" aria-live="polite">
        <div>
          <span className="cf-sb-label">Your setup · {plan.steps.length} steps</span>
          <p>{plan.summary}</p>
        </div>
        <button
          type="button" className="cf-sb-button"
          onClick={async () => { setCopied(await copyLink()); window.setTimeout(() => setCopied(false), 1600); }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>

      <ol className="cf-sb-steps">
        {plan.steps.map((s, i) => <StepView key={`${c.where}-${s.id}`} step={s} n={i + 1} />)}
      </ol>
    </div>
  );
}

function Question({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <fieldset className="cf-sb-question">
      <legend className="cf-sb-label"><span>{String(n).padStart(2, '0')}</span> {title}</legend>
      {children}
    </fieldset>
  );
}

function OptionGroup<T extends string>({ name, options, value, onChange }: { name: string; options: Option<T>[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="cf-sb-options" role="radiogroup">
      {options.map((o) => (
        <label key={o.value} className="cf-sb-option" data-on={o.value === value || undefined}>
          <input type="radio" name={name} value={o.value} checked={o.value === value} onChange={() => onChange(o.value)} />
          <b>{o.label}</b>
          {o.hint && <span>{o.hint}</span>}
        </label>
      ))}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="cf-sb-option cf-sb-toggle" data-on={checked || undefined}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <b>{label}</b>
      <span>{hint}</span>
    </label>
  );
}

function Text({ text }: { text: string }) {
  return (
    <>
      {inline(text).map((t, i) => {
        if (t.kind === 'code') return <code key={i}>{t.text}</code>;
        if (t.kind === 'bold') return <strong key={i}>{t.text}</strong>;
        if (t.kind === 'link') return <Link key={i} href={t.url}>{t.text}</Link>;
        return <span key={i}>{t.text}</span>;
      })}
    </>
  );
}

function StepView({ step, n }: { step: Step; n: number }) {
  return (
    <li className="cf-sb-step" id={`step-${step.id}`}>
      <div className="cf-sb-step-head">
        <span className="cf-sb-num">{String(n).padStart(2, '0')}</span>
        <h3>{step.title}</h3>
      </div>
      <div className="cf-sb-step-body">
        {step.prose.map((p, i) => <p key={i}><Text text={p} /></p>)}
        {step.list && <ul>{step.list.map((l, i) => <li key={i}><Text text={l} /></li>)}</ul>}
        {step.code.map((k, i) => (
          <DynamicCodeBlock key={`${k.filename}-${i}`} highlighter={highlighter} options={THEMES} lang={k.lang} code={k.code} codeblock={{ title: k.filename }} />
        ))}
        {step.after?.map((p, i) => <p key={i} className="cf-sb-after"><Text text={p} /></p>)}
      </div>
    </li>
  );
}

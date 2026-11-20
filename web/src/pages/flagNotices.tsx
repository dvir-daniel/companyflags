import { useEffect, useState } from 'react';
import { Button } from '@companyflags/ui/components/button';
import { NativeSelect } from '@companyflags/ui/components/native-select';
import { cn } from '@companyflags/ui/lib/utils';
import { api, type FlagDetail } from '../api.ts';
import { useApp } from '../app.ts';
import { flagRequestsPath } from '../paths.ts';
import { plural } from '../text.ts';
import { isHidden } from '../lines.ts';
import { ErrorList } from '../ui.tsx';
import { useAsync } from '../uiKit.ts';
import { useEnvs } from './envs.ts';
import { isWaiting, utcText, zonedText, type FlagRequest } from './safetyKit.ts';
import { hasSafeValue, maySetSafeValue } from '../../../server/policy.ts';

/*
 * The flag page's safety notices, under its bar (FlagPage.tsx): an archived flag says so and offers Restore, and a
 * request waiting to change this flag in this environment says that saving here first makes it end as a conflict.
 * SafeValueRow is the flag's Settings row for a kill switch's or ops flag's safe value.
 */

const strip = 'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-grid px-6 py-2 text-13 max-sm:px-4';

export function FlagNotices({ flag, env, onChanged }: { flag: FlagDetail; env: string; onChanged: () => void }) {
  const { toast, ask, revisionTick, reload } = useApp();
  const { envName, isProtected } = useEnvs();
  const [requests, setRequests] = useState<{ flag: string; list: FlagRequest[] } | null>(null);
  useEffect(() => {
    let live = true;
    api<FlagRequest[]>('GET', flagRequestsPath(flag.key)).then((list) => { if (live) setRequests({ flag: flag.key, list }); }, () => {});
    return () => { live = false; };
  }, [flag.key, revisionTick]);
  const where = envName(env).toLowerCase();

  if (flag.archivedAt) {
    const restore = async () => {
      const r = await ask({
        title: `Restore ${flag.key}?`,
        body: <><p>The same flag comes back, with its settings and services in every environment as they were when it was archived. Apps get its values again.</p>
          <p className="text-ink-3">Where an environment needs approval, it comes back off and in no service.</p></>,
        actions: [{ id: 'c', label: 'Cancel' }, { id: 'go', label: 'Restore flag', tone: 'primary' }],
      });
      if (r.action !== 'go') return;
      try {
        await api('POST', `/flags/${flag.key}/unarchive`);
        toast(`Restored ${flag.key}`);
        onChanged();
        reload().catch(() => {});
      } catch (e) { toast(e as Error); }
    };
    return (
      <div role="status" className={cn(strip, 'bg-flag-bg')}>
        <span className="min-w-0 flex-1">This flag is archived: it’s in no service, and apps use the default in their code. Its key stays reserved for it.</span>
        <Button variant="secondary" onClick={restore}>Restore flag</Button>
      </div>
    );
  }

  const waiting = (requests?.flag === flag.key ? requests.list : []).filter((r) => isWaiting(r) && r.environment === env);
  if (!waiting.length) return null;
  const first = waiting.find((r) => r.status === 'scheduled') ?? waiting[0];
  const when = first.status === 'scheduled' && first.scheduledAt
    ? <> scheduled for <span className="font-mono text-ink" title={utcText(first.scheduledAt)}>{zonedText(first.scheduledAt)}</span></>
    : first.status === 'approved' ? ' approved and waiting to go out' : ' waiting for review';
  return (
    <div role="status" className={cn(strip, 'bg-flag-bg text-ink-2')}>
      <span className="min-w-0 flex-1">
        <a href={`#/approvals/${first.id}`}>Request #{first.id}</a> changes this flag in {where},{when}.
        {waiting.length > 1 && ` ${plural(waiting.length - 1, 'more request')} too.`}
        {' '}{isProtected(env) ? 'Saving a change here first makes it end as a conflict.' : 'A change saved here first makes it end as a conflict.'}
      </span>
    </div>
  );
}

/** The safe value of a kill switch or ops flag, in its Settings: what "Serve the safe value" gives everyone. */
export function SafeValueRow({ flag, onSaved }: { flag: FlagDetail; onSaved: () => unknown }) {
  const { meta, toast } = useApp();
  const [picked, setPicked] = useState<{ flag: string; variant: string } | null>(null);
  const { busy, error, run } = useAsync();
  if (!hasSafeValue(flag.kind)) return null;
  const saved = flag.safeVariant ?? '';
  const value = picked?.flag === flag.key ? picked.variant : saved;
  const may = maySetSafeValue(meta.me, meta.environments);
  const variants = flag.variations.filter((v) => !isHidden(v.key));
  const save = async () => {
    const ok = await run(() => api('PUT', `/flags/${flag.key}/safe-variant`, { variant: value || null }));
    if (ok) { setPicked(null); toast(value ? `${flag.key}’s safe value is ${value}` : `${flag.key} has no safe value now`); await onSaved(); }
  };
  return (
    <div className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-6 border-b border-grid py-3 max-sm:grid-cols-1 max-sm:gap-2">
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink">Safe value</div>
        <p className="m-0 text-13 text-ink-2">
          In an emergency, on call can serve it to every device at once, without a review. Without one, they can only stop sending a value.
          {!may && ' Only admins set it while an environment needs approval.'}
        </p>
        <ErrorList error={error} />
      </div>
      <div className="flex min-w-0 items-center gap-2 max-sm:w-full">
        <NativeSelect size="sm" aria-label="Safe value" className="w-[220px] max-sm:w-full" value={value} disabled={!may || busy}
          onChange={(e) => setPicked({ flag: flag.key, variant: e.target.value })}>
          <option value="">None: stop sending only</option>
          {variants.map((v) => <option key={v.key} value={v.key}>{v.key} · {JSON.stringify(v.value)}</option>)}
        </NativeSelect>
        {value !== saved && <Button disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>}
      </div>
    </div>
  );
}

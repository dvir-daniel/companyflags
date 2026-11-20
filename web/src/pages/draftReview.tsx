// Reviewing and publishing the draft: every flag's changes, as sentences, published together as one version
// (or sent as one request where the environment needs review). The draft session (draftSession.ts) decides all of
// it: what changed, whether a flag is stale, the rebase, and the order publishing goes in.
import { useEffect, useMemo, useState } from 'react';
import { StatusMark } from '@companyflags/ui/components/badge';
import { Button } from '@companyflags/ui/components/button';
import { Callout } from '@companyflags/ui/components/callout';
import { Checkbox } from '@companyflags/ui/components/checkbox';
import { BAR_CONTROLS, barTextButton } from '@companyflags/ui/components/page-bar';
import { cn } from '@companyflags/ui/lib/utils';
import { api, entityIndex, entityLabel } from '../api.ts';
import { go, useApp } from '../app.ts';
import { followingText } from '../dimWords.ts';
import { useDraft } from '../useDraft.ts';
import { plural } from '../text.ts';
import { Actions, ErrorList, Field, Modal } from '../ui.tsx';
import { monoLabel, textareaField, useAsync } from '../uiKit.ts';
import { useEnvs } from './envs.ts';
import { approvalsNeeded } from '../../../server/policy.ts';

/**
 * The bar under the page's tabs while a draft exists (Zeigarnik: unfinished work stays in view):
 * how much is waiting and where, with Review and Discard.
 */
export function DraftBar({ env, onReview, className }: { env: string; onReview: () => void; className?: string }) {
  const { toast } = useApp();
  const { envName } = useEnvs();
  const { session, summary: s } = useDraft(env);
  if (!s.flags.length) return null;
  const discardAll = () => {
    const undo = session.discard();
    toast(`Discarded your draft in ${envName(env).toLowerCase()} (${plural(s.changes, 'change')})`, 'ok', { label: 'Undo', onClick: undo });
  };
  return (
    <div role="region" aria-label="Your draft" className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule bg-flag-bg px-6 py-2 max-sm:px-4', BAR_CONTROLS, className)}>
      <span className="flex min-w-0 flex-1 items-center gap-2.5 text-13 text-ink">
        <StatusMark tone="warn" />
        <span className="font-medium">Your draft: {plural(s.changes, 'unpublished change')} in {plural(s.flags.length, 'flag')}</span>
        <span className="truncate text-ink-2 max-md:hidden">{s.flags.map((g) => g.key).join(', ')}</span>
      </span>
      <button type="button" className={barTextButton} onClick={discardAll}>Discard draft</button>
      {/* the page bar's Publish changes (or Request review) is the one primary: this opens the same review */}
      <Button variant="secondary" onClick={onReview}>Review</Button>
    </div>
  );
}

export function ReviewDraft({ env, onClose }: { env: string; onClose: () => void }) {
  const { toast, reload, meta } = useApp();
  const { envName, envOf } = useEnvs();
  const { session, summary: s } = useDraft(env);
  const needsApproval = s.needsReview;
  const approvals = approvalsNeeded(envOf(env));
  const where = envName(env).toLowerCase();
  const [reason, setReason] = useState('');
  const [reshuffle, setReshuffle] = useState(false);
  const { busy, error, setError, run } = useAsync();
  // someone else may have changed a flag in this draft since it began: ask the server now, not only on that flag's page
  useEffect(() => { session.checkStale().catch(() => {}); }, [session]);
  // a % change that moves devices: the server says so by its code, and the confirmation stays once offered
  const [needsReshuffle, setNeedsReshuffle] = useState(false);
  if (error?.code === 'needs_reshuffle' && !needsReshuffle) setNeedsReshuffle(true);
  const incomplete = s.flags.reduce((n, g) => n + g.problems.length, 0);
  // the entities whose own settings change: saving them changes what every entity under them that follows them gets too
  const followers = useFollowers(env, s.flags);
  const publish = async () => {
    const res = await run(() => session.publish({ meta, reason, allowReshuffle: reshuffle }));
    if (!res) return;
    const what = `${plural(res.changes, 'change')} in ${plural(res.flags.length, 'flag')}`;
    if (res.applied) toast(`Published ${what} to ${where} as version ${res.revision}`, 'ok', { label: 'View', onClick: () => go(`flags/${env}/versions`) });
    else toast(`Sent ${what} in ${where} for review (request #${res.changeSetId})`, 'ok', { label: 'View', onClick: () => go(`approvals/${res.changeSetId}`) });
    reload().catch(() => {});
    onClose();
  };
  // "keep my edits on the new version": the sentences below then say what publishing changes in the newest version
  const keepMine = async () => { if (await run(() => session.rebase(s.stale))) setError(null); };
  const dropFlag = (key: string) => {
    const undo = session.discard([key]);
    toast(`Removed ${key} from your draft`, 'ok', { label: 'Undo', onClick: undo });
    if (s.flags.length === 1) onClose();
  };
  return (
    <Modal title={needsApproval ? `Request review in ${where}` : `Publish to ${where}`} wide onClose={onClose}
      footer={<Actions>
        <Button variant="secondary" onClick={onClose}>Keep editing</Button>
        <Button disabled={busy || !s.flags.length || s.stale.length > 0 || incomplete > 0 || (needsApproval && !reason.trim())} onClick={publish}>
          {busy ? (needsApproval ? 'Sending…' : 'Publishing…') : needsApproval ? `Request review of ${plural(s.changes, 'change')}` : `Publish ${plural(s.changes, 'change')}`}
        </Button>
      </Actions>}>
      <p className="m-0 text-13 text-ink-2">
        {needsApproval
          ? `Everything below goes to an approver as one request (${plural(approvals, 'approval')} needed). Nothing changes in ${where} until it’s approved and applied.`
          : `Everything below goes live together as one new version of ${where}. You can roll back to the current version from the Versions tab.`}
      </p>
      {s.stale.length > 0 && (
        <Callout tone="error" role="status">
          Someone changed {s.stale.join(', ')} in {where} since your draft began, so publishing it would be refused.{' '}
          <Button variant="link" disabled={busy} onClick={() => void keepMine()}>Keep my edits on the new version</Button>
        </Callout>
      )}
      {s.flags.map((g) => (
        <section key={g.key} className="grid gap-1">
          <div className="flex items-center gap-2 border-b border-rule pb-1.5">
            <a href={`#/flag/${g.key}/${env}`} onClick={onClose} className="font-mono text-13 font-medium text-ink no-underline hover:underline">{g.key}</a>
            <span className={monoLabel}>{plural(Math.max(g.sentences.length, 1), 'change')}</span>
            {g.problems.length > 0 && <span className="text-13 text-live">{plural(g.problems.length, 'incomplete rule')}: open it to finish</span>}
            <span className="flex-1" />
            <button type="button" className={cn(barTextButton, 'h-7')} onClick={() => dropFlag(g.key)}>Remove from draft</button>
          </div>
          <ul className="m-0 list-none p-0">
            {(g.sentences.length ? g.sentences : ['Settings changed']).map((l, i) => <li key={i} className="border-b border-grid py-1.5 text-13 text-ink [overflow-wrap:anywhere] last:border-b-0">{l}</li>)}
            {g.items.filter((it) => it.entity).map((it) => {
              const n = followers.get(`${g.key}|${it.entity}`);
              const e = entityIndex(meta.entities).get(it.entity!);
              const text = n && e ? followingText(meta.dimensions, e.dimension, n, entityLabel(meta.entities, it.entity!)) : null;
              return text && <li key={`f-${it.entity}`} className="border-b border-grid py-1.5 text-13 text-ink-2 last:border-b-0">{text}</li>;
            })}
          </ul>
        </section>
      ))}
      {!s.flags.length && <Callout>Your draft in {where} is empty.</Callout>}
      <Field label={needsApproval ? 'Why? (the approver sees this)' : 'Note for the version (optional)'}>
        <textarea rows={2} data-autofocus value={reason} placeholder="Move the EU to the new cluster" onChange={(e) => setReason(e.target.value)} className={textareaField} />
      </Field>
      {needsReshuffle && (
        <label className="flex cursor-default items-center gap-2.5 text-13 text-ink-1">
          <Checkbox checked={reshuffle} onCheckedChange={(v) => setReshuffle(!!v)} />
          Reassign which devices are inside the % anyway
        </label>
      )}
      {/* a stale draft is offered the rebase above instead */}
      <ErrorList error={error?.code === 'stale' ? null : error} />
    </Modal>
  );
}

/** For each flag and entity whose own settings the draft changes (above the bottom dimension): how many entities under
 *  it follow its settings on that flag (GET /flags/:key/impact/:env?entity=). "flag|entity" → count. */
function useFollowers(env: string, flags: { key: string; items: { entity: string | null }[] }[]): Map<string, number> {
  const { meta } = useApp();
  const bottom = meta.dimensions[meta.dimensions.length - 1]?.key;
  const asks = useMemo(() => flags.flatMap((g) => g.items.filter((it) => it.entity && entityIndex(meta.entities).get(it.entity)?.dimension !== bottom)
    .map((it) => `${g.key}|${it.entity}`)), [flags, meta.entities, bottom]);
  const id = asks.join(',');
  const [got, setGot] = useState<{ id: string; counts: Map<string, number> } | null>(null);
  useEffect(() => {
    if (!id) return;
    const run = { live: true };
    Promise.all(id.split(',').map((k) => {
      const [flag, entity] = k.split('|');
      return api<{ following?: number }>('GET', `/flags/${encodeURIComponent(flag)}/impact/${encodeURIComponent(env)}?entity=${encodeURIComponent(entity)}`)
        .then((r) => [k, r.following ?? 0] as const, () => [k, 0] as const);
    })).then((rows) => { if (run.live) setGot({ id, counts: new Map(rows) }); });
    return () => { run.live = false; };
  }, [id, env]);
  return got?.id === id ? got.counts : NONE;
}
const NONE = new Map<string, number>();

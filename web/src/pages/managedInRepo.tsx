// "Managed in repo": a line under the flag page's bar when a flags file (flags as code) manages the flag. It names the
// file and the fields it owns, and says that an edit here to one of them is undone by the file's next push.
import { HelpTip } from '@companyflags/ui/components/tooltip';
import { fmtDate } from '../uiKit.ts';
import { ownedWords, useManaged } from './managedKit.ts';

export function ManagedInRepo({ flag }: { flag: string }) {
  const managed = useManaged(flag);
  if (!managed) return null;
  return (
    <div role="note" className="flex flex-wrap items-center gap-x-2 border-b border-grid px-6 py-2 text-13 text-ink-2 max-sm:px-4">
      <span className="font-medium text-ink">Managed in repo{managed.source ? ` (${managed.source})` : ''}.</span>
      <span>Its {ownedWords(managed.fields)} come from the flags file. A change here to those is undone by the next push.</span>
      <HelpTip>Last pushed by {managed.appliedBy} on {fmtDate(managed.appliedAt)}. Change the file in a pull request instead. Rules stay here.</HelpTip>
    </div>
  );
}

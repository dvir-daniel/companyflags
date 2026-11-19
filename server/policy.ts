// Who may change what, and how a change goes through, in one pure module shared with the console (like checks.ts):
// layers.ts enforces it, and the console enables its buttons and words its prompts with it, so a button and the
// server's answer can't disagree.
//
//   needsReview(env), approvalsNeeded(env)   does a change in this environment need review, and how many approvals
//   mayMoveEntities(person, envs)             may this person move an entity under another parent
//   reviewRefusal / mayApprove / mayReview    may this person approve (or reject) this change set, and if not, why
//   scheduleRefusal / maySchedule             may this person set this approved change set to go live later
//   switchPath(person, flag, env, on)         how turning this flag on or off goes through: now, review or break-glass
//   switchPlan(person, flags, env, on, …)     the same for one flag or several at once, and which have a saved draft
//   pathIn(plan, flag)                        how one flag of that plan goes through
//   canBreakGlassRollback(kind, role)         may this person roll a version release back without review
//   ROLES, roleInfo(role)                     the roles: their labels, who changes, who reviews, who may break-glass,
//                                             who changes settings (the server asks through access.ts `may`)
//
// The approval policy is the environment's `min_approvals` (README: not per flag kind or tag). An environment with
// min_approvals above 0 is a protected environment: a change there is a change set, and it applies only after
// that many approvals (at least one), none of them by its author.

// ---------------------------------------------------------------- roles

export const ROLES = ['viewer', 'editor', 'approver', 'oncall', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export type RoleInfo = {
  label: string;
  /** what the role may do, in words: "also reviews changes" */
  does: string;
  /** changes flags and entities (viewers change nothing) */
  changes: boolean;
  /** approves or rejects other people's change sets */
  reviews: boolean;
  /** in a protected environment, without review and with a reason (break-glass): turns a kill switch or ops flag off,
   *  and rolls a version release back to a version it served before */
  breaksGlass: boolean;
  /** changes Settings: environments, apps, people and single sign-on (the admins; there is always one) */
  changesSettings: boolean;
};

const ROLE: Record<Role, RoleInfo> = {
  viewer: { label: 'Viewer', does: 'can look, not change', changes: false, reviews: false, breaksGlass: false, changesSettings: false },
  editor: { label: 'Editor', does: 'changes flags and what each one gets', changes: true, reviews: false, breaksGlass: false, changesSettings: false },
  approver: { label: 'Approver', does: 'also reviews changes', changes: true, reviews: true, breaksGlass: false, changesSettings: false },
  oncall: { label: 'On call', does: 'also turns flags off and rolls versions back in an emergency', changes: true, reviews: true, breaksGlass: true, changesSettings: false },
  admin: { label: 'Admin', does: 'everything, including settings', changes: true, reviews: true, breaksGlass: true, changesSettings: true },
};

export const isRole = (role: unknown): role is Role => (ROLES as readonly unknown[]).includes(role);
/** What a role may do. A role this module doesn't know may do nothing. */
export const roleInfo = (role: string): RoleInfo =>
  (isRole(role) ? ROLE[role] : { label: role, does: '', changes: false, reviews: false, breaksGlass: false, changesSettings: false });

export type Person = { key: string; role: string };

// ---------------------------------------------------------------- environments

export type EnvFacts = { minApprovals: number };

/** A protected environment: a change there needs review before it applies. */
export const needsReview = (env: EnvFacts | null | undefined) => (env?.minApprovals ?? 0) > 0;
/** May move an entity under another parent (or out from under one): that changes what it, and every entity under it, gets in every
 *  environment at once, review or not, so while any environment is protected only those who change settings (the
 *  admins) may. */
export const mayMoveEntities = (person: Pick<Person, 'role'>, envs: readonly (EnvFacts | null | undefined)[]) =>
  roleInfo(person.role).changes && (!envs.some(needsReview) || roleInfo(person.role).changesSettings);
/** How many approvals a change set there needs before it can apply: the environment's number, and always at least one. */
export const approvalsNeeded = (env: EnvFacts | null | undefined) => Math.max(1, env?.minApprovals ?? 0);

// ---------------------------------------------------------------- change sets

/** A review as the change set's page reads it: `current` when it was given for the change set as it is now. */
export type ReviewFacts = { reviewer: string; decision: string; current: boolean };
export type ChangeSetFacts = { author: string; status: string; reviews?: readonly ReviewFacts[] | null };
export type Decision = 'approve' | 'reject';

/** Waiting for approvals, or approved and not yet applied: a change set people can still review. */
export const openForReview = (status: string) => status === 'in_review' || status === 'approved';
/** The approvals that count: those given for the change set as it is now. */
export const approvalsOf = (cs: ChangeSetFacts) => (cs.reviews ?? []).filter((r) => r.decision === 'approve' && r.current).length;
/** How many more approvals it needs in this environment (0: enough). */
export const approvalsLeft = (cs: ChangeSetFacts, env: EnvFacts | null | undefined) => Math.max(0, approvalsNeeded(env) - approvalsOf(cs));

/** Why someone can't give this decision: the change set is no longer open, it is their own, their role doesn't
 *  review, or they already approved it as it is now. */
export type Refusal = { why: 'closed' | 'own' | 'role' | 'done'; message: string };

/** Why this person may not approve (or reject) this change set; null when they may. An approval given for older
 *  content doesn't count, so its reviewer may approve again. */
export function reviewRefusal(person: Person, cs: ChangeSetFacts, decision: Decision = 'approve'): Refusal | null {
  if (!openForReview(cs.status)) return { why: 'closed', message: `this request is ${cs.status.replace('_', ' ')}` };
  if (person.key === cs.author) return { why: 'own', message: `you can’t ${decision} your own request` };
  if (!roleInfo(person.role).reviews) return { why: 'role', message: `role ${person.role} cannot review requests` };
  const approved = (cs.reviews ?? []).some((r) => r.reviewer === person.key && r.decision === 'approve' && r.current);
  if (decision === 'approve' && approved) return { why: 'done', message: 'you already approved this request' };
  return null;
}
export const mayApprove = (person: Person, cs: ChangeSetFacts) => reviewRefusal(person, cs, 'approve') === null;
/** May review it at all: reject it, and approve it unless they already have. */
export const mayReview = (person: Person, cs: ChangeSetFacts) => reviewRefusal(person, cs, 'reject') === null;

const REVIEWING_ROLES = () => ROLES.filter((r) => ROLE[r].reviews).map((r) => ROLE[r].label.toLowerCase()).join(', ');
/** Why this person may not schedule this change set to go live later; null when they may. Only an approved change
 *  set is scheduled, by its author or someone whose role reviews (README). */
export function scheduleRefusal(person: Person, cs: Pick<ChangeSetFacts, 'author' | 'status'>): Refusal | null {
  if (cs.status !== 'approved') return { why: 'closed', message: `only approved requests can be scheduled (this one is ${cs.status.replace('_', ' ')})` };
  if (person.key !== cs.author && !roleInfo(person.role).reviews) {
    return { why: 'role', message: `only the author or a reviewer (${REVIEWING_ROLES()}) can schedule a request` };
  }
  return null;
}
export const maySchedule = (person: Person, cs: Pick<ChangeSetFacts, 'author' | 'status'>) => scheduleRefusal(person, cs) === null;

// ---------------------------------------------------------------- the switch (README M7)

/** The kinds of flag on call may switch off in a protected environment without review. */
export const breakGlassKind = (kind: string) => kind === 'kill_switch' || kind === 'ops';
/** May this role use break-glass on this kind of flag. */
export const canBreakGlass = (kind: string, role: string) => breakGlassKind(kind) && roleInfo(role).breaksGlass;
/** May this role roll a version release back without review in a protected environment (docs/design/release-versions.md):
 *  only the safe direction, every device back on a version it had before. Which changes are rollbacks is release.ts
 *  isRollback for the console, and layers.ts checks the saved layer itself. */
export const canBreakGlassRollback = (kind: string, role: string) => kind === 'release' && roleInfo(role).breaksGlass;

/**
 * `now`: it goes live at once (the environment isn't protected). `review`: it becomes a change set. `break-glass`:
 * it goes live at once with a stated reason that is recorded, as the defaults of the flag switched off and nothing
 * else; a review request stays possible instead.
 */
export type SwitchPath = 'now' | 'review' | 'break-glass';

/** How turning this flag on (`on`) or off, by this person in this environment, goes through. The switch is never
 *  drafted. null: this person changes nothing (a viewer). */
export function switchPath(person: Pick<Person, 'role'>, flag: { kind: string }, env: EnvFacts | null | undefined, on: boolean): SwitchPath | null {
  if (!roleInfo(person.role).changes) return null;
  if (!needsReview(env)) return 'now';
  return !on && canBreakGlass(flag.kind, person.role) ? 'break-glass' : 'review';
}

export type SwitchFlag = { key: string; kind: string; enabled: boolean };
export type SwitchPlan = {
  /** the flags that change, by how each goes through (switchPath) */
  now: string[];
  review: string[];
  breakGlass: string[];
  /** already on (or off): nothing to do */
  unchanged: string[];
  /** this person can't switch them (a viewer) */
  refused: string[];
  /** flags that change and have a saved draft in this environment. The switch is never drafted, and a draft made
   *  against the settings it changes would be refused at publish, so these drafts are discarded first. */
  drafted: string[];
};

/** Turning one flag (the switch on its page) or several (the Flags page's bulk bar) on or off: how each goes
 *  through, and which saved drafts are discarded first. `drafted`: which flags have a saved draft here. */
export function switchPlan(person: Pick<Person, 'role'>, flags: readonly SwitchFlag[], env: EnvFacts | null | undefined, on: boolean,
  drafted: (flag: string) => boolean): SwitchPlan {
  const plan: SwitchPlan = { now: [], review: [], breakGlass: [], unchanged: [], refused: [], drafted: [] };
  for (const f of flags) {
    if (f.enabled === on) { plan.unchanged.push(f.key); continue; }
    const path = switchPath(person, f, env, on);
    if (!path) { plan.refused.push(f.key); continue; }
    (path === 'now' ? plan.now : path === 'review' ? plan.review : plan.breakGlass).push(f.key);
    if (drafted(f.key)) plan.drafted.push(f.key);
  }
  return plan;
}

/** How one flag of the plan goes through; null when it doesn't change or this person can't switch it. */
export const pathIn = (plan: SwitchPlan, key: string): SwitchPath | null =>
  (plan.now.includes(key) ? 'now' : plan.review.includes(key) ? 'review' : plan.breakGlass.includes(key) ? 'break-glass' : null);

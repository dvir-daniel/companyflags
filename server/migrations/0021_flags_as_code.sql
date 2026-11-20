-- Migration 0020: what flags as code last applied to each flag (server/flagsAsCode.ts). Each `flags push` writes one
-- row per flag in the file: the file's name (its "source", if it has one), the fields it owns of the flag, and their
-- values on the server after the push. The next plan compares with it, to say which steps undo a change made outside
-- the file; the console shows "Managed in repo" on these flags.
create table flag_managed (
  flag_id bigint primary key references flag on delete cascade,
  source text,
  fields text[] not null,
  applied jsonb not null,
  applied_at timestamptz not null default now(),
  applied_by text not null
);

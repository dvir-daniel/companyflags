-- Migration 0011: version releases (docs/release-versions-plan.md). A version release's values are versions
-- ("1.0.0" → "1.0.1"), and it stays for good, so it has no remove-by date: only on/off releases and experiments need
-- one. This only drops a requirement: no table, column or data changes. The server's check is the exact one
-- (checks.ts needsRemoveBy: a release of strings is a version release only when every value is a version).
alter table flag drop constraint flag_check;
alter table flag add constraint flag_remove_by_check check (
  kind not in ('release', 'experiment') or remove_by is not null or (kind = 'release' and value_type = 'string'));

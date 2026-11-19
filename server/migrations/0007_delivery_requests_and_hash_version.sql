-- Migration 0007: two review fixes.

-- 1. Sending a flag to an app, or no longer sending it, in an environment that needs approvals is a request like a
--    layer change (layers.ts). A 'delivery' item has no customer; before and proposed are {"projects": [app keys]}.
alter table change_set_item add column kind text not null default 'layer'
  constraint change_set_item_kind_check check (kind in ('layer', 'delivery'));
alter table change_set_item add constraint change_set_item_delivery_base check (kind = 'layer' or customer_id is null);

-- 2. The only bucketing hash is version 1 (hash.ts): any other version breaks every file build. Rules saved with
--    another one would already fail to build, so a database that serves files has none; if one does, stop here
--    and say which, rather than fail on the constraint with less to go on.
do $$
declare n int;
begin
  select count(*) into n from flag_rule where split_hash_version is not null and split_hash_version <> 1;
  if n > 0 then
    raise exception '% rule(s) in flag_rule have split_hash_version other than 1: fix them (set 1, which reshuffles their %% of devices) before upgrading', n;
  end if;
end $$;
alter table flag_rule add constraint flag_rule_hash_version_check check (split_hash_version is null or split_hash_version = 1);

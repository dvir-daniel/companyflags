-- Migration 0012: free values (docs/release-versions-plan.md). A flag either picks its values from a named list (its
-- variants, the default) or takes any value typed into its rules and default ("free values"), each stored as a hidden,
-- content-addressed variant like a value typed in for one customer. Version releases always take free values. An
-- on/off flag has its two values, true and false, so it always uses variants.
alter table flag add column free_values boolean not null default false;
alter table flag add constraint flag_free_values_not_bool check (not free_values or value_type <> 'bool');

-- Migration 0013: dimensions (docs/dimensions-plan.md). An installation defines what it serves config per: its
-- dimensions, one chain from the top down, at most 4 ("region › chain › store"). Each dimension's entries are entities,
-- and each entity follows its parent's settings on a flag until it has its own, up to the top (evaluator.ts entityChain).
--
-- Today's customers become entities of `company` › `brand`: a customer with a company is a brand, every other customer
-- a company. Keys, names, parents and link versions stay as they are, so every app link and key keeps working and every
-- file is the same. A new installation (no customers) starts with no dimensions.

create table dimension (
  id smallint generated always as identity primary key,
  key text not null unique check (key ~ '^[a-z][a-z0-9_]{0,29}$'),   -- a rule attribute: fixed once entities or rules use it
  singular text not null check (length(singular) between 1 and 30),  -- the words people read ("store", "stores")
  plural text not null check (length(plural) between 1 and 30),
  parent_id smallint references dimension on delete restrict,        -- the dimension above (null: the top)
  constraint dimension_one_child unique (parent_id) deferrable initially deferred,
  check (parent_id <> id)
);

-- One chain: a single top, at most 4. Checked when the transaction commits, so a dimension can be added above the top
-- (for a moment there are two) or between two others.
create function dimension_one_chain() returns trigger language plpgsql as $$
begin
  if (select count(*) from dimension) > 4 then raise exception 'at most 4 dimensions'; end if;
  if (select count(*) from dimension where parent_id is null) > 1 then raise exception 'the dimensions form one chain: one top'; end if;
  return null;
end $$;
create constraint trigger dimension_one_chain after insert or update or delete on dimension deferrable initially deferred
  for each row execute function dimension_one_chain();

-- customers become entities
drop trigger customer_one_level on customer;
drop function customer_one_level();
alter table customer rename to entity;
alter table entity rename constraint customer_pkey to entity_pkey;
alter table entity rename constraint customer_key_key to entity_key_key;
alter table entity rename constraint customer_not_own_company to entity_not_own_parent;
alter index customer_parent rename to entity_parent;
alter table entity add column dimension_id smallint references dimension on delete restrict;

insert into dimension (key, singular, plural) select 'company', 'company', 'companies' where exists (select 1 from entity);
insert into dimension (key, singular, plural, parent_id) select 'brand', 'brand', 'brands', id from dimension where key = 'company';
update entity set dimension_id = (select id from dimension where key = case when entity.parent_id is null then 'company' else 'brand' end);
alter table entity alter column dimension_id set not null;
create index entity_dimension on entity (dimension_id, name);

-- An entity's parent is an entity of the dimension right above its own; an entity stays in its dimension.
create function entity_parent_dimension() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and new.dimension_id <> old.dimension_id then
    raise exception 'an entity stays in its dimension';
  end if;
  if new.parent_id is not null and not exists (
      select 1 from entity p join dimension d on d.id = new.dimension_id
      where p.id = new.parent_id and p.dimension_id = d.parent_id) then
    raise exception 'an entity''s parent must be an entity of the dimension right above its own';
  end if;
  return new;
end $$;
create trigger entity_parent_dimension before insert or update of parent_id, dimension_id on entity
  for each row execute function entity_parent_dimension();

-- the columns that name a customer name an entity
alter table flag_layer rename column customer_id to entity_id;
alter table api_key rename column customer_id to entity_id;
alter table change_set_item rename column customer_id to entity_id;
alter table change_history rename column customer to entity;
alter index change_history_by_customer rename to change_history_by_entity;

-- API keys: one entity (`entity`), an entity and every entity under it (`below`), or any (`all`)
do $$
declare c record;
begin
  for c in select conname from pg_constraint where conrelid = 'api_key'::regclass and contype = 'c' loop
    execute format('alter table api_key drop constraint %I', c.conname);
  end loop;
end $$;
update api_key set scope = case scope when 'customer' then 'entity' else 'all' end;
alter table api_key add constraint api_key_scope check (scope in ('entity', 'below', 'all'));
alter table api_key add constraint api_key_scope_entity check ((scope = 'all') = (entity_id is null));

-- Rule attributes: `entity` (the asker itself, any level) always; one per dimension (its key). Live rules move from
-- the customer attributes, which keep exactly their meaning: customer.id was the customer itself (`entity`), and
-- customer.company a brand's company, else the customer itself (the `company` level). A % by either hashes the same
-- key with the same salt. History and change sets in review keep the old names, which fields.ts reads as aliases.
insert into condition_field (name, value_type, comes_from, can_split_by, description)
values ('entity', 'string', 'token', true, 'The one asking, at whatever level: from its app link, or named by a backend within its key''s scope')
on conflict (name) do nothing;
insert into condition_field (name, value_type, comes_from, can_split_by, description)
select key, 'string', 'token', true, 'The asker''s ' || singular || ': from its app link, or named by a backend within its key''s scope'
from dimension on conflict (name) do nothing;

create function entity_rule_conditions(conditions jsonb, has_company boolean) returns jsonb language sql immutable as $$
  select coalesce(jsonb_agg(case
      when c->>'field' = 'customer.id' then jsonb_set(c, '{field}', '"entity"')
      when c->>'field' = 'customer.company' and has_company then jsonb_set(c, '{field}', '"company"')
      else c end order by n), '[]'::jsonb)
  from jsonb_array_elements(conditions) with ordinality as x(c, n)
$$;
update flag_rule set conditions = entity_rule_conditions(conditions, exists (select 1 from dimension where key = 'company'))
where conditions::text like '%"customer.%';
drop function entity_rule_conditions(jsonb, boolean);
update flag_rule set split_by = 'entity' where split_by = 'customer.id';
update flag_rule set split_fallback_by = 'entity' where split_fallback_by = 'customer.id';
update flag_rule set split_by = 'company' where split_by = 'customer.company' and exists (select 1 from dimension where key = 'company');
update flag_rule set split_fallback_by = 'company' where split_fallback_by = 'customer.company' and exists (select 1 from dimension where key = 'company');

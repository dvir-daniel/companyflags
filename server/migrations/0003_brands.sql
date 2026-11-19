-- Migration 0003: brands. A customer can be a brand of a bigger customer, its company. A brand is a full customer
-- (its own settings on every flag, app link, API keys, page) that follows its company's settings until it has its
-- own (evaluator.ts). One level only: a company's brands don't have brands.

alter table customer add column parent_id bigint references customer on delete restrict;
alter table customer add constraint customer_not_own_company check (parent_id <> id);
create index customer_parent on customer (parent_id) where parent_id is not null;

create function customer_one_level() returns trigger language plpgsql as $$
begin
  if new.parent_id is not null and exists (select 1 from customer where id = new.parent_id and parent_id is not null) then
    raise exception 'a brand can''t have brands: its company must be a customer that isn''t a brand itself';
  end if;
  if new.parent_id is not null and exists (select 1 from customer where parent_id = new.id) then
    raise exception 'a customer that has brands can''t become a brand itself';
  end if;
  return new;
end $$;

create trigger customer_one_level before insert or update of parent_id on customer
  for each row execute function customer_one_level();

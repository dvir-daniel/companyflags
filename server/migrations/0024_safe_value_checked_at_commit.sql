-- Migration 0024: a flag's safe value (0020) is checked when the transaction commits, not at each row. A flag and its
-- variants refer to each other through it, so a copy of the database (backup.ts copyDatabase) can insert the flags
-- first and their variants after, in one transaction.
alter table flag drop constraint flag_safe_variation_fk;
alter table flag add constraint flag_safe_variation_fk foreign key (id, safe_variation_id) references flag_variation (flag_id, id)
  deferrable initially immediate;

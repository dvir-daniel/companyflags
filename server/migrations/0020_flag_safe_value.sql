-- Migration 0020: a kill switch's or ops flag's safe value (server/policy.ts hasSafeValue): the variant break-glass
-- serves to everyone in an emergency instead of sending nothing ("Serve the safe value", layers.ts serveSafeValue).
--
-- One of the flag's own variants, or none. Variants are never deleted, so the reference stays good.
alter table flag add column safe_variation_id bigint;
alter table flag add constraint flag_safe_variation_fk foreign key (id, safe_variation_id) references flag_variation (flag_id, id);
